import type { FeatureGraph, Ticket, TicketKind, TicketState } from "./api";

/**
 * The rules of the graph, held away from storage, HTTP and rendering so they can
 * be read on their own and applied in one place: what blocks what, what a cycle
 * is, what state an edge set puts a ticket in, and what can be launched now.
 */

/**
 * What squad has recorded of a ticket's execution, as stored on the row.
 * `blocked` and `ready` are absent on purpose: they follow from the edges and
 * are read off them at every query, so no write is ever needed to keep them
 * true. What is written here is only what squad did: it launched a sub-session,
 * that sub-session failed, its process disappeared, the work was merged, the
 * decision was settled.
 */
export const ticketLifecycles = [
  "unstarted",
  "running",
  "failed",
  "interrupted",
  "merged",
  "settled",
] as const;
export type TicketLifecycle = (typeof ticketLifecycles)[number];

/**
 * Whether a ticket's sub-session is one squad can take back: it stopped, its
 * branch and its worktree are still there, and its session id is written down.
 * Read wherever that question is asked, rather than each caller spelling the
 * two states out again and one of them being forgotten the day a third arrives.
 */
export function isResumable(state: TicketState): boolean {
  return state === "failed" || state === "interrupted";
}

/**
 * Whether a ticket has stopped holding back the tickets it blocks. Being merged
 * is the ordinary way there. A settled decision is the other: nothing of it was
 * ever merged, and it still has to release what waited on it, so the record says
 * `settled` and the state it is read as stays `merged`.
 */
export function holdsNothingBack(lifecycle: TicketLifecycle): boolean {
  return lifecycle === "merged" || lifecycle === "settled";
}

/** An edge stripped of the feature it belongs to: both ends and nothing else. */
export interface GraphEdge {
  blockerId: string;
  blockedId: string;
}

/** For each ticket, the tickets that must be merged before it may start. */
export function blockersByTicket(
  nodeIds: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, string[]> {
  return index(nodeIds, edges, (edge) => [edge.blockedId, edge.blockerId]);
}

/** For each blocker, the tickets it holds back. */
export function blockedByBlocker(
  nodeIds: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, string[]> {
  return index(nodeIds, edges, (edge) => [edge.blockerId, edge.blockedId]);
}

function index(
  nodeIds: readonly string[],
  edges: readonly GraphEdge[],
  ends: (edge: GraphEdge) => [string, string],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    const [key, value] = ends(edge);
    grouped.get(key)?.push(value);
  }
  return grouped;
}

/** The tickets that can be launched right now: those whose blockers are merged. */
export function frontier(graph: FeatureGraph): Ticket[] {
  return graph.tickets.filter((ticket) => ticket.state === "ready");
}

/**
 * The ids forming a cycle, in the order the arrows follow, or null when the
 * edges are acyclic. A path rather than a boolean: a refusal that names the
 * loop it refused is the difference between a message and a wall.
 */
export function findCycle(nodeIds: readonly string[], edges: readonly GraphEdge[]): string[] | null {
  const blocked = blockedByBlocker(nodeIds, edges);
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const path: string[] = [];

  const walk = (node: string): string[] | null => {
    visiting.add(node);
    path.push(node);
    for (const next of blocked.get(node) ?? []) {
      // An arrow back onto the path being walked closes a loop, and the path
      // from that node onwards is exactly the loop.
      if (visiting.has(next)) return path.slice(path.indexOf(next));
      if (settled.has(next)) continue;
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(node);
    settled.add(node);
    return null;
  };

  for (const node of nodeIds) {
    if (settled.has(node)) continue;
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * A ticket is blocked as long as one of its blockers is not merged. Once they
 * all are, a `build` or `fix` ticket is ready to launch, and a `decision` one
 * waits for the developer instead: it never enters the frontier, which is what
 * makes "a decision ticket opens no sub-session" a property of the graph rather
 * than a check the launcher has to remember.
 *
 * Nothing is stored under these names: they follow from the edges and the kind,
 * so an edge added later needs no write to make them true again.
 */
export function resolveTicketState(
  kind: TicketKind,
  lifecycle: TicketLifecycle,
  blockerIds: readonly string[],
  cleared: ReadonlySet<string>,
): TicketState {
  if (holdsNothingBack(lifecycle)) return "merged";
  // What squad recorded of a run outranks what the edges say. A ticket only
  // ever ran because its blockers were merged, so the two never disagree; and
  // reading the edges first would make a running ticket flicker back to `ready`
  // the day a blocker is added in front of it.
  if (lifecycle === "running" || lifecycle === "failed" || lifecycle === "interrupted") {
    return lifecycle;
  }
  if (!blockerIds.every((blockerId) => cleared.has(blockerId))) return "blocked";
  return kind === "decision" ? "awaiting-decision" : "ready";
}
