import type { AgentSessionOutcome, LaunchAngle, Ticket, TicketState } from "../shared/api";
import { isResumable, type TicketLifecycle } from "../shared/graph";
import { failedPoints } from "../shared/validation";
import {
  correctionInstruction,
  resumeInstruction,
  stepReportDemand,
  subSessionBriefing,
  ticketAssignment,
} from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { alertFor, type Alert, type Alerts } from "./alerts";
import { SquadError } from "./errors";
import { publishGraph, type EventBus } from "./events";
import type { Launch } from "./scheduler";
import type { Store } from "./store";
import { appendToThread, drainSession, type ThreadLine } from "./threads";
import type { Worktrees } from "./worktrees";

export interface SubSessionDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  worktrees: Worktrees;
  alerts: Alerts;
  /**
   * What a session was waiting on, declared by what is needed of it: a session
   * that has ended cannot read an answer, so its question is let go of rather
   * than left in front of the developer.
   */
  questions: { abandonFor(sessionId: string): void };
  /**
   * What go-as-recommended does with a ticket that stopped, declared by what is
   * needed of it: a run nobody is watching must not carry on launching onto a
   * feature somebody has to look at.
   */
  autonomy: { ticketStopped(ticket: Ticket): void };
  /**
   * What opens a session when the caps allow it, declared by what is needed of
   * it. Sub-sessions no longer hold the loop: three kinds of session share one
   * count, so one place asks the scheduler and hands the places out (ADR 0007).
   */
  dispatch: { schedule(): void; isOpening(launch: Launch): boolean };
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
  | { kind: "resume"; sessionId: string; angle: LaunchAngle; after: TicketLifecycle }
  | { kind: "correct"; sessionId: string }
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
  // The sub-sessions being opened right now, held from the moment a scheduling
  // hands one out until its session is recorded as running. Opening one takes a
  // checkout and a process, and every scheduling during that window would hand
  // the same ticket out again without this. Held as promises so a shutdown can
  // wait for what is half open rather than leave a process behind it.
  // Held so shutdown can wait for them: a drain still writing when the database
  // closes loses the last thing the session had to say, which is exactly the
  // line worth keeping when a session died rather than finished. Keyed by
  // ticket, because closing one session means waiting for that one's last line
  // and no other's.
  private readonly drains = new Map<string, Promise<void>>();
  // Sub-sessions squad is ending itself, because their step was validated and
  // their branch is about to be merged. Their ending is not a failure and not a
  // silence to chase: it is squad having no more use for them.
  private readonly closing = new Set<string>();
  // Tickets squad has already asked once to report a step they ended without
  // reporting. Asking again forever would be a loop, so the second silent ending
  // is read as a failure. In memory on purpose: it is about this run's chain of
  // relaunches, and a restart takes the ticket back from its own state anyway.
  private readonly asked = new Set<string>();
  private stopping = false;

  constructor(private readonly dependencies: SubSessionDependencies) {}

  /**
   * Records a launch, and lets the scheduler decide when it opens. Accepted is
   * not started: the caps may well be full, and a launch that waits is held
   * rather than refused, because a refusal would put the developer in charge of
   * coming back to click again. The angle travels with the request, since the
   * place it waits for may only free after a restart.
   *
   * Nothing here awaits: the whole of the answer is written before the request
   * returns, so two clicks arriving together cannot both find the ticket free.
   */
  launch(ticketId: string, angle: LaunchAngle): Ticket {
    const { store } = this.dependencies;
    const ticket = store.requireTicket(ticketId);
    if (
      this.running.has(ticket.id) ||
      this.dependencies.dispatch.isOpening({ ticketId: ticket.id, job: "sub-session" })
    ) {
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
    if (ticket.state === "queued") {
      throw new SquadError(
        "launch_already_requested",
        409,
        `the launch of ticket "${ticket.title}" is already waiting for a place under the concurrency caps`,
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
    const queued = store.queueLaunch(ticket.id, angle);
    this.publishGraph(ticket.featureId);
    this.dependencies.dispatch.schedule();
    return queued;
  }

  /** Opens the sub-session of a launch the scheduler has just handed out. */
  async startQueued(ticketId: string): Promise<void> {
    const { store } = this.dependencies;
    const request = store.queuedLaunch(ticketId);
    // Nothing waiting any more: a scheduling that crossed a change of state.
    if (request === null) return;
    const ticket = store.requireTicket(ticketId);
    try {
      await this.open(ticket, this.resumeOrAssign(ticket, request));
    } catch (failure) {
      this.abandon(ticket, request.lifecycle, failure);
    }
  }

  /**
   * Taking a stopped session back, or handing the ticket to a blank one. Read
   * from what squad recorded of the ticket's runs rather than from the state it
   * shows: a ticket waiting for a place reads as `queued`, whatever it did
   * before, and reading that would open a blank session over an hour of work.
   */
  private resumeOrAssign(
    ticket: Ticket,
    request: { angle: LaunchAngle; lifecycle: TicketLifecycle },
  ): Opening {
    if (ticket.sessionId === null) return { kind: "assign" };
    // A sheet holding points the developer left unchecked is a correction owed,
    // whatever else happened to the ticket since. Read here rather than written
    // on the launch: the sheet is where that fact lives, and a second place to
    // write it down is a second place for it to be wrong.
    if (request.angle === "implement" && failedPoints(ticket.stepReport).length > 0) {
      return { kind: "correct", sessionId: ticket.sessionId };
    }
    return {
      kind: "resume",
      sessionId: ticket.sessionId,
      angle: request.angle,
      after: request.lifecycle,
    };
  }

  /**
   * Drops a launch that could not be opened at all, and says so. Nothing else
   * is written: no session was opened, so what squad recorded of this ticket's
   * runs is still the truth, and reading the failure as a fresh one would
   * suggest an attempt was made and lost.
   */
  private abandon(ticket: Ticket, lifecycle: TicketLifecycle, failure: unknown): void {
    const { store, alerts } = this.dependencies;
    store.dropQueuedLaunch(ticket.id);
    this.publishGraph(ticket.featureId);
    const detail = failure instanceof Error ? failure.message : String(failure);
    const takingBack = isResumable(lifecycle);
    if (ticket.sessionId === null) {
      // A ticket that never ran has no thread to carry this, so the alert is
      // the whole of what says it, and the log is what says why.
      console.error(`no sub-session could be opened for ticket ${ticket.id}: ${detail}`);
    } else {
      this.append(ticket, ticket.sessionId, {
        kind: "notice",
        text: takingBack
          ? "squad could not take the sub-session back"
          : "squad could not open the sub-session",
        detail,
      });
    }
    alerts.raise(
      takingBack
        ? alertFor.subSessionNotTakenBack(ticket)
        : alertFor.subSessionNotOpened(ticket),
    );
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
   * Asks for every interrupted sub-session to be taken back, each on the session
   * id it was running under, so a restart costs the turn that was in flight and
   * nothing more. They queue like any other launch rather than opening all at
   * once: a machine that was over its caps when it stopped must not come back
   * up over them, and a restart is exactly when that is likely.
   */
  takeBack(stranded: readonly Ticket[]): void {
    const { store } = this.dependencies;
    for (const stopped of stranded) {
      const ticket = store.requireTicket(stopped.id);
      if (ticket.state !== "interrupted" || ticket.sessionId === null) continue;
      store.queueLaunch(ticket.id, "implement");
      this.publishGraph(ticket.featureId);
    }
    // Always, even with nothing stranded: a launch squad accepted before it
    // stopped is still owed, and a machine killed between accepting one and
    // opening it comes back up with a row nothing else would ever look at.
    this.dependencies.dispatch.schedule();
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.running.values()].map((session) => session.stop()));
    await Promise.all([...this.drains.values()]);
  }

  /**
   * Ends the sub-session of a ticket whose step was validated, and waits for its
   * last line to be written. Waited for rather than asked and forgotten: what
   * comes next removes the worktree this session is working in, and a process
   * still writing there would have the ground pulled from under it.
   *
   * A session that already ended by itself is the ordinary case, and there is
   * nothing to do about it: a sub-session reports its step and stays available
   * only until something ends it, and squad ending it is what validation means.
   */
  async close(ticketId: string): Promise<void> {
    const session = this.running.get(ticketId);
    if (session === undefined) return;
    this.closing.add(ticketId);
    const drained = this.drains.get(ticketId);
    await session.stop();
    await drained;
    this.closing.delete(ticketId);
  }

  /**
   * Hands a rejected test sheet back to the sub-session that reported it. The
   * session is normally still there, since a sub-session stays available after
   * reporting for exactly this; when it is not, the correction queues like any
   * other launch and takes that same session back when a place frees up.
   *
   * Either way the ticket goes back to being a step in progress, which is what
   * lets it report its end again: a step ends one way in squad, and a correction
   * is a step.
   */
  async correct(ticket: Ticket): Promise<void> {
    const { store } = this.dependencies;
    const report = ticket.stepReport;
    if (report === null) return;
    const session = this.running.get(ticket.id);
    if (session === undefined) {
      // The angle the developer may ask for, and the only one squad asks for
      // itself: what makes this opening a correction is the sheet on the
      // ticket, which the opening reads for itself.
      store.queueLaunch(ticket.id, "implement");
      this.publishGraph(ticket.featureId);
      this.dependencies.dispatch.schedule();
      return;
    }

    const message = correctionInstruction(ticket, report);
    this.publishGraph(store.reopenStep(ticket.id).featureId);
    this.append(ticket, session.id, { kind: "pilot", text: message });
    try {
      await session.send(message);
    } catch (failure) {
      // The session is open and its place is taken: a correction that could not
      // be handed over is this session's ending, not a correction that never
      // happened. Stopping it lets the drain record that ending, and the
      // developer takes the ticket back from where it stops.
      this.append(ticket, session.id, {
        kind: "notice",
        text: "squad could not hand the sub-session what it is to correct",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      await session.stop();
    }
  }

  /** Holds a drain so a close and a shutdown can both wait for it. */
  private hold(ticketId: string, drained: Promise<void>): void {
    this.drains.set(ticketId, drained);
    void drained.then(() => {
      if (this.drains.get(ticketId) === drained) this.drains.delete(ticketId);
    });
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
      briefing: subSessionBriefing(feature, ticket, store.requireProject(ticket.projectId)),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    });
    this.running.set(ticket.id, session);
    store.startStep(ticket.id, session.id);
    this.publishGraph(ticket.featureId);

    // Drained before the first message goes in, so nothing the session says on
    // its way up can be emitted into an audience that is not listening yet.
    this.hold(ticket.id, this.drain(ticket, session));

    const message = firstMessage(ticket, opening);
    // Written on the thread before it is handed over, so what the session was
    // asked for is on the record even if it dies reading it.
    this.append(ticket, session.id, { kind: "pilot", text: message });
    try {
      await session.send(message);
    } catch (failure) {
      // The session is open and its place is taken: a message that could not be
      // handed over is this session's ending, not a launch that never happened.
      // Stopping it lets the drain started above record that ending like any
      // other, and keeps `abandon` meaning what it says.
      this.append(ticket, session.id, {
        kind: "notice",
        text: "squad could not hand the sub-session what it is to work on",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      await session.stop();
    }
    return session;
  }

  private async drain(ticket: Ticket, session: AgentSession): Promise<void> {
    const ending = await drainSession(session, (line) => this.append(ticket, session.id, line));
    this.running.delete(ticket.id);
    // Before anything else is recorded: a question this session was blocked on
    // has nobody left to hear its answer, whatever the ending was.
    this.dependencies.questions.abandonFor(session.id);
    await this.recordEnd(ticket, session.id, ending.outcome, ending.detail);
    // Whatever the ending was, the place this session held may be free again,
    // and the launch that has waited longest for it goes now.
    this.dependencies.dispatch.schedule();
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
    if (this.closing.has(ticket.id)) {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "the sub-session was closed",
        detail: "its step was validated: squad is merging its branch",
      });
      return;
    }
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
      this.stop(ticket, alertFor.subSessionStopped(ticket));
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
        detail: "its test sheet is waiting for the developer to go through it",
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
      this.stop(ticket, alertFor.subSessionSilent(ticket));
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
    // Not held as an opening: the ticket is still `running`, so it already
    // holds its place, and nothing else can be launched onto it either.
    try {
      await this.open(ticket, { kind: "remind", sessionId });
    } catch (failure) {
      this.append(ticket, sessionId, {
        kind: "notice",
        text: "squad could not ask the sub-session for its step report",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      this.stop(ticket, alertFor.subSessionStopped(ticket));
    }
  }

  /** Marks a ticket stopped, tells whoever is watching, and alerts. */
  private stop(ticket: Ticket, alert: Alert): void {
    const stopped = this.dependencies.store.failStep(ticket.id);
    this.publishGraph(ticket.featureId);
    this.dependencies.alerts.raise(alert);
    // After the alert, since this raises one of its own: the developer is told
    // what stopped, and then that the night stopped with it.
    this.dependencies.autonomy.ticketStopped(stopped);
  }

  private append(ticket: Ticket, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(store, bus, { featureId: ticket.featureId, ticketId: ticket.id, sessionId }, line);
  }

  private publishGraph(featureId: string): void {
    publishGraph(this.dependencies.store, this.dependencies.bus, featureId);
  }
}

/** The first thing squad hands a session it has just opened. */
function firstMessage(ticket: Ticket, opening: Opening): string {
  switch (opening.kind) {
    case "assign":
      return ticketAssignment(ticket);
    case "resume":
      return resumeInstruction(opening.angle, whyResumed(opening.after));
    case "correct":
      // Reached only with a report on the ticket: what makes an opening a
      // correction is that report holding points left unchecked.
      return ticket.stepReport === null
        ? stepReportDemand(ticket)
        : correctionInstruction(ticket, ticket.stepReport);
    case "remind":
      return stepReportDemand(ticket);
  }
}

/** Why squad is taking a session back, said in the message that resumes it. */
function whyResumed(lifecycle: TicketLifecycle): string {
  if (lifecycle === "interrupted") return "the server restarted while you were working.";
  if (lifecycle === "conflict") {
    return "merging your branch into the feature branch conflicted, and the resolution session did not settle it.";
  }
  return "the previous attempt stopped without finishing.";
}
