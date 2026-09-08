import { useSyncExternalStore } from "react";
import { parseRoute, routePath, type Route } from "../shared/ui-routes";

/**
 * Everything watching the address. The browser only tells us about the moves it
 * makes itself, so the ones squad makes are announced here.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** The route on screen, which follows the address whoever changed it. */
export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, () => window.location.pathname));
}

/**
 * Goes to a route. `replace` is for a move the developer did not make: the
 * screen correcting an address that named something gone leaves no step to walk
 * back to. A move to where we already are is not a move, and pushes nothing.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (path === window.location.pathname) return;
  if (options.replace === true) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of [...listeners]) listener();
}
