import type { Feature, Project, RecordedSession } from "../shared/api";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import { listRecordedSessions, matchesSearch } from "./recorded-sessions";
import type { MainSessions } from "./sessions";
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

export interface ResumptionDependencies {
  store: Store;
  bus: EventBus;
  mainSessions: MainSessions;
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
  async attach(sessionId: string, title?: string): Promise<{ project: Project; feature: Feature }> {
    const { store, bus, mainSessions } = this.dependencies;
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
      title: title ?? nameOf(recorded),
      otherProjectIds: [],
      resumedSessionId: recorded.id,
    });
    bus.publish({ type: "feature-opened", feature });
    // Resumed rather than opened blank: the session answers to the id it is
    // resuming, so the thread of this feature is the continuation of that
    // conversation, not a second one beside it.
    await mainSessions.start(feature.id, { resume: recorded });
    return { project, feature };
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
