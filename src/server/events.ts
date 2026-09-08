import type { SquadEvent } from "../shared/api";
import type { Store } from "./store";

/**
 * Fan-out of state changes to every open event stream. Squad has one bus per
 * server, and the UI holds no other source of truth than what it receives here.
 */
export class EventBus {
  private readonly subscribers = new Set<(event: SquadEvent) => void>();

  subscribe(subscriber: (event: SquadEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  publish(event: SquadEvent): void {
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }
}

/**
 * Announces a feature's graph as it now stands. Written once and read by
 * everything that moves a ticket: a graph change carries the whole graph rather
 * than the row that moved, since one edge can flip the state of tickets it does
 * not touch, and every caller spelling that out again is a caller that will one
 * day send half of it.
 */
export function publishGraph(store: Store, bus: EventBus, featureId: string): void {
  bus.publish({ type: "graph-changed", graph: store.featureGraph(featureId) });
}
