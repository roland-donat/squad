import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { FeatureGraph, Ticket, TicketKind, TicketState } from "../../shared/api";
import { frontier } from "../../shared/graph";
import { familyOf, type StateFamily } from "../../shared/state-family";
import { KindGlyph, SettledGlyph } from "./glyphs";
import { shortRepositoryLabels } from "./repositories";
import { layOutGraph, nodeHeight, nodeWidth, type PlacedTicket } from "./layout";
import { useViewport } from "./viewport";

/**
 * The map of a feature, read-only at the gesture: no node moves, no edge is
 * drawn by hand, and every correction goes back through the main session. It
 * answers "where are we and whose turn is it" at a glance; what a ticket says
 * is read in the drawer, one click away.
 *
 * Nothing here is coded by colour alone. A kind is a filled silhouette, a state
 * family is a ring whose stroke says which one, and the exact state stays in
 * the accessible label and in the tooltip.
 */

const kindLabels: Record<TicketKind, string> = {
  build: "construction",
  decision: "décision",
  fix: "correction",
};

const stateLabels: Record<TicketState, string> = {
  blocked: "bloqué",
  ready: "prêt",
  queued: "attend une place",
  running: "en cours",
  "awaiting-validation": "à vérifier",
  settling: "squad vérifie",
  "settling-queued": "vérification en attente",
  merging: "en fusion",
  failed: "arrêté",
  interrupted: "interrompu",
  conflict: "en conflit",
  "awaiting-decision": "à trancher",
  merged: "fusionné",
};

const familyLabels: Record<StateFamily, string> = {
  blocked: "bloqué",
  ready: "prêt à partir",
  running: "en cours",
  "awaiting-developer": "attend une personne",
  settled: "terminé",
};

/** Where each arrow key goes, as a unit vector in the map's own coordinates. */
const directions: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

/**
 * A settled decision reaches the state `merged`, because that is what releases
 * the tickets it held back, but nothing of it was ever merged into a branch:
 * saying so on the node would be a lie the reader has no way to catch. The
 * wording follows the conclusion the server recorded, so this reads a declared
 * field rather than working a state out for itself.
 */
function stateLabel(ticket: Ticket): string {
  if (ticket.conclusion !== null) return "tranché";
  return stateLabels[ticket.state];
}

