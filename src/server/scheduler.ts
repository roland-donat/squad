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
  starting: readonly string[];
}

/**
 * The tickets to open a sub-session for, right now. The ones that have waited
 * longest come first, so a launch is never overtaken forever by newer ones, and
 * two launches asked for in the same millisecond are ordered by id rather than
 * left to the order rows happen to come back in.
 */
export function nextLaunches({ features, machineCap, starting }: Scheduling): string[] {
  const held = new Set(starting);
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
        })),
    )
    .sort((one, other) =>
      one.queuedAt === other.queuedAt
        ? one.id.localeCompare(other.id)
        : one.queuedAt.localeCompare(other.queuedAt),
    );

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
