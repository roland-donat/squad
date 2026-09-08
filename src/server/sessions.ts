import type { MainSession, RecordedSession } from "../shared/api";
import { mainSessionBriefing } from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";
import { appendToThread, drainSession, type ThreadLine } from "./threads";

export interface MainSessionDependencies {
  store: Store;
  bus: EventBus;
  launcher: AgentLauncher;
  /**
   * What a session was waiting on, declared by what is needed of it: a session
   * that has ended cannot read an answer, so its question is let go of rather
   * than left in front of the developer.
   */
  questions: { abandonFor(sessionId: string): void };
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
  // Held so shutdown can wait for them: a drain still writing when the database
  // closes loses the last thing the session had to say, which is exactly the
  // line worth keeping when a session died rather than finished.
  private readonly draining = new Set<Promise<void>>();

  constructor(private readonly dependencies: MainSessionDependencies) {}

  /** The sessions squad is holding open, which lives here and nowhere else. */
  list(): MainSession[] {
    return [...this.running].map(([featureId, session]) => ({
      featureId,
      sessionId: session.id,
    }));
  }

  /**
   * The session holding a feature's main thread, or null when none is open. It
   * is what a question asked outside any ticket is written on: squad names the
   * session itself rather than taking one from whoever calls.
   */
  sessionIdOf(featureId: string): string | null {
    return this.running.get(featureId)?.id ?? null;
  }

  /**
   * Opens the main session of a feature, blank or resumed. Resumed, it answers
   * to the id of the conversation it continues: the thread of this feature is
   * that conversation carrying on, not a second one beside it.
   */
  async start(
    featureId: string,
    options: { prompt?: string; resume?: RecordedSession } = {},
  ): Promise<AgentSession> {
    const { prompt, resume } = options;
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
      ...(resume === undefined ? {} : { resumeSessionId: resume.id }),
      // Every repository the feature carries, home first: a session that was
      // not told them cannot write a ticket for one of them.
      briefing: mainSessionBriefing(
        feature,
        feature.repositories.map((carried) => store.requireProject(carried.projectId)),
      ),
    });
    this.running.set(feature.id, session);
    bus.publish({ type: "main-session-started", featureId: feature.id, sessionId: session.id });
    if (resume !== undefined) {
      // On the thread, because it is the one thing the developer cannot see for
      // themselves: what looks like an empty thread is a conversation squad did
      // not write and will not repeat. Where it lives is said, not copied.
      this.append(feature.id, session.id, {
        kind: "notice",
        text: "the main session was resumed from a recorded conversation",
        detail: [
          `recorded in ${resume.cwd}${resume.branch === null ? "" : ` on ${resume.branch}`}`,
          `last written to on ${resume.recordedAt}, ${Math.round(resume.bytes / 1024)} kB`,
          "what was said in it is not repeated here: claude-code keeps it, and this session remembers it",
        ].join("\n"),
      });
    }
    // Drained before the prompt goes in, so nothing the session says on its way
    // up can be emitted into an audience that is not listening yet.
    const drained = this.drain(feature.id, session);
    this.draining.add(drained);
    void drained.then(() => this.draining.delete(drained));
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
    await Promise.all([...this.draining]);
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
    const { outcome, detail } = await drainSession(session, (line) =>
      this.append(featureId, session.id, line),
    );
    this.running.delete(featureId);
    // A question this session was blocked on has nobody left to hear its
    // answer: it is let go of rather than left waiting on the developer.
    this.dependencies.questions.abandonFor(session.id);
    // Why the thread went quiet, on the thread itself. Without it the interface
    // only shows a session that is no longer running, and a launcher that could
    // not start at all reads exactly like one that finished its work: the
    // failure that costs a night is the silent one.
    this.append(featureId, session.id, {
      kind: "notice",
      text: outcome === "failed" ? "the session failed" : "the session ended",
      ...(detail === undefined ? {} : { detail }),
    });
    bus.publish({
      type: "main-session-ended",
      featureId,
      sessionId: session.id,
      outcome,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private append(featureId: string, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(store, bus, { featureId, sessionId }, line);
  }
}
