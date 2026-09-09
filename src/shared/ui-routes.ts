/**
 * Where the interface is, said as an address.
 *
 * The selection used to live in the component's state, and was therefore
 * unaddressable: a reload lost it, two tabs could not watch two features, and
 * nothing could ever link to what an alert was about. It lives in the URL
 * instead, so the browser's own tabs, history and back button work on squad
 * without squad implementing any of them.
 *
 * Shared because both sides need it: the screen reads an address to know what
 * to show, and the server writes one into an alert so what it reports can be
 * opened. The routes of the API are another thing entirely, and live in
 * `api.ts`.
 *
 * The segments are in English like those API routes, and the identifiers are
 * the API's own: an address is a technical identifier, not interface text.
 *
 * A project is no longer a level of navigation. Features are listed flat,
 * whatever project they hang on, because a project is an attribute of a feature
 * rather than a place one works in: a feature carries several repositories, so
 * filing it under one of them was already an approximation.
 */

/** What a feature screen is showing: one feature, and what is open on it. */
export interface FeatureSelection {
  featureId: string;
  /** Null means no ticket is open, and the graph has the width to itself. */
  ticketId: string | null;
  /**
   * Whether the main session's drawer is open. In the address rather than in a
   * component, and a query rather than a path segment: the drawer is orthogonal
   * to the ticket panel, so both can be open at once, which a path could not
   * say. It is what lets an alert about a question link to a place where that
   * question can actually be answered.
   */
  threadOpen: boolean;
}

export interface FeatureRoute extends FeatureSelection {
  screen: "feature";
}

export type Route =
  | { screen: "home" }
  | { screen: "new-feature" }
  | { screen: "settings" }
  | FeatureRoute;

/** The home screen, which lists every feature squad drives. */
export const home = (): Route => ({ screen: "home" });

/** The feature screen, on the selection given and on nothing else. */
export function feature(
  featureId: string,
  selection: Partial<Omit<FeatureSelection, "featureId">> = {},
): FeatureRoute {
  return {
    screen: "feature",
    featureId,
    ticketId: selection.ticketId ?? null,
    threadOpen: selection.threadOpen ?? false,
  };
}

/** The word that opens the drawer, and the only value the query is read for. */
const threadOpenValue = "open";

/**
 * What a path names. A path that does not have this shape names nothing rather
 * than something approaching: half of an address is not a selection, and the
 * screen sends what it could not honour back to the home screen as soon as it
 * knows the state.
 *
 * Addresses of the shape squad used to write, `/projects/<p>/features/<f>`, are
 * still read: alerts carrying them have been sent, they are read on a phone
 * days later, and a link that lands nowhere is a link squad broke. The project
 * segment is dropped, the feature being enough to name what the alert was about.
 */
export function parseRoute(pathname: string, search = ""): Route {
  const threadOpen = new URLSearchParams(search).get("thread") === threadOpenValue;
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return home();
  if (segments.length === 1 && segments[0] === "settings") return { screen: "settings" };
  // The old shape, read for what it still says: the project it names is not a
  // level of navigation any more, so it is read past rather than honoured.
  const flat = segments[0] === "projects" ? segments.slice(2) : segments;
  if (flat.length === 0 || flat[0] !== "features") return home();

  const [, featureId, ticketsWord, ticketId] = flat;
  if (featureId === undefined) return home();
  // Before the identifier, since this is the one feature address that names no
  // feature. Identifiers are generated, so no feature can answer to this word.
  if (featureId === "new" && flat.length === 2) return { screen: "new-feature" };
  const opened = decodeURIComponent(featureId);
  if (flat.length === 2) return feature(opened, { threadOpen });

  if (flat.length !== 4 || ticketsWord !== "tickets" || ticketId === undefined) {
    return feature(opened, { threadOpen });
  }
  return feature(opened, { ticketId: decodeURIComponent(ticketId), threadOpen });
}

/** The address of a route, which is what the location bar shows. */
export function routePath(route: Route): string {
  if (route.screen === "home") return "/";
  if (route.screen === "settings") return "/settings";
  if (route.screen === "new-feature") return "/features/new";
  // Nested rather than listed side by side: a ticket is a ticket of a feature,
  // and an address naming a ticket under no feature could not be read back.
  const path =
    route.ticketId === null
      ? `/features/${encodeURIComponent(route.featureId)}`
      : `/features/${encodeURIComponent(route.featureId)}/tickets/${encodeURIComponent(route.ticketId)}`;
  return route.threadOpen ? `${path}?thread=${threadOpenValue}` : path;
}
