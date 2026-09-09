import type {
  AutonomyHaltReason,
  Feature,
  FeatureGraph,
  Question,
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
  /** Squad answers, with the agent's own recommendation and nothing else. */
  | { kind: "answer"; answer: string }
  /** The mode was driving this feature and stops here. */
  | { kind: "halt" }
  /** Nobody is driving: the question waits for the developer, as it always does. */
  | { kind: "wait" };

/** What in a graph the mode cannot get past, and what it stopped on. */
export interface Halt {
  reason: AutonomyHaltReason;
  detail: string;
}

export interface AutonomyDependencies {
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
   * What the mode does with a question. A question that changes what is built
   * is where the mode stops, whatever it recommends: the perimeter is the one
   * thing squad never settles on its own.
   */
  verdictFor(question: Question): QuestionVerdict {
    if (!this.driven(question.featureId)) return { kind: "wait" };
    if (question.scopeChanging) {
      this.halt(question.featureId, { reason: "scope-question", detail: question.prompt });
      return { kind: "halt" };
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
    this.halt(ticket.featureId, { reason: "failure", detail: ticket.title });
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
    this.halt(ticket.featureId, { reason: "depth-cap", detail: ticket.title });
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
    const feature = store.haltAutonomy(featureId, halt.reason, halt.detail);
    bus.publish({ type: "feature-changed", feature });
    alerts.raise(alertFor.autonomyHalted(feature, halt.reason, halt.detail));
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
  if (decision) return { reason: "decision", detail: decision.title };
  const stopped = graph.tickets.find(
    (ticket) => ticket.state === "failed" || ticket.state === "conflict",
  );
  if (stopped) return { reason: "failure", detail: stopped.title };
  return null;
}
