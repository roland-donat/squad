import type { FeatureGraph, Ticket, TicketState } from "./api";

/**
 * The rules of the graph, held away from storage, HTTP and rendering so they can
 * be read on their own and applied in one place: what blocks what, what a cycle
 * is, what state an edge set puts a ticket in, and what can be launched now.
 */

/** What squad has recorded of a ticket's execution, as stored on the row. */
export const ticketLifecycles = ["unstarted", "merged"] as const;
export type TicketLifecycle = (typeof ticketLifecycles)[number];

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
 * A ticket is blocked as long as one of its blockers is not merged, and ready
 * otherwise. Nothing is stored under those two names: they follow from the
 * edges, so an edge added later needs no write to make them true again.
 */
export function resolveTicketState(
  lifecycle: TicketLifecycle,
  blockerIds: readonly string[],
  merged: ReadonlySet<string>,
): TicketState {
  if (lifecycle === "merged") return "merged";
  return blockerIds.every((blockerId) => merged.has(blockerId)) ? "ready" : "blocked";
}
