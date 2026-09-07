import type { AgentSessionOutcome, MainSession, ThreadEntry } from "../shared/api";
import { mainSessionBriefing } from "./agents/briefing";
import type { AgentEvent, AgentLauncher, AgentSession } from "./agents/launcher";
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
 *
 * Nothing here manages the session's context. The main session is long lived by
 * design and relies on claude-code's own automatic compaction; squad neither
 * triggers one nor works around it, so there is one place where that happens and
 * it is not this one.
 */
export class MainSessions {
  private readonly running = new Map<string, AgentSession>();

  constructor(private readonly dependencies: MainSessionDependencies) {}

  /** The sessions squad is holding open, which lives here and nowhere else. */
  list(): MainSession[] {
    return [...this.running].map(([featureId, session]) => ({
      featureId,
      sessionId: session.id,
    }));
  }

  async start(featureId: string, prompt?: string): Promise<AgentSession> {
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
      briefing: mainSessionBriefing(feature),
    });
    this.running.set(feature.id, session);
    bus.publish({ type: "main-session-started", featureId: feature.id, sessionId: session.id });
    // Drained before the prompt goes in, so nothing the session says on its way
    // up can be emitted into an audience that is not listening yet.
    void this.drain(feature.id, session);
    if (prompt !== undefined) await this.hand(feature.id, session, prompt);
    return session;
  }

  /** Hands a message from the developer to the session that is running. */
  async send(featureId: string, text: string): Promise<void> {
    const { store } = this.dependencies;
    const feature = store.requireFeature(featureId);
    const session = this.running.get(feature.id);
    if (!session) {
      throw new SquadError(
        "main_session_not_running",
        409,
        `the main session of feature ${feature.id} is not running`,
      );
    }
    await this.hand(feature.id, session, text);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((session) => session.stop()));
  }

  /**
   * Writes the message on the thread before handing it over, so what the
   * developer typed is on the record even if the session dies reading it.
   */
  private async hand(featureId: string, session: AgentSession, text: string): Promise<void> {
    this.append(featureId, session.id, { kind: "pilot", text });
    await session.send(text);
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
          continue;
        }
        this.append(featureId, session.id, lineOf(event));
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

  private append(
    featureId: string,
    sessionId: string,
    line: { kind: ThreadEntry["kind"]; text: string; detail?: string | null },
  ): void {
    const { store, bus } = this.dependencies;
    const entry = store.appendThreadEntry({ featureId, sessionId, ...line });
    bus.publish({ type: "thread-appended", entry });
  }
}

/** What one event of a session becomes on its thread. */
function lineOf(
  event: Exclude<AgentEvent, { type: "ended" }>,
): { kind: ThreadEntry["kind"]; text: string; detail?: string | null } {
  switch (event.type) {
    case "text":
      return { kind: "agent", text: event.text };
    case "tool-call":
      return {
        kind: "tool",
        text: event.tool,
        detail: event.input === undefined ? null : JSON.stringify(event.input, null, 2),
      };
    case "notice":
      return { kind: "notice", text: event.text, detail: event.detail ?? null };
  }
}
