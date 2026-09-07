import { useEffect, useState } from "react";
import { apiRoutes, type Feature, type Project, type SquadEvent } from "../shared/api";

export interface SquadState {
  projects: Project[];
  features: Feature[];
  connected: boolean;
}

/**
 * The displayed state comes entirely from the event stream: the first message of
 * a connection carries the whole snapshot, the following ones carry changes. The
 * interface therefore issues no read request and has nothing to refresh.
 */
export function useSquadState(): SquadState {
  const [state, setState] = useState<SquadState>({
    projects: [],
    features: [],
    connected: false,
  });

  useEffect(() => {
    const source = new EventSource(apiRoutes.events);

    source.addEventListener("open", () => {
      setState((current) => ({ ...current, connected: true }));
    });
    source.addEventListener("error", () => {
      setState((current) => ({ ...current, connected: false }));
    });
    source.addEventListener("message", (message) => {
      const event = JSON.parse(message.data as string) as SquadEvent;
      setState((current) => ({ ...apply(current, event), connected: true }));
    });

    return () => source.close();
  }, []);

  return state;
}

function apply(state: SquadState, event: SquadEvent): SquadState {
  switch (event.type) {
    case "snapshot":
      return { ...state, projects: event.projects, features: event.features };
    case "project-registered":
      return { ...state, projects: [...state.projects, event.project] };
    case "feature-opened":
      return { ...state, features: [...state.features, event.feature] };
  }
}
