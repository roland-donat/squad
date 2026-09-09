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
 * that sub-session reported the end of its step, it failed, its process
 * disappeared, the work was merged, the decision was settled.
 */
export const ticketLifecycles = [
  "unstarted",
  "running",
  "awaiting-validation",
  "merging",
  "failed",
  "interrupted",
  "conflict",
  "merged",
  "settled",
] as const;
export type TicketLifecycle = (typeof ticketLifecycles)[number];

/**
 * The jobs squad opens a session of its own for, on a ticket it is not building:
 * settling a test sheet before anyone is woken, and untangling a merge conflict.
 * Named together because they are counted together: they are sessions squad
 * opens for itself, and the concurrency caps hold them exactly like the
 * sub-sessions that build.
 */
export const serviceJobs = ["settling", "resolving"] as const;
export type ServiceJob = (typeof serviceJobs)[number];

/**
 * Whether a ticket's sub-session is one squad can take back: it stopped, its
 * branch and its worktree are still there, and its session id is written down.
 * Read wherever that question is asked, rather than each caller spelling the
 * three states out again and one of them being forgotten the day a fourth
 * arrives.
 *
 * A conflict belongs here for the same reason the other two do: the work is on
 * the branch, the session that wrote it is still known, and the way out is to
 * take it back. What differs is only what squad says when it does.
 *
 * Answered on a state or on a lifecycle, which name these the same way: a
 * ticket waiting for a place reads as `queued`, and what squad has to know
 * before opening its session is the run it recorded underneath.
 */
export function isResumable(state: TicketState | TicketLifecycle): boolean {
  return state === "failed" || state === "interrupted" || state === "conflict";
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

/** What a ticket's row says about it, which is all its state is read from. */
export interface TicketRecord {
  kind: TicketKind;
  lifecycle: TicketLifecycle;
  /** Set while a launch squad accepted waits for a place under the caps. */
  queuedAt: string | null;
  /** The service session squad has on this ticket, asked for or open. */
  serviceJob: ServiceJob | null;
  /** Set once that session is actually open, and null while it waits. */
  serviceStartedAt: string | null;
  /**
   * What the test sheet is waiting for, when it waits at all.
   *
   * Told apart because a person is not owed the same thing by each: a
   * `validation` is something only they can observe (what a screen looks like,
   * whether a wording reads well) and it waits however long it takes, while a
   * `decision` is an arbitration squad takes itself under go-as-recommended.
   * A sheet holding both waits as a validation, the heavier of the two.
   */
  sheetWaits: "none" | "validation" | "decision";
}

/**
 * A ticket is blocked as long as one of its blockers is not merged. Once they
 * all are, a `build` or `fix` ticket is ready to launch, and a `decision` one
 * waits for the developer instead: it never enters the frontier, which is what
 * makes "a decision ticket opens no sub-session" a property of the graph rather
 * than a check the launcher has to remember.
 *
 * Nothing is stored under these names: they follow from the edges, the kind and
 * the launch record, so an edge added later needs no write to make them true
 * again.
 */
export function resolveTicketState(
  record: TicketRecord,
  blockerIds: readonly string[],
  cleared: ReadonlySet<string>,
): TicketState {
  const { kind, lifecycle, queuedAt } = record;
  if (holdsNothingBack(lifecycle)) return "merged";
  // What squad is doing right now outranks everything else. A ticket only ever
  // ran because its blockers were merged, so the two never disagree; and
  // reading the edges first would make a running ticket flicker back to `ready`
  // the day a blocker is added in front of it.
  if (lifecycle === "running" || lifecycle === "merging") return lifecycle;
  // The edges only outrank a ticket that never ran at all: a blocker posted in
  // front of a waiting launch takes that launch out of the frontier, which is
  // exactly what a `fix` ticket is for. The request itself is not thrown away,
  // so the ticket goes back to waiting for a place once its blocker merges.
  if (lifecycle === "unstarted" && !blockerIds.every((blockerId) => cleared.has(blockerId))) {
    return "blocked";
  }
  // Before the run underneath it, and after the two states above: a correction
  // owed on a rejected test sheet is a launch squad accepted and has not opened
  // yet, exactly like a first launch that found the caps full. Reading the
  // report instead would show a sheet still waiting for a reader who has
  // already been through it.
  if (queuedAt !== null) return "queued";
  // Squad's own work on the sheet, before the ticket is said to be waiting on
  // anyone: the settling pass is what decides whether there is anything left
  // for a person, so saying so beforehand would wake them for what squad is
  // about to answer itself. A resolution session says nothing here, its ticket
  // being `merging`, which already says squad is on it.
  if (record.serviceJob === "settling") {
    return record.serviceStartedAt === null ? "settling-queued" : "settling";
  }
  if (lifecycle === "awaiting-validation") {
    return record.sheetWaits === "decision" ? "awaiting-decision" : "awaiting-validation";
  }
  if (lifecycle === "failed" || lifecycle === "interrupted" || lifecycle === "conflict") {
    return lifecycle;
  }
  return kind === "decision" ? "awaiting-decision" : "ready";
}

/**
 * Whether every ticket of a graph has come back, which is what makes a feature
 * a feature to deliver. Read here rather than spelled out again wherever it is
 * needed: it decides both what squad sends off in a pull request and what the
 * home screen files under features already delivered, and those two cannot be
 * allowed to disagree.
 *
 * An empty graph is not drained. Nothing was built, so there is nothing to
 * deliver, and a feature opened a minute ago is not a feature that is finished.
 */
export function isDrained(graph: FeatureGraph): boolean {
  return graph.tickets.length > 0 && graph.tickets.every((ticket) => ticket.state === "merged");
}

/** How far a graph has come, as a count of what has merged out of the whole. */
export function graphProgress(graph: FeatureGraph): { merged: number; total: number } {
  return {
    merged: graph.tickets.filter((ticket) => ticket.state === "merged").length,
    total: graph.tickets.length,
  };
}
