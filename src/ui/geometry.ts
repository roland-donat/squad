import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The sizes the developer gave the panels, kept in the browser and never sent
 * to squad.
 *
 * Deliberately not a setting. What squad is configured with lives in its
 * database and comes back on the event stream, because squad itself reads it:
 * the theme decides what the server paints before React mounts, a concurrency
 * cap decides what it launches. A panel width decides nothing squad does. It is
 * also legitimately different from one window to the next, so holding it in one
 * place would make two windows of two sizes fight over a single value.
 */

/** A size held across reloads, in pixels, under a key of its own. */
export function useStoredSize(key: string, fallback: number): [number, (size: number) => void] {
  const [size, setSize] = useState(() => read(key) ?? fallback);
  // Read again when the key changes, which is what happens when the drawer of
  // one feature is replaced by the drawer of another in the same tab.
  useEffect(() => setSize(read(key) ?? fallback), [key, fallback]);
  const keep = useCallback(
    (next: number) => {
      setSize(next);
      try {
        window.localStorage.setItem(key, String(Math.round(next)));
      } catch {
        // A browser refusing storage costs the size at the next reload and
        // nothing else: it must not take the screen down with it.
      }
    },
    [key],
  );
  return [size, keep];
}

function read(key: string): number | null {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Drags a handle and turns the pointer's travel into a size. The pointer is
 * captured on the handle, so the drag survives the pointer leaving it, which is
 * exactly what happens when one pulls faster than the panel follows.
 */
export function useDragSize({
  size,
  onSize,
  axis,
  min,
  max,
}: {
  size: number;
  onSize: (size: number) => void;
  /** Which way the size grows as the pointer moves against it. */
  /** The only axis there is: the session bar is pulled from its left edge. */
  axis: "width-from-right";
  min: number;
  max: () => number;
}): { onPointerDown: (event: React.PointerEvent<HTMLElement>) => void } {
  const from = useRef<{ start: number; size: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      from.current = {
        start: axis === "width-from-right" ? event.clientX : event.clientY,
        size,
      };
      const handle = event.currentTarget;
      const move = (moved: PointerEvent) => {
        const origin = from.current;
        if (origin === null) return;
        const travel =
          axis === "width-from-right"
            ? origin.start - moved.clientX
            : origin.start - moved.clientY;
        onSize(Math.min(max(), Math.max(min, origin.size + travel)));
      };
      const stop = () => {
        from.current = null;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    },
    [axis, max, min, onSize, size],
  );

  return { onPointerDown };
}

/** Whether a media query holds right now, and whenever it stops holding. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listen = () => setMatches(media.matches);
    listen();
    media.addEventListener("change", listen);
    return () => media.removeEventListener("change", listen);
  }, [query]);
  return matches;
}
