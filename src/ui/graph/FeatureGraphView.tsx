import type { FeatureGraph, Ticket, TicketKind, TicketState } from "../../shared/api";
import { frontier } from "../../shared/graph";
import { layOutGraph, nodeHeight, nodeWidth } from "./layout";

/**
 * The graph, read-only at the gesture: no node moves, no edge is drawn by hand,
 * and every correction goes back through the main session. Kind and state are
 * spelled out on each node rather than coded by colour alone, so the graph reads
 * the same in greyscale and without clicking anything.
 */

const kindLabels: Record<TicketKind, string> = {
  build: "construction",
  decision: "décision",
  fix: "correction",
};

const stateLabels: Record<TicketState, string> = {
  blocked: "bloqué",
  ready: "prêt",
  "awaiting-decision": "à trancher",
  merged: "fusionné",
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

export function FeatureGraphView({ graph }: { graph: FeatureGraph }) {
  if (graph.tickets.length === 0) {
    return (
      <p className="empty">
        Aucun ticket. Le graphe naît quand la session principale écrit le découpage.
      </p>
    );
  }

  const layout = layOutGraph(graph);
  const readyCount = frontier(graph).length;

  return (
    <>
      <Legend readyCount={readyCount} />
      <div className="graph__viewport">
        <div className="graph" style={{ width: layout.width, height: layout.height }}>
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
                d={curve(from, to)}
                markerEnd="url(#graph-arrow)"
              />
            ))}
          </svg>

          {layout.nodes.map(({ ticket, x, y }) => (
            <article
              key={ticket.id}
              className="node"
              data-kind={ticket.kind}
              data-state={ticket.state}
              style={{ left: x, top: y, width: nodeWidth, minHeight: nodeHeight }}
              aria-label={`${ticket.title}, ${kindLabels[ticket.kind]}, ${stateLabel(ticket)}`}
            >
              <p className="node__title">{ticket.title}</p>
              <p className="node__chips">
                <span className="chip chip--kind">{kindLabels[ticket.kind]}</span>
                <span className="chip chip--state">{stateLabel(ticket)}</span>
              </p>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}

function Legend({ readyCount }: { readyCount: number }) {
  return (
    <p className="graph__legend">
      Les flèches se lisent « doit être fusionné avant ». La <strong>frontière</strong>, en
      relief, est ce qui peut partir maintenant : {readyCount}{" "}
      {readyCount > 1 ? "tickets prêts" : "ticket prêt"}.
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
