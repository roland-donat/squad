import type { AgentSessionOutcome } from "../shared/api";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";

export interface MainSessionDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  /** Resolved late: squad only knows its own address once it is listening. */
  mcpUrl: () => string;
}

/**
 * The main session of a feature: one thread, alive from the spec to the merge,
 * which is where the graph is written and where questions are settled. Squad
 * holds at most one per feature, so a second `/to-tickets` cannot start writing
 * over the one already running.
 */
export class MainSessions {
  private readonly running = new Map<string, AgentSession>();

  constructor(private readonly dependencies: MainSessionDependencies) {}

  async start(featureId: string, prompt: string): Promise<AgentSession> {
    const { store, bus, launcher, mcpUrl } = this.dependencies;
    const feature = store.requireFeature(featureId);
    if (this.running.has(feature.id)) {
      throw new SquadError(
        "main_session_already_running",
        409,
        `the main session of feature ${feature.id} is already running`,
      );
    }
    const project = store.requireProject(feature.projectId);

    const session = await launcher.open({
      role: "main",
      featureId: feature.id,
      workingDirectory: project.path,
      mcpUrl: mcpUrl(),
    });
    this.running.set(feature.id, session);
    bus.publish({ type: "main-session-started", featureId: feature.id, sessionId: session.id });
    // Drained before the prompt goes in, so nothing the session says on its way
    // up can be emitted into an audience that is not listening yet.
    void this.drain(feature.id, session);
    await session.send(prompt);
    return session;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((session) => session.stop()));
  }

  private async drain(featureId: string, session: AgentSession): Promise<void> {
    const { bus } = this.dependencies;
    let outcome: AgentSessionOutcome = "completed";
    let detail: string | undefined;
    try {
      for await (const event of session.events()) {
        if (event.type === "ended") {
          outcome = event.outcome;
          detail = event.detail;
        }
      }
    } catch (failure) {
      outcome = "failed";
      detail = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.running.delete(featureId);
      bus.publish({
        type: "main-session-ended",
        featureId,
        sessionId: session.id,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });
    }
  }
}
