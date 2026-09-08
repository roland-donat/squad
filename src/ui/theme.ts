import type { Theme } from "../shared/api";

/**
 * Where the copy of the theme is kept for the next first paint. Read by the
 * bootstrap script in `index.html` before React mounts, written here whenever
 * squad says what is in force.
 */
const mirrorKey = "squad.theme";

/**
 * Puts the theme squad holds on the page, and leaves a copy for the next load.
 *
 * `system` writes no attribute at all rather than an attribute meaning "no
 * choice": the browser then decides, and goes on deciding when its own setting
 * changes, which an attribute frozen at load time would not do.
 *
 * The base is the source of truth, this is a cache of it. Nothing reads the
 * cache back into squad, so a stale copy can only cost one repaint, never a
 * wrong setting.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(mirrorKey, theme);
  } catch {
    // Storage turned off: the theme still applies, only the next first paint
    // starts from the browser's setting before this runs again.
  }
}
