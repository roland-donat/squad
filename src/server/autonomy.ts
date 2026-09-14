import type {
  AutonomyHaltReason,
  Feature,
  FeatureGraph,
  Question,
  TestSheetPoint,
  Ticket,
} from "../shared/api";
import { frontier } from "../shared/graph";
import { alertFor, type Alerts } from "./alerts";
import { publishGraph, type EventBus } from "./events";
import type { Store } from "./store";

/**
 * Go-as-recommended: the mode where a feature moves without its developer. It
 * launches what the frontier allows, answers an agent's implementation
 * questions with that agent's own recommendation, and stops the moment it meets
 * something nobody may settle in the developer's place.
 *
 * What it decides is a function of the graph and of the declared caps, exactly
 * like the scheduler (ADR 0003): the mode adds no judgement of its own, it only
 * removes the wait for a click. And it stops rather than guesses, which is the
 * whole difference between an unattended run and an unsupervised one.
 */

/** What the mode does with a question an agent has just asked. */
export type QuestionVerdict =
  /**
   * Squad answers, with the agent's own recommendation and nothing else.
   *
   * `perimeter` says the answer changes what is built, so the developer is owed
   * a word. Handed back rather than raised here: a sheet may hold four of them
   * and they are taken in one sweep, where four notifications for one sweep is
   * four times the same interruption.
   */
  | { kind: "answer"; answer: string; perimeter?: boolean }
  /**
   * Nobody is driving, or nothing was recommended: it waits for the developer,
   * as it always does.
   *
   * There used to be a third, a halt on anything touching the perimeter. The
   * mode exists to carry a night nobody is watching, and a chantier that
   * negotiates contracts between repositories raises such a question every hour
   * or two: stopping on each meant the mode was off more than on. It takes them
   * now and says so, which is the trade the alert carries.
   */
  | { kind: "wait" };

/** What in a graph the mode cannot get past, and what it stopped on. */
export interface Halt {
  reason: AutonomyHaltReason;
  detail: string;
  /**
   * The ticket it stopped on, so what the developer reads can be opened. Null
   * on a question the main session asked, which hangs on no ticket: there the
   * answer is written in the feature's own thread.
   */
  ticketId: string | null;
}

export interface AutonomyDependencies {
  /**
   * What takes the arbitrations a feature has left open, declared by what is
   * needed of it. Held by the pass that records them, since taking one is
   * writing on a test sheet.
   */
  decisions: { takeOpen(featureId: string): void };
  /**
   * What takes the questions a feature has left open, declared by what is
   * needed of it. Held by the module that asks them, since answering one is
   * releasing the call that is waiting on it.
   */
  questions: { takeOpen(featureId: string): void };
  store: Store;
  bus: EventBus;
  alerts: Alerts;
  /**
   * What opens the sub-sessions the caps allow, declared by what is needed of
   * it: the mode queues launches, and the scheduler alone decides when each of
   * them actually opens.
   */
  dispatch: { schedule(): void };
}

export class Autonomy {
  // The features being driven right now. Driving one queues launches, which
  // publishes the graph, which is what drives it: without this the second pass
  // would run inside the first. It is a guard against nesting, not against
  // concurrency: nothing here awaits.
  private readonly driving = new Set<string>();

  constructor(private readonly dependencies: AutonomyDependencies) {}

  /**
   * Watches every graph change, which is the one thing that can open a
   * frontier or stop a run. Hooked to the bus rather than called from each
   * place a ticket moves: a mode that only advances where somebody remembered
   * to advance it is a mode that stalls on the one path nobody thought of.
   */
  watch(): () => void {
    return this.dependencies.bus.subscribe((event) => {
      if (event.type === "graph-changed") this.drive(event.graph.featureId);
    });
  }

  /**
   * Arms or disarms the mode on a feature, and drives it at once when it is
   * armed: the frontier is usually already there, and asking the developer to
   * make something else happen before anything starts would defeat the point.
   */
  arm(featureId: string, goAsRecommended: boolean): Feature {
    const { store, bus } = this.dependencies;
    const feature = store.setGoAsRecommended(featureId, goAsRecommended);
    bus.publish({ type: "feature-changed", feature });
    this.drive(feature.id);
    return store.requireFeature(feature.id);
  }

