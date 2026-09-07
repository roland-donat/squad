import type { AgentSessionOutcome, LaunchAngle, Ticket, TicketState } from "../shared/api";
import {
  resumeInstruction,
  subSessionBriefing,
  ticketAssignment,
} from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";
import { appendToThread, lineOf, type ThreadLine } from "./threads";
import type { Workspaces } from "./workspaces";

export interface SubSessionDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  workspaces: Workspaces;
  /** Resolved late: squad only knows its own address once it is listening. */
  mcpUrl: () => string;
}

/**
 * The states a ticket can be launched from. `ready` is a first launch, the other
 * two are a sub-session squad is taking back. Everything else is either work in
 * flight, work already done, or a decision, and none of those is launchable.
 */
const launchableStates: readonly TicketState[] = ["ready", "failed", "interrupted"];

/**
 * The sub-sessions of a feature: one per ticket being built, each blank, each in
 * a worktree of its own. Squad decides what runs and when; a sub-session only
 * ever sees its own ticket and its own branch.
 *
 * A sub-session that stops leaves everything behind on purpose. Its branch, its
 * worktree and its session id stay written on the ticket, because that is what a
 * resume starts from: a relaunch takes the same session back rather than opening
 * a blank one, so an attempt that failed after an hour of work does not cost
 * that hour twice.
 */
export class SubSessions {
  private readonly running = new Map<string, AgentSession>();
  // Held so shutdown can wait for them: a drain still writing when the database
  // closes loses the last thing the session had to say, which is exactly the
  // line worth keeping when a session died rather than finished.
  private readonly draining = new Set<Promise<void>>();
  private reconciliation: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(private readonly dependencies: SubSessionDependencies) {}

  /**
   * Launches a ticket, or takes its stopped sub-session back. The angle only
   * means something in the second case: a first launch is handed the ticket and
   * has nothing to resume from.
   */
  async launch(ticketId: string, angle: LaunchAngle): Promise<AgentSession> {
    const ticket = this.dependencies.store.requireTicket(ticketId);
    if (this.running.has(ticket.id)) {
      throw new SquadError(
        "sub_session_already_running",
        409,
        `the sub-session of ticket "${ticket.title}" is already running`,
      );
    }
    if (ticket.kind === "decision") {
      throw new SquadError(
        "ticket_not_launchable",
        409,
        `ticket "${ticket.title}" is a decision: it is settled in the main session and never implemented`,
      );
    }
    if (!launchableStates.includes(ticket.state)) {
      throw new SquadError(
        "ticket_not_launchable",
        409,
        `ticket "${ticket.title}" is ${ticket.state}: a ticket is launched once every ticket blocking it is merged`,
      );
    }
    return this.open(ticket, angle);
  }

  /**
   * What the store still believes is running, moved to `interrupted`. A process
   * cannot outlive the server that launched it, so a row left saying `running`
   * is a run whose process disappeared. Called once, before squad listens, so
   * that no client is ever handed a state squad knows to be false.
   */
  markInterrupted(): Ticket[] {
    const stranded = this.dependencies.store.interruptRunningTickets();
    for (const ticket of stranded) {
      // On the thread as well as on the node: a developer coming back to a
      // half-written thread has to be able to tell a session that was cut off
      // from one that chose to stop.
      if (ticket.sessionId !== null) {
        this.append(ticket, ticket.sessionId, {
          kind: "notice",
          text: "the sub-session was interrupted",
          detail: "squad stopped while this sub-session was running",
        });
      }
      this.publishGraph(ticket.featureId);
    }
    return stranded;
  }

