import type { FeatureGraph } from "../shared/api";
import type { ServiceJob } from "../shared/graph";

/**
 * What squad opens next, and nothing else: a pure function of the graphs, of
 * the service sessions asked for, and of the declared caps (ADR 0003, ADR
 * 0008). No effect, no clock, no model call, and no agent ever gets a say in
 * it. Two consequences worth the constraint: the same state always yields the
 * same answer, and a launch cannot be forgotten in silence, since being
 * forgotten would be a property of the state rather than of a decision taken
 * somewhere and lost.
 *
 * It decides for all three kinds of session squad opens, and that is the point:
 * a settling pass and a conflict resolution used to be opened directly by the
 * code that needed them, counted by nobody. Two schedulers would each apply the
 * caps on their side and the total would pass them again.
 */

/** What a place under the caps may be taken for. */
export type LaunchJob = "sub-session" | ServiceJob;

export interface Launch {
  ticketId: string;
  job: LaunchJob;
}

/** A service session asked for on a ticket, open or waiting for a place. */
export interface ScheduledService {
  ticketId: string;
  job: ServiceJob;
  queuedAt: string;
  /** Open, and therefore holding a place rather than waiting for one. */
  started: boolean;
}

/** One feature as the scheduler sees it: its graph, its services, and its cap. */
export interface ScheduledFeature {
  graph: FeatureGraph;
  services: readonly ScheduledService[];
  /** How many sessions this feature may run at once, from its project. */
  cap: number;
}

export interface Scheduling {
  features: readonly ScheduledFeature[];
  /** How many sessions may run at once, every feature together. */
  machineCap: number;
  /**
   * What is being opened right now: handed out, and not yet recorded as
   * running, since a checkout and a process have to be made first. They hold a
   * place like an open one, and they are not handed back: without this, every
   * scheduling during that window would hand them out again.
   */
  opening: readonly Launch[];
}

/**
 * Where each kind of session sits in the queue when places are short.
 *
 * A conflict resolution goes first because it holds back the whole merge chain
 * of its project, which is serialised: everything that project has to merge
 * waits behind it. A settling pass comes next because its work is already done
 * and a person is waiting behind it for a sheet. Then a launch that takes a
 * stopped sub-session back, before one that has never run: its work is already
 * on its branch, and a restart has to cost the turn that was in flight and
 * nothing more, which it would not if the ticket that was running were sent to
 * the back of a queue of tickets that were not.
 */
const ranks = { resolving: 0, settling: 1, resuming: 2, first: 3 } as const;

/**
 * The sessions to open right now.
 *
 * Between two of the same rank, the one that has waited longest goes first, so
 * a launch is never overtaken forever by newer ones; two asked for in the same
 * millisecond are ordered by id rather than left to the order rows come back in.
 */
export function nextLaunches({ features, machineCap, opening }: Scheduling): Launch[] {
  const held = new Set(opening.map(keyOf));

  /**
   * The places a feature is taking, counted by key rather than by adding up
   * three lists: a session that is recorded as open and still being handed out
   * is one place, not two, and the window where both are true is exactly the
   * moment a place is taken.
   */
  const occupied = (feature: ScheduledFeature) => {
    const taken = new Set<string>();
    for (const ticket of feature.graph.tickets) {
      if (ticket.state === "running") taken.add(keyOf({ ticketId: ticket.id, job: "sub-session" }));
    }
    for (const service of feature.services) {
      if (service.started) taken.add(keyOf(service));
    }
    for (const key of held) {
      if (feature.graph.tickets.some((ticket) => key.endsWith(`:${ticket.id}`))) taken.add(key);
    }
    return taken.size;
  };

  const places = new Map(
    features.map((feature) => [feature.graph.featureId, feature.cap - occupied(feature)]),
  );
  let machinePlaces =
    machineCap - features.reduce((total, feature) => total + occupied(feature), 0);

  const waiting = features
    .flatMap((feature) => [
      ...feature.services
        .filter((service) => !service.started)
        .map((service) => ({
          launch: { ticketId: service.ticketId, job: service.job } satisfies Launch,
          featureId: feature.graph.featureId,
          queuedAt: service.queuedAt,
          rank: ranks[service.job],
        })),
      ...feature.graph.tickets
        .filter((ticket) => ticket.state === "queued")
        .map((ticket) => ({
          launch: { ticketId: ticket.id, job: "sub-session" as const } satisfies Launch,
          featureId: feature.graph.featureId,
          queuedAt: ticket.queuedAt ?? "",
          // A session written on the ticket is a session to take back: nothing
          // else ever puts one there.
          rank: ticket.sessionId !== null ? ranks.resuming : ranks.first,
        })),
    ])
    .filter((entry) => !held.has(keyOf(entry.launch)))
    .sort((one, other) => {
      if (one.rank !== other.rank) return one.rank - other.rank;
      if (one.queuedAt !== other.queuedAt) return one.queuedAt.localeCompare(other.queuedAt);
      return one.launch.ticketId.localeCompare(other.launch.ticketId);
    });

  const launches: Launch[] = [];
  for (const entry of waiting) {
    if (machinePlaces <= 0) break;
    const featurePlaces = places.get(entry.featureId) ?? 0;
    // Skipped rather than stopped on: another feature further down the queue
    // may well have a place, and holding the whole machine back because one
    // feature is full would waste the very parallelism the caps are sizing.
    if (featurePlaces <= 0) continue;
    launches.push(entry.launch);
    places.set(entry.featureId, featurePlaces - 1);
    machinePlaces -= 1;
  }
  return launches;
}

/** What identifies a place taken: one ticket may hold one of each job at most. */
export function keyOf(launch: Launch): string {
  return `${launch.job}:${launch.ticketId}`;
}
