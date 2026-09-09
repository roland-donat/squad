import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * The pan and zoom of the map, written here rather than taken from a library.
 * React Flow does not produce this layout, does not draw these nodes and would
 * impose its own data model; d3-zoom would settle the trackpad's odd cases, for
 * a hundred lines on a closed problem, in a project with no interface
 * dependency beyond React. What we take on in exchange is spelled out below.
 *
 * The framing is never persisted: squad's address says what is being watched,
 * not where the eye rests, and a link carrying a framing would be wrong by the
 * next ticket. It is redone when the feature changes and at no other time, so a
 * ticket the main session writes never moves the view of whoever is reading.
 */

export interface Frame {
  scale: number;
  x: number;
  y: number;
}

export const minScale = 0.25;
export const maxScale = 2.5;
/** Never magnified on opening, and never shrunk past the point the rings stop reading. */
const fitFloor = 0.5;
const fitCeiling = 1;
const margin = 24;

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function useViewport({
  contentWidth,
  contentHeight,
  resetKey,
  /** How much of the viewport's right edge the ticket drawer covers, in screen pixels. */
  obstructedRight,
  /** How much of its bottom edge the thread drawer covers, likewise. */
  obstructedBottom,
}: {
  contentWidth: number;
  contentHeight: number;
  resetKey: string;
  obstructedRight: number;
  obstructedBottom: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame>({ scale: 1, x: 0, y: 0 });
  // Read by the handlers, which are attached once and would otherwise close
  // over the frame they were created with.
  const current = useRef(frame);
  current.current = frame;
  const content = useRef({ width: contentWidth, height: contentHeight });
  content.current = { width: contentWidth, height: contentHeight };
  const obstruction = useRef(obstructedRight);
  obstruction.current = obstructedRight;
  const obstructionBottom = useRef(obstructedBottom);
  obstructionBottom.current = obstructedBottom;
  const touched = useRef(false);

  const fit = useCallback(() => {
    touched.current = false;
    const box = viewport.current?.getBoundingClientRect();
    const { width, height } = content.current;
    if (!box || width === 0 || height === 0) return;
    // What is actually visible, the drawers being laid over the viewport
    // rather than beside it: framing on the whole box would centre the map half
    // underneath them.
    const available = box.width - obstruction.current;
    // Floored, the drawer being allowed a share of the window while this is a
    // share of the map: a drawer taller than the map left would otherwise frame
    // it on a negative height, which is to say entirely underneath the drawer.
    const availableHeight = Math.max(2 * margin + 1, box.height - obstructionBottom.current);
    const scale = Math.min(
      fitCeiling,
      Math.max(
        fitFloor,
        Math.min((available - 2 * margin) / width, (availableHeight - 2 * margin) / height),
      ),
    );
    setFrame({
      scale,
      x: Math.max(margin, (available - width * scale) / 2),
      y: Math.max(margin, (availableHeight - height * scale) / 2),
    });
  }, []);

  /**
   * Whether the reader has moved the map themselves. What must never happen is
   * squad moving it under someone who placed it; following a graph nobody has
   * touched is another matter, and it is the ordinary case: a feature is opened
   * before its graph exists, and the main session then writes it ticket by
   * ticket. Framing once on the first ticket to arrive would leave the map
   * framed on a graph that no longer exists.
   *
   * So: the framing follows the graph until the first gesture, and stops for
   * good afterwards. Recentring hands it back, which is what makes that button
   * a way out rather than a one-off.
   */
  const framedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (contentWidth === 0 || contentHeight === 0) return;
    if (framedFor.current !== resetKey) {
      framedFor.current = resetKey;
      touched.current = false;
    } else if (touched.current) {
      return;
    }
    fit();
    // Whether a drawer is there, not how wide it is: opening or closing one
    // changes what is visible and a map nobody has placed is framed again on
    // what is left, but pulling its edge must not reframe the map at every
    // pointer move, which would make it jump for the whole gesture. A map
    // somebody has placed is not touched at all, which is the whole rule.
  }, [fit, resetKey, contentWidth, contentHeight, obstructedRight > 0, obstructedBottom > 0]);

  const zoomTo = useCallback((scale: number, anchorX: number, anchorY: number) => {
    setFrame((from) => {
      const to = Math.min(maxScale, Math.max(minScale, scale));
      const ratio = to / from.scale;
      return {
        scale: to,
        x: anchorX - (anchorX - from.x) * ratio,
        y: anchorY - (anchorY - from.y) * ratio,
      };
    });
  }, []);

  /** Zoom from the keyboard, which has no pointer: the middle of what is visible. */
  const zoomBy = useCallback(
    (factor: number) => {
      const box = viewport.current?.getBoundingClientRect();
      if (!box) return;
      const visible = box.width - obstruction.current;
      const visibleHeight = box.height - obstructionBottom.current;
      zoomTo(current.current.scale * factor, visible / 2, visibleHeight / 2);
    },
    [zoomTo],
  );

  /**
   * The wheel zooms without a modifier, which is what one asks of a map and
   * what the fixed-height shell makes possible: nothing behind it scrolls. The
   * cost is taken knowingly: a trackpad's two-finger scroll arrives as a wheel
   * event too, so it zooms, and nothing tells the two apart reliably.
   */
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touched.current = true;
      const box = element.getBoundingClientRect();
      if (event.shiftKey) {
        const along = event.deltaX !== 0 ? event.deltaX : event.deltaY;
        setFrame((from) => ({ ...from, x: from.x - along }));
        return;
      }
      // A pinch on a trackpad arrives as a wheel event with `ctrlKey`, so both
      // land on the same gesture rather than on two.
      zoomTo(
        current.current.scale * Math.exp(-event.deltaY * 0.0015),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    };
    // React attaches its wheel listeners passively, and a passive listener
    // cannot call preventDefault: without this the browser would zoom the page
    // underneath.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  /**
   * Dragging the background moves the map. A press that travels less than four
   * pixels was a click on nothing, and that is what clears the selection: it is
   * the only gesture that makes closing what is open obvious.
   */
  const dragging = useRef<{ pointerId: number; fromX: number; fromY: number; travelled: number } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".node")) return;
    touched.current = true;
    dragging.current = {
      pointerId: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      travelled: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.fromX;
    const dy = event.clientY - drag.fromY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    drag.fromX = event.clientX;
    drag.fromY = event.clientY;
    setFrame((from) => ({ ...from, x: from.x + dx, y: from.y + dy }));
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, onEmptyClick: () => void) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.travelled < 4) onEmptyClick();
  }, []);

  /**
   * Brings a box of the map into what is actually visible, by the smallest
   * translation that does it and without touching the scale: the zoom belongs
   * to the reader. Used when the drawer opens over the node just clicked, and
   * when the keyboard walks to a node that is off screen.
   */
  const bringIntoView = useCallback((box: ContentBox) => {
    const viewportBox = viewport.current?.getBoundingClientRect();
    if (!viewportBox) return;
    setFrame((from) => {
      const left = from.x + box.x * from.scale;
      const top = from.y + box.y * from.scale;
      const right = left + box.width * from.scale;
      const bottom = top + box.height * from.scale;
      const visibleRight = viewportBox.width - obstruction.current - margin;
      const visibleBottom = viewportBox.height - obstructionBottom.current - margin;
      let { x, y } = from;
      if (right > visibleRight) x -= right - visibleRight;
      if (left + (x - from.x) < margin) x += margin - (left + (x - from.x));
      if (bottom > visibleBottom) y -= bottom - visibleBottom;
      if (top + (y - from.y) < margin) y += margin - (top + (y - from.y));
      return x === from.x && y === from.y ? from : { ...from, x, y };
    });
  }, []);

  return { viewport, frame, fit, zoomBy, bringIntoView, onPointerDown, onPointerMove, endDrag };
}