  /**
   * What the mode does with an arbitration the settling pass raised on a test
   * sheet: it takes the road the agent recommends, whatever that road moves.
   *
   * **Including the perimeter, and that is the whole point of the mode.** It
   * used to stop on anything that changed what is built, on the grounds that
   * the perimeter is never squad's to settle. The grounds were right and the
   * remedy was wrong: measured on the instance, a chantier negotiating
   * contracts between three repositories raised ten such arbitrations in three
   * days, six of them in one day, so the mode spent more time stopped than
   * driving and every restart met the next one. A mode that has to be restarted
   * every hour is not an unattended mode.
   *
   * What replaces the stop is a word. A perimeter decided in someone's absence
   * raises an alert naming the ticket and the road taken, where an ordinary
   * arbitration only gets its note on the thread. The developer still learns
   * every contract decision squad made for them; they learn it in the morning
   * rather than by being stopped at the time.
   *
   * `scopeChanging` therefore keeps its meaning and changes its consequence: it
   * no longer decides whether squad may answer, it decides whether the answer
   * is worth waking someone for.
   *
   * Held here rather than beside the sheet because there is one rule about what
   * squad may decide alone, and it has to read the same wherever it applies.
   */
  verdictForDecision(ticket: Ticket, point: TestSheetPoint): QuestionVerdict {
    const settlement = point.settlement;
    if (settlement === null || settlement.recommendation === null) return { kind: "wait" };
    if (!this.driven(ticket.featureId)) return { kind: "wait" };
    return {
      kind: "answer",
      answer: settlement.recommendation,
      ...(settlement.scopeChanging ? { perimeter: true } : {}),
    };
  }

  verdictFor(question: Question): QuestionVerdict {
    if (!this.driven(question.featureId)) return { kind: "wait" };
    if (question.scopeChanging) {
      // The same trade as an arbitration, and it has to be the same: the two
      // differ only by the channel the agent asked through, so answering one
      // alone and stopping on the other would make the channel the rule.
      // Addressed to the feature's own thread when the main session asked it,
      // such a question hanging on no ticket.
      this.dependencies.alerts.raise(
        alertFor.perimeterAnsweredAlone(
          this.dependencies.store.requireFeature(question.featureId),
          { featureId: question.featureId, ticketId: question.ticketId },
          question.prompt,
          question.recommendation,
        ),
      );
    }
    return { kind: "answer", answer: question.recommendation };
  }

  /**
   * A ticket that has just stopped, and that squad will not take back on its
   * own. It ends the unattended run then and there rather than when the graph
   * runs out of work: a failure is an event, nothing about it is latent, and a
   * mode that kept launching onto a feature somebody has to look at would be
   * unattended rather than autonomous.
   */
  ticketStopped(ticket: Ticket): void {
    if (!this.driven(ticket.featureId)) return;
    this.halt(ticket.featureId, {
      reason: "failure",
      detail: ticket.title,
      ticketId: ticket.id,
    });
  }

  /**
   * A ticket an agent asked for while building another. Squad writes it down
   * whatever its depth and cancels nothing: what the cap bounds is the running,
   * not the recording, and a cascade that stops is one the developer reads
   * before deciding it should go on.
   */
  ticketCreated(ticket: Ticket): void {
    // A first generation is nobody's cascade: it is what the main session
    // wrote, and a cap of zero means "nothing an agent asked for runs
    // unattended", never "nothing runs at all".
    if (ticket.generation === 0) return;
    if (ticket.generation < this.dependencies.store.settings().generationDepthCap) return;
    if (!this.driven(ticket.featureId)) return;
    this.halt(ticket.featureId, {
      reason: "depth-cap",
      detail: ticket.title,
      ticketId: ticket.id,
    });
  }

