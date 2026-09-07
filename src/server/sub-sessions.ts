import type { AgentSessionOutcome, LaunchAngle, Ticket, TicketState } from "../shared/api";
import { isResumable } from "../shared/graph";
import {
  resumeInstruction,
  stepReportDemand,
  subSessionBriefing,
  ticketAssignment,
} from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { alertTexts, type Alert, type Alerts } from "./alerts";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";
import { appendToThread, drainSession, type ThreadLine } from "./threads";
import type { Worktrees } from "./worktrees";

export interface SubSessionDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  worktrees: Worktrees;
  alerts: Alerts;
  /** Resolved late: squad only knows its own address once it is listening. */
  mcpUrl: () => string;
}

/**
 * Why squad is opening a session on a ticket, which decides both whether an
 * existing session is taken back and what is handed to it first. Declared as
 * one thing rather than worked out from the ticket's state at each call: squad
 * now reopens a session in a state that is not resumable, and reading the state
 * would have opened a blank one without a word.
 */
type Opening =
  | { kind: "assign" }
  | { kind: "resume"; sessionId: string; angle: LaunchAngle }
  | { kind: "remind"; sessionId: string };

/**
 * A ticket can be launched from the frontier, or taken back once its
 * sub-session stopped. Everything else is work in flight, work already done, or
 * a decision, and none of those is launchable.
 */