export function FeatureGraphView({
  graph,
  repositoryNames,
  awaitingDeveloper,
  selectedId,
  onSelect,
  onDeselect,
  obstructedRight,
  obstructedBottom,
}: {
  graph: FeatureGraph;
  /**
   * The repositories the feature carries, by id. A node says which one it is
   * built in only when there are several: on a feature carrying one, the answer
   * is the same everywhere and the mark would be noise on every node.
   */
  repositoryNames: Map<string, string>;
  /**
   * The tickets waiting on the developer, as the waiting indicator lists them.
   * Passed in rather than worked out here so that the map and the indicator
   * cannot say two different things about the same ticket.
   */
  awaitingDeveloper: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (ticketId: string) => void;
  /** Clears the selection: a press on the background that went nowhere. */
  onDeselect: () => void;
  /** How much of the map's right edge the ticket drawer covers, in screen pixels. */
  obstructedRight: number;
  /** How much of its bottom edge the thread drawer covers, likewise. */
  obstructedBottom: number;
}) {
  const layout = layOutGraph(graph);
  const { viewport, frame, fit, zoomBy, bringIntoView, onPointerDown, onPointerMove, endDrag } =
    useViewport({
      contentWidth: layout.width,
      contentHeight: layout.height,
      resetKey: graph.featureId,
      obstructedRight,
      obstructedBottom,
    });

  // What the reader is pointing at, which is what its arrows are shown for. The
  // selection stands in when nothing is pointed at, so a ticket opened from the
  // waiting indicator arrives with its own edges already told apart.
  const [pointed, setPointed] = useState<string | null>(null);
  // The map is one tab stop, not one per node: twenty-seven of them stand
  // between the keyboard and the drawer, and that number grows with the work.
  // Inside it, the arrows walk from node to node.
  const [walkedTo, setWalkedTo] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());

  const first = layout.nodes[0]?.ticket.id ?? null;
  const tabStop = layout.nodes.some((node) => node.ticket.id === walkedTo)
    ? walkedTo
    : (selectedId ?? first);

  // The drawer covers the right of the map, so it covers the node one just
  // clicked often enough. Translated back into view, never rescaled: the zoom
  // belongs to the reader.
  const placedSelected = layout.nodes.find((node) => node.ticket.id === selectedId);
  const selectedX = placedSelected?.x ?? null;
  const selectedY = placedSelected?.y ?? null;
  useEffect(() => {
    if (selectedX === null || selectedY === null) return;
    bringIntoView({ x: selectedX, y: selectedY, width: nodeWidth, height: nodeHeight });
  }, [bringIntoView, selectedX, selectedY, obstructedRight, obstructedBottom]);

  // No early return before the viewport is rendered, and this is not a detail:
  // a feature is opened before its graph is written, so leaving the element out
  // while there is nothing to draw would attach neither the framing nor the
  // wheel, and neither would ever be attached afterwards.
  const written = graph.tickets.length > 0;
  const readyCount = frontier(graph).length;
  const shortNames = shortRepositoryLabels(repositoryNames);
  const focused = pointed ?? selectedId;

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.25);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.25);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      fit();
      return;
    }
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const from = layout.nodes.find((node) => node.ticket.id === tabStop) ?? layout.nodes[0];
    if (!from) return;
    const next = nearest(layout.nodes, from, direction);
    if (!next) return;
    setWalkedTo(next.ticket.id);
    bringIntoView({ x: next.x, y: next.y, width: nodeWidth, height: nodeHeight });
    elements.current.get(next.ticket.id)?.focus();
  }

  return (
    <>
      {written && <Legend readyCount={readyCount} onRecentre={fit} />}
      <div
        className="graph__viewport"
        ref={viewport}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, onDeselect)}
        onPointerCancel={(event) => endDrag(event, () => {})}
      >
        {!written && (
          <p className="empty empty--map">
            Aucun ticket. Le graphe naît quand la session principale écrit le découpage.
          </p>
        )}
        <div
          className="graph"
          data-focused={focused === null ? undefined : "true"}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${frame.x}px, ${frame.y}px) scale(${frame.scale})`,
          }}
        >
          <svg
            className="graph__edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <marker
                id="graph-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {layout.edges.map(({ edge, from, to }) => (
              <path
                key={`${edge.blockerId}-${edge.blockedId}`}
                className="graph__edge"
                data-emphasis={
                  focused === edge.blockerId || focused === edge.blockedId ? "true" : undefined
                }
                d={curve(from, to)}
                markerEnd="url(#graph-arrow)"
              />
            ))}
          </svg>

          {layout.nodes.map(({ ticket, x, y }) => {
            const repository = repositoryNames.size > 1 ? repositoryNames.get(ticket.projectId) : null;
            const family = familyOf(ticket, awaitingDeveloper);
            return (
              // A button, not a card with a click handler: opening a ticket is
              // reachable from the keyboard and announced as an action. The
              // graph stays read-only at the gesture; this selects, it never
              // edits.
              <button
                key={ticket.id}
                type="button"
                className="node"
                ref={(element) => {
                  if (element) elements.current.set(ticket.id, element);
                  else elements.current.delete(ticket.id);
                }}
                data-kind={ticket.kind}
                data-family={family}
                data-state={ticket.state}
                data-selected={ticket.id === selectedId ? "true" : undefined}
                aria-current={ticket.id === selectedId}
                tabIndex={ticket.id === tabStop ? 0 : -1}
                style={{ left: x, top: y, width: nodeWidth, height: nodeHeight }}
                // The node shows about forty characters of a title that runs to
                // eighty-three in the median, so the whole of it has to be
                // readable without opening anything. The native tooltip rather
                // than one of our own: no positioning to write, no state to
                // hold, and the browser already knows where the screen ends.
                title={[
                  ticket.title,
                  `${kindLabels[ticket.kind]} · ${stateLabel(ticket)}`,
                  ...(repository ? [repository] : []),
                ].join("\n")}
                // The exact state, not the family it is painted with: the ring
                // says whose turn it is, and this says the same thing the panel
                // would. Giving less here would make the map poorer to whoever
                // reads it rather than looks at it.
                aria-label={[
                  ticket.title,
                  kindLabels[ticket.kind],
                  stateLabel(ticket),
                  ...(repository ? [repository] : []),
                ].join(", ")}
                onClick={() => onSelect(ticket.id)}
                onPointerEnter={() => setPointed(ticket.id)}
                onPointerLeave={() => setPointed((current) => (current === ticket.id ? null : current))}
                onFocus={() => {
                  setPointed(ticket.id);
                  setWalkedTo(ticket.id);
                }}
                onBlur={() => setPointed((current) => (current === ticket.id ? null : current))}
              >
                <KindGlyph kind={ticket.kind} />
                <span className="node__title">{ticket.title}</span>
                {family === "running" && <span className="node__pulse" aria-hidden="true" />}
                {family === "settled" && <SettledGlyph />}
                {repository && (
                  <span className="node__repository" aria-hidden="true">
                    {shortNames.get(ticket.projectId)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * What the marks mean, permanently rather than folded away: this is the one
 * screen of squad one reads without clicking, and a map whose symbols are a
 * gesture away is a map nobody learns.
 */
function Legend({ readyCount, onRecentre }: { readyCount: number; onRecentre: () => void }) {
  return (
    <p className="graph__legend">
      <span className="graph__legend-item">flèche : « doit être fusionné avant »</span>
      {(["build", "decision", "fix"] as const).map((kind) => (
        <span key={kind} className="graph__legend-item">
          <KindGlyph kind={kind} />
          {kindLabels[kind]}
        </span>
      ))}
      {(["blocked", "ready", "running", "awaiting-developer", "settled"] as const).map((family) => (
        <span key={family} className="graph__legend-item">
          <span className="graph__legend-ring" data-family={family} aria-hidden="true" />
          {familyLabels[family]}
        </span>
      ))}
      <span className="graph__legend-item graph__legend-item--count">
        <strong>{readyCount}</strong> {readyCount > 1 ? "prêts à partir" : "prêt à partir"}
        <button type="button" className="link" onClick={onRecentre} title="touche 0">
          recadrer
        </button>
      </span>
    </p>
  );
}

/**
 * The node an arrow key walks to: the closest one lying in that direction,
 * counting what it is off to the side twice, so a step right stays a step right
 * rather than sliding down the block.
 */
function nearest(
  all: PlacedTicket[],
  from: PlacedTicket,
  [dx, dy]: [number, number],
): PlacedTicket | null {
  let best: PlacedTicket | null = null;
  let score = Infinity;
  for (const node of all) {
    if (node === from) continue;
    const alongX = node.x - from.x;
    const alongY = node.y - from.y;
    const along = alongX * dx + alongY * dy;
    if (along <= 0) continue;
    const across = Math.abs(alongX * dy - alongY * dx);
    const candidate = along + across * 2;
    if (candidate < score) {
      score = candidate;
      best = node;
    }
  }
  return best;
}

/**
 * A vertical cubic curve rather than a straight line: two edges arriving on the
 * same node stay told apart, and a long edge does not cross a node it has
 * nothing to do with.
 */
function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const bend = Math.max(24, (to.y - from.y) / 2);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + bend}, ${to.x} ${to.y - bend}, ${to.x} ${to.y}`;
}
