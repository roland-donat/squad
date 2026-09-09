import { useState } from "react";
import type { FeatureGraph, Ticket, TicketKind, TicketState } from "../../shared/api";
import { frontier } from "../../shared/graph";
import { familyOf, type StateFamily } from "../../shared/state-family";
import { KindGlyph, SettledGlyph } from "./glyphs";
import { shortRepositoryLabels } from "./repositories";
import { layOutGraph, nodeHeight, nodeWidth } from "./layout";

/**
 * The map of a feature, read-only at the gesture: no node moves, no edge is
 * drawn by hand, and every correction goes back through the main session. It
 * answers "where are we and whose turn is it" at a glance; what a ticket says
 * is read in its panel, one click away.
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
}) {
  // What the reader is pointing at, which is what its arrows are shown for. The
  // selection stands in when nothing is pointed at, so a ticket opened from the
  // waiting indicator arrives with its own edges already told apart.
  const [pointed, setPointed] = useState<string | null>(null);

  if (graph.tickets.length === 0) {
    return (
      <p className="empty">
        Aucun ticket. Le graphe naît quand la session principale écrit le découpage.
      </p>
    );
  }

  const layout = layOutGraph(graph);
  const readyCount = frontier(graph).length;
  const shortNames = shortRepositoryLabels(repositoryNames);
  const focused = pointed ?? selectedId;

  return (
    <>
      <Legend readyCount={readyCount} />
      <div className="graph__viewport">
        <div
          className="graph"
          data-focused={focused === null ? undefined : "true"}
          style={{ width: layout.width, height: layout.height }}
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
                data-kind={ticket.kind}
                data-family={family}
                data-state={ticket.state}
                data-selected={ticket.id === selectedId ? "true" : undefined}
                aria-current={ticket.id === selectedId}
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
                onFocus={() => setPointed(ticket.id)}
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
function Legend({ readyCount }: { readyCount: number }) {
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
      </span>
    </p>
  );
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