  /**
   * Launches what the frontier allows on a driven feature, and stops the mode
   * when there is nothing left it may launch and nothing left it is carrying.
   * Reads the graph rather than being told what moved: what a ticket's change
   * opens is a property of the whole graph.
   *
   * Stopping is worked out from being unable to move rather than from meeting
   * something that needs a person. A decision ticket at the far end of a graph
   * blocks nothing yet, and a feature that stopped the moment one was written
   * would never start at all; a decision nothing can go around, on the other
   * hand, is exactly where the night ends.
   */
  drive(featureId: string): void {
    if (this.driving.has(featureId)) return;
    const { store, dispatch } = this.dependencies;
    if (!this.driven(featureId)) return;
    this.driving.add(featureId);
    try {
      // The arbitrations left open on this feature, taken before anything else.
      // They pile up while the mode is held: a pass records one on a feature
      // already stopped on another, `verdictForDecision` answers "wait", and
      // nothing ever asks again. Measured on the instance: one scope
      // arbitration had frozen seven implementation ones, every one of which
      // squad was allowed to take.
      this.dependencies.decisions.takeOpen(featureId);
      // The questions too, and for the same reason: both are asked once, both
      // are answered "wait" while the mode is held, and neither is ever asked
      // again. Whichever is taken first, the other is read on the next drive,
      // which a graph change always brings.
      this.dependencies.questions.takeOpen(featureId);
      const graph = store.featureGraph(featureId);
      const launches = frontier(graph);
      for (const ticket of launches) store.queueLaunch(ticket.id, "implement");
      if (launches.length > 0) {
        // Both once, after the whole queue is written: the graph is announced
        // as it now stands rather than once per ticket, and the scheduler reads
        // the whole state anyway, so telling it per launch would only make it
        // read the same thing several times.
        publishGraph(store, this.dependencies.bus, featureId);
        dispatch.schedule();
        return;
      }
      // Nothing to launch is not the same as nothing happening: a ticket
      // waiting for a place, building, being merged or waiting on a sheet is
      // work squad is still carrying, and what it opens next it will see then.
      if (graph.tickets.some(isInFlight)) return;
      const stuck = stuckOn(graph);
      if (stuck !== null) this.halt(featureId, stuck);
    } finally {
      this.driving.delete(featureId);
    }
  }

  /**
   * Stops the mode on a feature and says why, on the feature and on whatever
   * channel the alerts reach. The mode stays armed and nothing in flight is
   * touched: what stops is squad starting anything more by itself.
   */
  halt(featureId: string, halt: Halt): void {
    const { store, bus, alerts } = this.dependencies;
    const feature = store.haltAutonomy(featureId, halt.reason, halt.detail, halt.ticketId);
    bus.publish({ type: "feature-changed", feature });
    alerts.raise(alertFor.autonomyHalted(feature, halt.reason, halt.detail, halt.ticketId));
  }

  /** Whether squad is driving this feature right now: armed, and not held. */
  private driven(featureId: string): boolean {
    const feature = this.dependencies.store.requireFeature(featureId);
    return feature.goAsRecommended && feature.autonomyHalt === null;
  }
}

/**
 * Whether squad is still carrying a ticket. A sheet waiting to be gone through
 * is in this list because the sub-session that reported it is still there and
 * the merge follows on its own; a ticket squad interrupted is, because squad
 * takes its sub-session back by itself at the next start, and reading a restart
 * as a stop would end every unattended run every time the server goes down.
 */
function isInFlight(ticket: Ticket): boolean {
  return (
    ticket.state === "running" ||
    ticket.state === "queued" ||
    ticket.state === "merging" ||
    ticket.state === "awaiting-validation" ||
    ticket.state === "interrupted"
  );
}

/**
 * What a stopped graph is stopped on, or null when it is simply done. Read only
 * of a graph with nothing left to launch and nothing left in flight: what is
 * named here is therefore what the developer has to settle for the feature to
 * go anywhere at all.
 *
 * A decision ticket is read here rather than when it is written, and that is
 * the whole reason this exists: one written at breakdown time blocks nothing
 * yet, and a mode that stopped on it there and then would never start at all.
 * A ticket that stopped is read here too, but only as a backstop, since one
 * that stops while the mode runs halts it at that very moment.
 */
function stuckOn(graph: FeatureGraph): Halt | null {
  const decision = graph.tickets.find((ticket) => ticket.state === "awaiting-decision");
  if (decision) return { reason: "decision", detail: decision.title, ticketId: decision.id };
  const stopped = graph.tickets.find(
    (ticket) => ticket.state === "failed" || ticket.state === "conflict",
  );
  if (stopped) return { reason: "failure", detail: stopped.title, ticketId: stopped.id };
  return null;
}
