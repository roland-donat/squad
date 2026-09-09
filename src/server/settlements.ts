import type { Feature, Ticket } from "../shared/api";
import { settlingBriefing, settlingInstruction } from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";
import { appendToThread, drainSession, type ThreadLine } from "./threads";

export interface SettlementDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  mcpUrl(): string;
  /** Declared by what is needed of it: what the pass leaves is what follows. */
  validations: { afterSettling(ticket: Ticket): Promise<void> };
}

/**
 * The pass squad runs on a test sheet before it wakes anyone.
 *
 * A sub-session hands over what it believes a person must look at, and it hands
 * over too much: measured on ten sheets of a real run, 40 of the 48 waiting
 * points were free suggestions, and going through two of those sheets by hand
 * left nothing at all for a human. The pass is that hand pass, made squad's own:
 * a session opened for one job, in the ticket's own worktree, which runs what
 * answers a point and hands back only what no command settles.
 *
 * It is not the ticket's sub-session and does not become one: the ticket keeps
 * pointing at the session that built it, the pass writes nothing to the
 * repository, and what it finds broken goes back to the sub-session rather than
 * being corrected here.
 *
 * **The fall-back goes towards the developer.** A pass that fails, that ends
 * without calling the tool, or that squad could not even open leaves the sheet
 * exactly as it was: the developer is woken with everything, which is the
 * behaviour that existed before this pass and the one thing it must never make
 * worse.
 */
export class Settlements {
  private readonly running = new Set<AgentSession>();
  /** The tickets a pass is on, so one is never opened twice over the same sheet. */
  private readonly inFlight = new Set<string>();
  private stopping = false;

  constructor(private readonly dependencies: SettlementDependencies) {}

  /**
   * How many times squad settles the same ticket before handing it over. A
   * sheet answered, corrected and reported again has had squad's word once; a
   * third round is two agents disagreeing, and a person ends that faster than
   * another pass would.
   */
  private static readonly rounds = 2;

  /**
   * Settles the sheet of a reported step, then hands the ticket to whatever
   * follows. Awaited by nobody: a report returns as soon as it is written, and
   * the pass runs behind it like a sub-session does.
   *
   * Whatever happens, the ticket is handed on exactly once: a pass that throws
   * is a pass that said nothing, and a sheet nobody answered is a sheet the
   * developer reads.
   */
  settle(ticket: Ticket, feature: Feature): void {
    const bounded = this.dependencies.store.reportedSteps(ticket.id) <= Settlements.rounds;
    this.start(ticket, feature, bounded);
  }

  /**
   * A pass the developer asked for, on a sheet already waiting on them.
   *
   * Two things separate it from the one that follows a report. It ignores the
   * round bound, which is there to stop squad arguing with itself and has
   * nothing to say when a person is the one asking. And it answers, rather than
   * running behind: what it refuses, it refuses in front of whoever clicked.
   */
  async settleOnDemand(ticketId: string): Promise<Ticket> {
    const { store } = this.dependencies;
    const ticket = store.requireTicket(ticketId);
    const report = ticket.stepReport;
    const waiting = (report?.sheet ?? []).some((point) => point.verdict === "pending");
    if (report === null || report.reviewedAt !== null || !waiting) {
      throw new SquadError(
        "sheet_not_settleable",
        409,
        `ticket "${ticket.title}" has no test sheet waiting to be settled`,
      );
    }
    if (ticket.worktree === null) {
      throw new SquadError(
        "sheet_not_settleable",
        409,
        `ticket "${ticket.title}" has no worktree left: a pass has nowhere to run what it would run`,
      );
    }
    if (this.inFlight.has(ticket.id)) {
      throw new SquadError(
        "sheet_not_settleable",
        409,
        `a pass is already going through the test sheet of "${ticket.title}"`,
      );
    }
    const feature = this.dependencies.store.feature(ticket.featureId);
    if (feature === null) {
      throw new SquadError("feature_not_found", 404, `no feature with id ${ticket.featureId}`);
    }
    this.start(ticket, feature, true);
    return store.requireTicket(ticket.id);
  }

  /**
   * The pass itself, running behind whoever asked for it. Whatever happens the
   * ticket is handed on exactly once: a pass that throws is a pass that said
   * nothing, and a sheet nobody answered is a sheet the developer reads.
   */
  private start(ticket: Ticket, feature: Feature, allowed: boolean): void {
    if (this.inFlight.has(ticket.id)) return;
    this.inFlight.add(ticket.id);
    void (async () => {
      try {
        if (allowed) await this.run(ticket, feature);
      } catch {
        // Nothing to add: the sheet is as the sub-session left it, and the line
        // below wakes whoever has to read it.
      } finally {
        this.inFlight.delete(ticket.id);
      }
      if (this.stopping) return;
      await this.dependencies.validations.afterSettling(this.reread(ticket));
    })();
  }

  /** Ends every pass in flight, so a shutdown does not wait on one. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.running].map((session) => session.stop()));
    this.running.clear();
  }

  private async run(ticket: Ticket, feature: Feature): Promise<void> {
    const report = ticket.stepReport;
    // No sheet to settle, or no worktree to settle it in: there is nothing this
    // pass can do that the developer would not do better.
    if (report === null || ticket.worktree === null) return;
    const { launcher, mcpUrl } = this.dependencies;
    const session = await launcher.open({
      role: "settling",
      featureId: feature.id,
      ticketId: ticket.id,
      workingDirectory: ticket.worktree.path,
      mcpUrl: mcpUrl(),
      briefing: settlingBriefing(feature, ticket),
    });
    this.running.add(session);
    const write = (line: ThreadLine) => this.append(ticket, session.id, line);
    const instruction = settlingInstruction(report);
    write({ kind: "pilot", text: instruction });
    try {
      await session.send(instruction);
    } catch (failure) {
      write({
        kind: "notice",
        text: "squad could not hand the settling session its instruction",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      await session.stop();
    }
    const ending = await drainSession(session, write);
    this.running.delete(session);
    if (this.stopping) return;

    // Re-read rather than trust what was handed in: the pass answered through
    // the tools, so the sheet as it now stands is the whole of what it said.
    const left = (this.reread(ticket).stepReport?.sheet ?? []).filter(
      (point) => point.verdict === "pending",
    );
    write({
      kind: "notice",
      text:
        ending.outcome === "failed"
          ? "the settling session failed; the test sheet reaches the developer untouched"
          : left.length === 0
            ? "the settling session answered every point of the test sheet"
            : `the settling session left ${left.length} point(s) for the developer`,
      detail: ending.detail ?? null,
    });
  }

  /** The ticket as the database now holds it, sheet included. */
  private reread(ticket: Ticket): Ticket {
    try {
      return this.dependencies.store.requireTicket(ticket.id);
    } catch {
      // The ticket went away under the pass, which a shutdown can do: what the
      // caller holds is then the last thing squad knew of it.
      return ticket;
    }
  }

  private append(ticket: Ticket, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(
      store,
      bus,
      { featureId: ticket.featureId, ticketId: ticket.id, sessionId },
      line,
    );
  }
}
