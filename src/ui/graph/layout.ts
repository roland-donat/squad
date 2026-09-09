import type { BlockingEdge, FeatureGraph, Ticket } from "../../shared/api";
import { blockersByTicket } from "../../shared/graph";

/**
 * Where each ticket is drawn. The layout is derived from the edges alone, so a
 * ticket added mid-course finds its place without anything to reposition: there
 * is no stored coordinate anywhere, and none to keep in step with the graph.
 *
 * It is a function of the graph and of nothing else, the viewport included. The
 * same feature therefore reads the same on two screens, and resizing the window
 * moves no node: spatial memory, which is the whole of what makes a map worth
 * looking at, only settles if positions hold still.
 */

export const nodeWidth = 176;
export const nodeHeight = 64;
const columnGap = 20;
const rowGap = 20;
const layerGap = 56;

export interface PlacedTicket {
  ticket: Ticket;
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
  // Creation order inside a layer, read off the row rather than left to the
  // order the tickets arrived in. Grouping by state would read better for a
  // second and cost the rest: a ticket changes state several times an hour, so
  // it would walk across the block while it is being looked at.
  for (const row of rows.values()) {
    row.sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
  }

  const ordered = [...rows.keys()].sort((left, right) => left - right);
  const widest = Math.max(0, ...ordered.map((layer) => blockWidth(columnsFor(rows.get(layer)!.length))));

  const nodes: PlacedTicket[] = [];
  let top = 0;
  for (const layer of ordered) {
    const row = rows.get(layer)!;
    const columns = columnsFor(row.length);
    const offset = (widest - blockWidth(columns)) / 2;
    row.forEach((ticket, index) => {
      nodes.push({
        ticket,
        x: offset + (index % columns) * (nodeWidth + columnGap),
        y: top + Math.floor(index / columns) * (nodeHeight + rowGap),
      });
    });
    top += blockHeight(Math.ceil(row.length / columns)) + layerGap;
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

  return {
    nodes,
    edges,
    width: widest,
    height: Math.max(0, top - layerGap),
  };
}

/**
 * How wide a layer is allowed to be. A layer holds everything nothing holds
 * back yet, so it is routinely the widest thing on the map: fifteen of the
 * twenty-seven tickets of a real feature sat on the first one, which laid out
 * in a single row measured 3 872 px. Wrapped on the square root, the same layer
 * becomes a block of four by four that a screen holds.
 */
function columnsFor(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function blockWidth(columns: number): number {
  return columns * nodeWidth + (columns - 1) * columnGap;
}

function blockHeight(rows: number): number {
  return rows * nodeHeight + (rows - 1) * rowGap;
}

/**
 * A ticket sits one layer below its deepest blocker, which is the reading the
 * arrows already carry: everything above a node must be merged before it starts.
 */
function assignLayers(graph: FeatureGraph): Map<string, number> {
  const blockers = blockersByTicket(
    graph.tickets.map((ticket) => ticket.id),
    graph.edges,
  );

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
