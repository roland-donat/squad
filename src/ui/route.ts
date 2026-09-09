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

/** The address as the browser holds it, path and query together. */
function currentAddress(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The route on screen, which follows the address whoever changed it. */
export function useRoute(): Route {
  const address = useSyncExternalStore(subscribe, currentAddress);
  const [pathname, search] = splitAddress(address);
  return parseRoute(pathname, search);
}

function splitAddress(address: string): [string, string] {
  const mark = address.indexOf("?");
  return mark === -1 ? [address, ""] : [address.slice(0, mark), address.slice(mark)];
}

/**
 * Puts the address into the shape squad writes today, without going anywhere:
 * `/projects/<p>/features/<f>` still names a feature, and is still read, but it
 * is not what squad writes any more, and leaving it in the location bar would
 * let it be bookmarked again.
 *
 * Read off the live address rather than off a parsed route held in a render:
 * the two differ for as long as a move is in flight, and rewriting from a stale
 * one would undo that move. Nothing is announced, since what the address names
 * is unchanged: only how it spells it.
 */
export function normaliseAddress(): void {
  const address = currentAddress();
  const [pathname, search] = splitAddress(address);
  const canonical = routePath(parseRoute(pathname, search));
  if (canonical !== address) window.history.replaceState(null, "", canonical);
}

/**
 * Goes to a route. `replace` is for a move the developer did not make: the
 * screen correcting an address that named something gone leaves no step to walk
 * back to. A move to where we already are is not a move, and pushes nothing.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (path === currentAddress()) return;
  if (options.replace === true) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of [...listeners]) listener();
}