  /**
   * Takes the interrupted sub-sessions back, each on the session id it was
   * running under, so a restart costs the turn that was in flight and nothing
   * more. Started once squad is listening, and never awaited by the startup
   * path: opening a session is slow, and the interface has to be up before it.
   */
  takeBack(stranded: readonly Ticket[]): void {
    if (stranded.length === 0) return;
    this.reconciliation = (async () => {
      for (const stopped of stranded) {
        if (this.stopping) return;
        const ticket = this.dependencies.store.requireTicket(stopped.id);
        if (ticket.state !== "interrupted" || ticket.sessionId === null) continue;
        try {
          await this.open(ticket, "implement");
        } catch (failure) {
          // Left interrupted, which is the truth: nothing is running, and the
          // work is still on its branch. Reading it as a fresh failure would
          // suggest an attempt that was made and lost.
          this.append(ticket, ticket.sessionId, {
            kind: "notice",
            text: "squad could not take the sub-session back",
            detail: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }
    })();
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    // Awaited first: a resume still opening would otherwise register its session
    // after this method has already stopped everything it could see.
    await this.reconciliation;
    await Promise.all([...this.running.values()].map((session) => session.stop()));
    await Promise.all([...this.draining]);
  }

  private async open(ticket: Ticket, angle: LaunchAngle): Promise<AgentSession> {
    const { store, launcher, workspaces, mcpUrl } = this.dependencies;
    const feature = store.requireFeature(ticket.featureId);
    // Before the session, since it is the session's working directory. A ticket
    // whose worktree was cleaned off the disk gets it back here, on the branch
    // that still holds its work.
    const workspace = await workspaces.forTicket(ticket);
    const resuming = ticket.state === "failed" || ticket.state === "interrupted";
    const resumeSessionId = resuming ? (ticket.sessionId ?? undefined) : undefined;

    const session = await launcher.open({
      role: "sub",
      featureId: feature.id,
      ticketId: ticket.id,
      workingDirectory: workspace.path,
      mcpUrl: mcpUrl(),
      briefing: subSessionBriefing(feature, ticket),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    });
    this.running.set(ticket.id, session);
    this.publishTicket(store.startTicketRun(ticket.id, session.id));

    // Drained before the first message goes in, so nothing the session says on
    // its way up can be emitted into an audience that is not listening yet.
    const drained = this.drain(ticket, session);
    this.draining.add(drained);
    void drained.then(() => this.draining.delete(drained));

    const message =
      resumeSessionId === undefined
        ? ticketAssignment(ticket)
        : resumeInstruction(angle, whyResumed(ticket.state));
    // Written on the thread before it is handed over, so what the session was
    // asked for is on the record even if it dies reading it.
    this.append(ticket, session.id, { kind: "pilot", text: message });
    await session.send(message);
    return session;
  }

  private async drain(ticket: Ticket, session: AgentSession): Promise<void> {
    let outcome: AgentSessionOutcome = "completed";
    let detail: string | undefined;
    try {
      for await (const event of session.events()) {
        if (event.type === "ended") {
          outcome = event.outcome;
          detail = event.detail;
          continue;
        }
        this.append(ticket, session.id, lineOf(event));
      }
    } catch (failure) {
      outcome = "failed";
      detail = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.running.delete(ticket.id);
      this.recordEnd(ticket, session.id, outcome, detail);
    }
  }

  /**
   * What a stopped sub-session leaves on the ticket. Squad shutting down writes
   * nothing to the row on purpose: the ticket stays `running`, which is exactly
   * what the next start reads to know a process disappeared under it.
   */
  private recordEnd(
    ticket: Ticket,
    sessionId: string,
    outcome: AgentSessionOutcome,
    detail: string | undefined,
  ): void {
    if (this.stopping) {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session was stopped",
        detail: "squad is shutting down; this ticket is taken back at the next start",
      });
      return;
    }
    this.append(ticket, sessionId, {
      kind: "notice",
      ...(outcome === "failed"
        ? { text: "the sub-session failed", detail: detail ?? null }
        : {
            // A session that ends without saying what it did is not a ticket
            // that is done: squad asks again rather than concluding for it.
            // Reporting the end of a step is what will give this another exit.
            text: "the sub-session ended without reporting its step",
            detail: detail ?? null,
          }),
    });
    this.publishTicket(this.dependencies.store.failTicketRun(ticket.id));
  }

  private append(ticket: Ticket, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(store, bus, { featureId: ticket.featureId, ticketId: ticket.id, sessionId }, line);
  }

  private publishTicket(ticket: Ticket): void {
    this.publishGraph(ticket.featureId);
  }

  private publishGraph(featureId: string): void {
    const { store, bus } = this.dependencies;
    bus.publish({ type: "graph-changed", graph: store.featureGraph(featureId) });
  }
}

/** Why squad is taking a session back, said in the message that resumes it. */
function whyResumed(state: TicketState): string {
  return state === "interrupted"
    ? "the server restarted while you were working."
    : "the previous attempt stopped without finishing.";
}