function isLaunchable(state: TicketState): boolean {
  return state === "ready" || isResumable(state);
}

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
  // Reserved the moment a launch is accepted, and held until its session is in
  // `running`. Opening one takes a checkout and a process, and two requests for
  // the same ticket arriving during that window would both pass the check below
  // and leave one of the two sessions running with nothing pointing at it.
  private readonly starting = new Set<string>();
  // Held so shutdown can wait for them: a drain still writing when the database
  // closes loses the last thing the session had to say, which is exactly the
  // line worth keeping when a session died rather than finished.
  private readonly draining = new Set<Promise<void>>();
  // Tickets squad has already asked once to report a step they ended without
  // reporting. Asking again forever would be a loop, so the second silent ending
  // is read as a failure. In memory on purpose: it is about this run's chain of
  // relaunches, and a restart takes the ticket back from its own state anyway.
  private readonly asked = new Set<string>();
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
    if (this.running.has(ticket.id) || this.starting.has(ticket.id)) {
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
    if (!isLaunchable(ticket.state)) {
      throw new SquadError(
        "ticket_not_launchable",
        409,
        `ticket "${ticket.title}" is ${ticket.state}: a ticket is launched once every ticket blocking it is merged`,
      );
    }
    // A launch the developer asked for starts the count of reminders over: this
    // is a new attempt, not the continuation of one squad already chased.
    this.asked.delete(ticket.id);
    this.starting.add(ticket.id);
    try {
      return await this.open(ticket, this.resumeOrAssign(ticket, angle));
    } finally {
      this.starting.delete(ticket.id);
    }
  }

  /** Taking a stopped session back, or handing the ticket to a blank one. */
  private resumeOrAssign(ticket: Ticket, angle: LaunchAngle): Opening {
    return isResumable(ticket.state) && ticket.sessionId !== null
      ? { kind: "resume", sessionId: ticket.sessionId, angle }
      : { kind: "assign" };
  }

  /**
   * What the store still believes is running, moved to `interrupted`. A process
   * cannot outlive the server that launched it, so such a row is a step whose
   * process disappeared. Called once, before squad listens, so that no client is
   * ever handed a state squad already knows to be false.
   */
  markInterrupted(): Ticket[] {
    const stranded = this.dependencies.store.interruptRunningSteps();
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
        this.starting.add(ticket.id);
        try {
          await this.open(ticket, {
            kind: "resume",
            sessionId: ticket.sessionId,
            angle: "implement",
          });
        } catch (failure) {
          // Left interrupted, which is the truth: nothing is running, and the
          // work is still on its branch. Reading it as a fresh failure would
          // suggest an attempt that was made and lost.
          this.append(ticket, ticket.sessionId, {
            kind: "notice",
            text: "squad could not take the sub-session back",
            detail: failure instanceof Error ? failure.message : String(failure),
          });
          this.dependencies.alerts.raise(alertTexts.subSessionNotTakenBack(ticket.title));
        } finally {
          this.starting.delete(ticket.id);
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

  private async open(ticket: Ticket, opening: Opening): Promise<AgentSession> {
    const { store, launcher, worktrees, mcpUrl } = this.dependencies;
    const feature = store.requireFeature(ticket.featureId);
    // Before the session, since it is the session's working directory. A ticket
    // whose worktree was cleaned off the disk gets it back here, on the branch
    // that still holds its work.
    const worktree = await worktrees.forTicket(ticket);
    const resumeSessionId = opening.kind === "assign" ? undefined : opening.sessionId;

    const session = await launcher.open({
      role: "sub",
      featureId: feature.id,
      ticketId: ticket.id,
      workingDirectory: worktree.path,
      mcpUrl: mcpUrl(),
      briefing: subSessionBriefing(feature, ticket),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    });
    this.running.set(ticket.id, session);
    store.startStep(ticket.id, session.id);
    this.publishGraph(ticket.featureId);

    // Drained before the first message goes in, so nothing the session says on
    // its way up can be emitted into an audience that is not listening yet.
    const drained = this.drain(ticket, session);
    this.draining.add(drained);
    void drained.then(() => this.draining.delete(drained));

    const message = firstMessage(ticket, opening);
    // Written on the thread before it is handed over, so what the session was
    // asked for is on the record even if it dies reading it.
    this.append(ticket, session.id, { kind: "pilot", text: message });
    await session.send(message);
    return session;
  }

  private async drain(ticket: Ticket, session: AgentSession): Promise<void> {
    const ending = await drainSession(session, (line) => this.append(ticket, session.id, line));
    this.running.delete(ticket.id);
    await this.recordEnd(ticket, session.id, ending.outcome, ending.detail);
  }

  /**
   * What a stopped sub-session leaves on the ticket. Squad shutting down writes
   * nothing to the row on purpose: the ticket stays `running`, which is exactly
   * what the next start reads to know a process disappeared under it.
   *
   * A session that stops having said nothing is the case ADR 0002 warns about:
   * the contract holds only if the report tool is actually called, so squad asks
   * again rather than reading a quiet ending as a ticket that is done.
   */
  private async recordEnd(
    ticket: Ticket,
    sessionId: string,
    outcome: AgentSessionOutcome,
    detail: string | undefined,
  ): Promise<void> {
    const { store } = this.dependencies;
    if (this.stopping) {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session was stopped",
        detail: "squad is shutting down; this ticket is taken back at the next start",
      });
      return;
    }
    if (outcome === "failed") {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session failed",
        detail: detail ?? null,
      });
      this.stop(ticket, alertTexts.subSessionStopped(ticket.title));
      return;
    }

    // Read back rather than trusted: the report arrived through the MCP tools
    // while this session was running, so the ticket squad holds is out of date.
    const current = store.requireTicket(ticket.id);
    if (current.state === "awaiting-validation") {
      this.asked.delete(ticket.id);
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session ended after reporting its step",
        detail: "its test sheet is waiting; squad reopens this session to correct what fails",
      });
      return;
    }
    if (this.asked.has(ticket.id)) {
      // Asked once and quiet again: carrying on would be a loop, and a ticket
      // nobody can get a report out of is one the developer has to look at.
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session ended a second time without reporting its step",
        detail: detail ?? "squad asked once already; it stops here rather than asking forever",
      });
      this.stop(ticket, alertTexts.subSessionSilent(ticket.title));
      return;
    }

    this.asked.add(ticket.id);
    this.append(ticket, sessionId, {
      kind: "notice",
      text: "the sub-session ended without reporting its step",
      detail: "squad is asking it again rather than concluding the ticket is done",
    });
    await this.askAgain(current, sessionId);
  }

  /**
   * Takes a session that went quiet back, on its own id, and asks it for the
   * report it owes. The ticket stays `running` throughout: nothing failed, the
   * work is where it was, and squad is simply still waiting for its end.
   */
  private async askAgain(ticket: Ticket, sessionId: string): Promise<void> {
    if (this.stopping) return;
    this.starting.add(ticket.id);
    try {
      await this.open(ticket, { kind: "remind", sessionId });
    } catch (failure) {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "squad could not ask the sub-session for its step report",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      this.stop(ticket, alertTexts.subSessionStopped(ticket.title));
    } finally {
      this.starting.delete(ticket.id);
    }
  }

  /** Marks a ticket stopped, tells whoever is watching, and alerts. */
  private stop(ticket: Ticket, alert: Alert): void {
    this.dependencies.store.failStep(ticket.id);
    this.publishGraph(ticket.featureId);
    this.dependencies.alerts.raise(alert);
  }

  private append(ticket: Ticket, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(store, bus, { featureId: ticket.featureId, ticketId: ticket.id, sessionId }, line);
  }

  private publishGraph(featureId: string): void {
    const { store, bus } = this.dependencies;
    bus.publish({ type: "graph-changed", graph: store.featureGraph(featureId) });
  }
}

/** The first thing squad hands a session it has just opened. */
function firstMessage(ticket: Ticket, opening: Opening): string {
  switch (opening.kind) {
    case "assign":
      return ticketAssignment(ticket);
    case "resume":
      return resumeInstruction(opening.angle, whyResumed(ticket.state));
    case "remind":
      return stepReportDemand(ticket);
  }
}

/** Why squad is taking a session back, said in the message that resumes it. */
function whyResumed(state: TicketState): string {
  return state === "interrupted"
    ? "the server restarted while you were working."
    : "the previous attempt stopped without finishing.";
}
