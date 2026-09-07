import type { SquadEvent } from "../shared/api";

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
