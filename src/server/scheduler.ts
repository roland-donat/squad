import type { FeatureGraph } from "../shared/api";

/**
 * What squad launches next, and nothing else: a pure function of the graphs and
 * of the declared caps (ADR 0003). No effect, no clock, no model call, and no
 * agent ever gets a say in it. Two consequences worth the constraint: the same
 * state always yields the same answer, and a ticket cannot be forgotten in
 * silence, since being forgotten would be a property of the state rather than
 * of a decision taken somewhere and lost.
 */

/** One feature as the scheduler sees it: its graph, and the cap it runs under. */
export interface ScheduledFeature {
  graph: FeatureGraph;
  /** How many sub-sessions this feature may run at once, from its project. */
  cap: number;
}

export interface Scheduling {
  features: readonly ScheduledFeature[];
  /** How many sub-sessions may run at once, every feature together. */
  machineCap: number;
  /**
   * Tickets whose sub-session is being opened right now: accepted, and not yet
   * recorded as running, since a checkout and a process have to be made first.
   * They hold a place like a running one, and they are not handed back: without
   * this, every scheduling during that window would launch them again.
   */
  opening: readonly string[];
}

/**
 * The tickets to open a sub-session for, right now.
 *
 * A launch that takes a stopped sub-session back goes before one that has never
 * run: its work is already on its branch, and a restart has to cost the turn
 * that was in flight and nothing more, which it would not if the ticket that
 * was running were sent to the back of a queue of tickets that were not.
 *
 * Between two of the same kind, the one that has waited longest goes first, so
 * a launch is never overtaken forever by newer ones; two asked for in the same
 * millisecond are ordered by id rather than left to the order rows come back in.
 */
export function nextLaunches({ features, machineCap, opening }: Scheduling): string[] {
  const held = new Set(opening);
  const occupied = (feature: ScheduledFeature) =>
    feature.graph.tickets.filter(
      (ticket) => ticket.state === "running" || held.has(ticket.id),
    ).length;

  const places = new Map(
    features.map((feature) => [feature.graph.featureId, feature.cap - occupied(feature)]),
  );
  let machinePlaces =
    machineCap - features.reduce((total, feature) => total + occupied(feature), 0);

  const waiting = features
    .flatMap((feature) =>
      feature.graph.tickets
        .filter((ticket) => ticket.state === "queued" && !held.has(ticket.id))
        .map((ticket) => ({
          id: ticket.id,
          featureId: feature.graph.featureId,
          queuedAt: ticket.queuedAt ?? "",
          // A session written on the ticket is a session to take back: nothing
          // else ever puts one there.
          resuming: ticket.sessionId !== null,
        })),
    )
    .sort((one, other) => {
      if (one.resuming !== other.resuming) return one.resuming ? -1 : 1;
      if (one.queuedAt !== other.queuedAt) return one.queuedAt.localeCompare(other.queuedAt);
      return one.id.localeCompare(other.id);
    });

  const launches: string[] = [];
  for (const ticket of waiting) {
    if (machinePlaces <= 0) break;
    const featurePlaces = places.get(ticket.featureId) ?? 0;
    // Skipped rather than stopped on: another feature further down the queue
    // may well have a place, and holding the whole machine back because one
    // feature is full would waste the very parallelism the caps are sizing.
    if (featurePlaces <= 0) continue;
    launches.push(ticket.id);
    places.set(ticket.featureId, featurePlaces - 1);
    machinePlaces -= 1;
  }
  return launches;
}
