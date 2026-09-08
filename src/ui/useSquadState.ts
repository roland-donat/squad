import { useEffect, useState } from "react";
import {
  apiRoutes,
  defaultConcurrencyCaps,
  defaultGenerationDepthCap,
  type Feature,
  type FeatureGraph,
  type MainSession,
  type Project,
  type Question,
  type Settings,
  type SquadEvent,
  type ThreadEntry,
} from "../shared/api";

export interface SquadState {
  projects: Project[];
  features: Feature[];
  graphs: FeatureGraph[];
  threads: ThreadEntry[];
  /** Every question ever asked, the ones still waiting among them. */
  questions: Question[];
  /** The main sessions running right now, one per feature at most. */
  mainSessions: MainSession[];
  /** What squad is configured with, as the settings screen edits it. */
  settings: Settings;
  connected: boolean;
  /**
   * Whether the first snapshot has arrived. Before it, squad has said nothing
   * of what it holds, so an address naming a feature is indistinguishable from
   * one naming a feature that no longer exists: what reads the state to correct
   * the address waits for this.
   */
  loaded: boolean;
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
    questions: [],
    mainSessions: [],
    // What is shown until the first snapshot arrives, which is the very first
    // message of the connection: nothing is read from here afterwards.
    settings: {
      webhookUrl: null,
      desktopNotifications: true,
      machineConcurrencyCap: defaultConcurrencyCaps.machine,
      generationDepthCap: defaultGenerationDepthCap,
    },
    connected: false,
    loaded: false,
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

/** The thread of a ticket's sub-session, oldest line first. */
export function ticketThreadOf(state: SquadState, ticketId: string): ThreadEntry[] {
  return state.threads.filter((entry) => entry.ticketId === ticketId);
}

/** The questions of a ticket, oldest first, answered ones included. */
export function ticketQuestionsOf(state: SquadState, ticketId: string): Question[] {
  return state.questions.filter((question) => question.ticketId === ticketId);
}

/** The questions of a feature's main session, which hang on no ticket. */
export function featureQuestionsOf(state: SquadState, featureId: string): Question[] {
  return state.questions.filter(
    (question) => question.featureId === featureId && question.ticketId === null,
  );
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
        questions: event.questions,
        mainSessions: event.mainSessions,
        settings: event.settings,
        loaded: true,
      };
    case "project-registered":
      return { ...state, projects: [...state.projects, event.project] };
    case "project-changed":
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === event.project.id ? event.project : project,
        ),
      };
    case "feature-opened":
      return { ...state, features: [...state.features, event.feature] };
    case "feature-changed":
      return {
        ...state,
        features: state.features.map((feature) =>
          feature.id === event.feature.id ? event.feature : feature,
        ),
      };
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
    case "question-changed":
      // Held in place rather than appended: asked, answered and abandoned are
      // the same question, and the interface shows where it stands now.
      return {
        ...state,
        questions: state.questions.some((question) => question.id === event.question.id)
          ? state.questions.map((question) =>
              question.id === event.question.id ? event.question : question,
            )
          : [...state.questions, event.question],
      };
    case "settings-changed":
      return { ...state, settings: event.settings };
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
