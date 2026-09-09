import type { TicketKind } from "../../shared/api";

/**
 * The marks a node carries. A kind never changes, so it takes the stable mark,
 * a filled silhouette read at a glance; a state changes several times an hour,
 * so it takes the ring drawn around the node, which is restyled without
 * redrawing anything. Both are shapes before they are colours: the map keeps
 * its meaning in greyscale, which is the rule the project holds itself to.
 */

export function KindGlyph({ kind }: { kind: TicketKind }) {
  return (
    <svg
      className="node__glyph"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "build" && <rect x="1" y="1" width="10" height="10" rx="1" />}
      {/* The flowchart diamond, on the node's mark rather than on its outline:
          a diamond-shaped node carries two lines of title very badly. */}
      {kind === "decision" && <path d="M 6 0.5 L 11.5 6 L 6 11.5 L 0.5 6 Z" />}
      {kind === "fix" && <path d="M 6 1 L 11.5 11 L 0.5 11 Z" />}
    </svg>
  );
}

/** Settled, and holding nothing back any more. */
export function SettledGlyph() {
  return (
    <svg
      className="node__settled"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M 1.5 6.5 L 4.5 9.5 L 10.5 2.5" fill="none" strokeWidth="2" stroke="currentColor" />
    </svg>
  );
}
