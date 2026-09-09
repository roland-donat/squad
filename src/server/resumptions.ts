import type { Feature, Project, RecordedSession } from "../shared/api";
import { appendToThread } from "./threads";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import { listRecordedSessions, matchesSearch } from "./recorded-sessions";
import type { Store } from "./store";

/**
 * Where a feature comes from when it does not come from a blank thread: a
 * conversation claude-code already recorded. The grilling and the spec are done
 * at the terminal by design, so what squad was missing was the door between that
 * work and its own: attaching one opens a feature whose main session is that
 * very conversation, resumed, with everything it learnt still in it.
 *
 * Squad reads that conversation only to know where it ran and what to call it.
 * What it contains is the session's own business, and #14 is where the session
 * is asked about it rather than parsed.
 */

/** How many sessions are offered when nothing is searched for. */
const shownByDefault = 10;

/**
 * What a feature born of a conversation is opened with, beside the conversation
 * itself. The same settings an opened feature declares: the door the feature
 * came through changes where its thread starts, not what it is configured with.
 */
export interface AttachSettings {
  /** Left out, the conversation names the feature itself. */
  title?: string;
  /** Other registered projects this feature may build tickets in. */
  otherProjectIds?: string[];
  goAsRecommended?: boolean;
}

export interface ResumptionDependencies {
  store: Store;
  bus: EventBus;
  /** Where claude-code keeps its conversations; the seam suite hands in its own. */
  recordedSessionsDir: string;
}

export class Resumptions {
  constructor(private readonly dependencies: ResumptionDependencies) {}

  /**
   * The most recent conversations, or those a search matches. The search is what
   * lets one be found beyond the ten shown, and it reads what identifies a
   * session rather than what was said in it.
   */
  async list(
    search: string,
  ): Promise<{ sessions: RecordedSession[]; matching: number; readable: boolean }> {
    const read = await listRecordedSessions(this.dependencies.recordedSessionsDir);
    const matching = read.sessions.filter((session) => matchesSearch(session, search));
    // How many were found as well as the few shown: a list that quietly keeps
    // ten of thirty tells the reader their search was narrow when it was not.
    return {
      sessions: matching.slice(0, shownByDefault),
      matching: matching.length,
      readable: read.readable,
    };
  }

  /**
   * Turns a recorded conversation into a feature squad drives: the repository it
   * ran in, registered if squad did not know it yet, a feature on it, and its
   * main session resumed on that very conversation.
   *
   * One gesture rather than three requests from the interface: registering a
   * repository, opening a feature on it and resuming its conversation are one
   * decision, and an interface that made them separately would leave a project
   * registered beside a feature nobody opened whenever the second call failed.
   *
   * A session that cannot be opened is the one thing left behind: the feature
   * exists and its thread says why the session did not start, which is where a
   * main session that fails to open already leaves things.
   */
  async attach(
    sessionId: string,
    settings: AttachSettings = {},
  ): Promise<{ project: Project; feature: Feature }> {
    const { store, bus } = this.dependencies;
    const recorded = await this.require(sessionId);
    const taken = store.featureResumedFrom(sessionId);
    if (taken !== null) {
      throw new SquadError(
        "recorded_session_already_attached",
        409,
        `this conversation is already the main session of "${taken.title}": a conversation is one thread`,
      );
    }

    const project = await this.projectOf(recorded);
    const feature = store.openFeature({
      projectId: project.id,
      title: settings.title ?? nameOf(recorded),
      otherProjectIds: settings.otherProjectIds ?? [],
      goAsRecommended: settings.goAsRecommended ?? false,
      resumedSessionId: recorded.id,
    });
    bus.publish({ type: "feature-opened", feature });
    // Written down, and no session opened yet. A claude-code session resumed
    // with nothing to say has nothing to do and ends at once, which is what
    // attaching used to leave behind: a thread saying the session ended, and a
    // blank session opened by the first message afterwards. The conversation is
    // resumed when the developer first speaks, and that is what carries it.
    this.note(feature, recorded);
    return { project, feature };
  }

  /**
   * What the developer cannot see for themselves: this feature's thread is a
   * conversation squad did not write and will not repeat. Where it lives is
   * said, not copied, and how big it is says what resuming it will cost.
   */
  private note(feature: Feature, recorded: RecordedSession): void {
    const { store, bus } = this.dependencies;
    appendToThread(
      store,
      bus,
      { featureId: feature.id, sessionId: recorded.id },
      {
        kind: "notice",
        text: "this feature was opened on a recorded conversation",
        detail: [
          `${recorded.title ?? "untitled"} (${recorded.id})`,
          `recorded in ${recorded.cwd}${recorded.branch === null ? "" : ` on ${recorded.branch}`}`,
          `last written to on ${recorded.recordedAt}, ${Math.round(recorded.bytes / 1024)} kB`,
          "the first message sent here resumes it, with everything it already knows",
        ].join("\n"),
      },
    );
  }

  private async require(sessionId: string): Promise<RecordedSession> {
    const read = await listRecordedSessions(this.dependencies.recordedSessionsDir);
    const found = read.sessions.find((session) => session.id === sessionId);
    if (!found) {
      throw new SquadError(
        "recorded_session_not_found",
        404,
        `no recorded conversation with id ${sessionId}`,
      );
    }
    return found;
  }

  /**
   * The project a conversation belongs to: the one already registered at the
   * repository it ran in, or that repository registered now. Registering it is
   * what attaching means, since squad drives no repository its owner has not
   * handed it, and this is the developer handing it one.
   */
  private async projectOf(recorded: RecordedSession): Promise<Project> {
    const { store, bus } = this.dependencies;
    // The repository rather than the directory the session ran in, though git
    // would resolve either: what is registered is what the developer was shown
    // in the list, and the two must be the same repository.
    const path = recorded.repository ?? recorded.cwd;
    const known = await store.projectAt(path);
    if (known !== null) return known;
    const registered = await store.registerProject({ path });
    bus.publish({ type: "project-registered", project: registered });
    return registered;
  }
}

/**
 * What a feature born of a conversation is called: what the conversation was
 * named, failing that the opening of what was first asked of it, failing that
 * the day it was recorded. Never its identifier, which says nothing to anyone.
 */
function nameOf(recorded: RecordedSession): string {
  if (recorded.title !== null) return recorded.title;
  if (recorded.firstMessage !== null) return recorded.firstMessage.slice(0, 80);
  return `Reprise du ${new Date(recorded.recordedAt).toLocaleString("fr-FR")}`;
}
