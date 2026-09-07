import { useEffect, useState } from "react";
import {
  apiRoutes,
  type Feature,
  type FeatureGraph,
  type MainSession,
  type Project,
  type SquadEvent,
  type ThreadEntry,
} from "../shared/api";

export interface SquadState {
  projects: Project[];
  features: Feature[];
  graphs: FeatureGraph[];
  threads: ThreadEntry[];
  /** The main sessions running right now, one per feature at most. */
  mainSessions: MainSession[];
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
    graphs: [],
    threads: [],
    mainSessions: [],
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

/** The graph of a feature, empty as long as no ticket has been written on it. */
export function graphOf(state: SquadState, featureId: string): FeatureGraph {
  return (
    state.graphs.find((graph) => graph.featureId === featureId) ?? {
      featureId,
      tickets: [],
      edges: [],
    }
  );
}

/** The thread of a feature's main session, oldest line first. */
export function threadOf(state: SquadState, featureId: string): ThreadEntry[] {
  return state.threads.filter((entry) => entry.featureId === featureId && entry.ticketId === null);
}

/** Whether a feature's main session is running, and can therefore be written to. */
export function isMainSessionRunning(state: SquadState, featureId: string): boolean {
  return state.mainSessions.some((session) => session.featureId === featureId);
}

function apply(state: SquadState, event: SquadEvent): SquadState {
  switch (event.type) {
    case "snapshot":
      return {
        ...state,
        projects: event.projects,
        features: event.features,
        graphs: event.graphs,
        threads: event.threads,
        mainSessions: event.mainSessions,
      };
    case "project-registered":
      return { ...state, projects: [...state.projects, event.project] };
    case "feature-opened":
      return { ...state, features: [...state.features, event.feature] };
    case "graph-changed":
      // The whole graph of the feature arrives at once: one added edge can flip
      // the state of tickets it does not touch, so replacing beats patching.
      return {
        ...state,
        graphs: [
          ...state.graphs.filter((graph) => graph.featureId !== event.graph.featureId),
          event.graph,
        ],
      };
    case "thread-appended":
      return { ...state, threads: [...state.threads, event.entry] };
    case "main-session-started":
      return {
        ...state,
        mainSessions: [
          ...state.mainSessions,
          { featureId: event.featureId, sessionId: event.sessionId },
        ],
      };
    case "main-session-ended":
      return {
        ...state,
        mainSessions: state.mainSessions.filter(
          (session) => session.sessionId !== event.sessionId,
        ),
      };
  }
}
