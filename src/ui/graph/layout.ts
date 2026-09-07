import type { BlockingEdge, FeatureGraph, Ticket } from "../../shared/api";

/**
 * Where each ticket is drawn. The layout is derived from the edges alone, so a
 * ticket added mid-course finds its place without anything to reposition: there
 * is no stored coordinate anywhere, and none to keep in step with the graph.
 */

export const nodeWidth = 232;
export const nodeHeight = 104;
const columnGap = 28;
const layerGap = 72;

export interface PlacedTicket {
  ticket: Ticket;
  /** How many merges deep this ticket sits: 0 for a ticket nothing blocks. */
  layer: number;
  x: number;
  y: number;
}

export interface PlacedEdge {
  edge: BlockingEdge;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface GraphLayout {
  nodes: PlacedTicket[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export function layOutGraph(graph: FeatureGraph): GraphLayout {
  const layers = assignLayers(graph);
  const rows = new Map<number, Ticket[]>();
  for (const ticket of graph.tickets) {
    const layer = layers.get(ticket.id) ?? 0;
    const row = rows.get(layer) ?? [];
    row.push(ticket);
    rows.set(layer, row);
  }

  const widest = Math.max(0, ...[...rows.values()].map((row) => rowWidth(row.length)));
  const nodes: PlacedTicket[] = [];
  for (const [layer, row] of rows) {
    const offset = (widest - rowWidth(row.length)) / 2;
    row.forEach((ticket, column) => {
      nodes.push({
        ticket,
        layer,
        x: offset + column * (nodeWidth + columnGap),
        y: layer * (nodeHeight + layerGap),
      });
    });
  }

  const placed = new Map(nodes.map((node) => [node.ticket.id, node]));
  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const blocker = placed.get(edge.blockerId);
    const blocked = placed.get(edge.blockedId);
    if (!blocker || !blocked) continue;
    edges.push({
      edge,
      from: { x: blocker.x + nodeWidth / 2, y: blocker.y + nodeHeight },
      to: { x: blocked.x + nodeWidth / 2, y: blocked.y },
    });
  }

  const depth = rows.size;
  return {
    nodes,
    edges,
    width: widest,
    height: depth === 0 ? 0 : depth * (nodeHeight + layerGap) - layerGap,
  };
}

function rowWidth(count: number): number {
  return count * nodeWidth + Math.max(0, count - 1) * columnGap;
}

/**
 * A ticket sits one layer below its deepest blocker, which is the reading the
 * arrows already carry: everything above a node must be merged before it starts.
 */
function assignLayers(graph: FeatureGraph): Map<string, number> {
  const blockers = new Map<string, string[]>(graph.tickets.map((ticket) => [ticket.id, []]));
  for (const edge of graph.edges) blockers.get(edge.blockedId)?.push(edge.blockerId);

  const layers = new Map<string, number>();
  const walking = new Set<string>();

  const layerOf = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    // The store refuses a cycle at the write, so this only guards the drawing
    // against a graph that should not exist rather than against a real case.
    if (walking.has(id)) return 0;
    walking.add(id);
    const above = blockers.get(id) ?? [];
    const layer = above.length === 0 ? 0 : 1 + Math.max(...above.map(layerOf));
    walking.delete(id);
    layers.set(id, layer);
    return layer;
  };

  for (const ticket of graph.tickets) layerOf(ticket.id);
  return layers;
}
