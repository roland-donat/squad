/**
 * Where the interface is, said as an address.
 *
 * The selection used to live in the component's state, and was therefore
 * unaddressable: a reload lost it, two tabs could not watch two projects, and
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
 */
export interface Selection {
  /** Null means the address names no project, and the first registered one shows. */
  projectId: string | null;
  featureId: string | null;
  ticketId: string | null;
}

export interface PilotingRoute extends Selection {
  screen: "piloting";
}

export type Route = { screen: "settings" } | PilotingRoute;

/** The piloting screen, on the selection given and on nothing else. */
export function piloting(selection: Partial<Selection> = {}): PilotingRoute {
  return {
    screen: "piloting",
    projectId: selection.projectId ?? null,
    featureId: selection.featureId ?? null,
    ticketId: selection.ticketId ?? null,
  };
}

/**
 * What a path names. A path that does not have this shape names nothing rather
 * than something approaching: half of an address is not a selection, and the
 * screen corrects what it could not honour as soon as it knows the state.
 */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 1 && segments[0] === "settings") return { screen: "settings" };

  const [projectsWord, projectId, featuresWord, featureId, ticketsWord, ticketId] = segments;
  if (projectsWord !== "projects" || projectId === undefined) return piloting();
  const project = decodeURIComponent(projectId);
  if (segments.length === 2) return piloting({ projectId: project });

  if (featuresWord !== "features" || featureId === undefined) {
    return piloting({ projectId: project });
  }
  const feature = decodeURIComponent(featureId);
  if (segments.length === 4) return piloting({ projectId: project, featureId: feature });

  if (segments.length !== 6 || ticketsWord !== "tickets" || ticketId === undefined) {
    return piloting({ projectId: project, featureId: feature });
  }
  return {
    screen: "piloting",
    projectId: project,
    featureId: feature,
    ticketId: decodeURIComponent(ticketId),
  };
}

/** The address of a route, which is what the location bar shows. */
export function routePath(route: Route): string {
  if (route.screen === "settings") return "/settings";
  const segments: string[] = [];
  if (route.projectId !== null) {
    segments.push("projects", encodeURIComponent(route.projectId));
    // Nested rather than listed side by side: a feature is a feature of a
    // project, and a ticket a ticket of a feature. An address that named a
    // feature under no project could not be read back into a selection.
    if (route.featureId !== null) {
      segments.push("features", encodeURIComponent(route.featureId));
      if (route.ticketId !== null) segments.push("tickets", encodeURIComponent(route.ticketId));
    }
  }
  return `/${segments.join("/")}`;
}
