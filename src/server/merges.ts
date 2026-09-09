import type { Feature, FeatureGraph, Project, Ticket, Worktree } from "../shared/api";
import {
  conflictResolutionBriefing,
  conflictResolutionInstruction,
} from "./agents/briefing";
import type { AgentLauncher, AgentSession } from "./agents/launcher";
import { alertFor, type Alerts } from "./alerts";
import { publishGraph, type EventBus } from "./events";
import { fixTicketFor } from "./fix-ticket";
import { openPullRequest, requestAutoMerge } from "./forge";
import {
  branchExists,
  branchHead,
  deleteBranch,
  hasRemote,
  isMergedInto,
  mergeBranch,
  pushBranch,
  removeWorktree,
} from "./git";
import { runVerification, type IntegrationCheck } from "./integration";
import { pullRequestBody } from "./pull-request";
import type { Store } from "./store";
import { appendToThread, drainSession, type ThreadLine } from "./threads";
import type { Worktrees } from "./worktrees";

/**
 * What squad does with a step nobody has anything left to say about: it closes
 * the sub-session, brings the ticket branch back into the feature branch, throws
 * away the checkout it worked in, checks the feature branch still holds
 * together, and, once the whole graph has come back, sends the feature off as a
 * pull request.
 *
 * Everything here is serialised per project, one merge at a time. Two tickets of
 * the same feature merge into the same branch, so they cannot merge at once; and
 * the integration check that follows a merge reads that same checkout, so it
 * cannot run while the next merge writes to it. Serialising per project rather
 * than per feature costs a little parallelism and buys one rule instead of two,
 * which matters more where the two merges are a feature's tickets and a
 * feature's own pull request.
 */

export interface MergeDependencies {
  store: Store;
  bus: EventBus;
  alerts: Alerts;
  worktrees: Worktrees;
  launcher: AgentLauncher;
  /**
   * The sub-sessions, declared by what is needed of them rather than by who
   * provides them: a validated step's session is closed before its worktree is
   * touched, and a merge frees whatever was waiting behind the ticket.
   */
  subSessions: { close(ticketId: string): Promise<void>; schedule(): void };
  /**
   * What go-as-recommended does with a ticket squad wrote itself. Declared by
   * what is needed of it: a fix ticket born of a fix ticket is a cascade like
   * any other, and the depth cap has to see it.
   */
  autonomy: { ticketCreated(ticket: Ticket): void; ticketStopped(ticket: Ticket): void };
  /** Resolved late: squad only knows its own address once it is listening. */
  mcpUrl: () => string;
}

/**
 * Where a feature branch is published. One name, not a setting: squad pushes to
 * the remote the repository already has, and a repository with none is told so
 * rather than asked which one to invent.
 */
const remote = "origin";

/**
 * Everything one merge is about, gathered once. The four travel together through
 * every step of the chain, and passing them as one thing is what keeps a step
 * from being handed a feature and another feature's checkout.
 */
interface Merge {
  /** The ticket being merged, as the store read it when the merge started. */
  ticket: Ticket;
  feature: Feature;
  project: Project;
  /** Where the ticket branch is merged, and where the check then runs. */
  featureWorktree: Worktree;
}

export class Merges {
  /** One chain per project, which is what "one merge at a time" is made of. */
  private readonly chains = new Map<string, Promise<void>>();
  // The conflict resolution sessions in flight. Held so a shutdown can end
  // them: they are claude-code processes, and waiting for one to finish on its
  // own would keep the server up for as long as an agent takes to think.
  private readonly resolving = new Set<AgentSession>();
  private stopping = false;

  constructor(private readonly dependencies: MergeDependencies) {}

  /**
   * Queues the merge of a validated ticket, and returns without waiting for it.
   * What asks for one is a tool call or a request that has already said all it
   * had to say; what happens next reaches the developer on the event stream,
   * like everything else squad does on its own.
   */
  merge(ticket: Ticket): void {
    // On the chain of the ticket's own repository, not of its feature's home
    // one: two tickets of one feature that live in different repositories
    // merge into different branches and cannot get in each other's way.
    this.enqueue(ticket.projectId, () => this.carryOut(ticket.id));
  }

  /**
   * Queues the check that a feature has come back whole, without a merge having
   * just happened. A merge is the usual way a graph drains, and not the only
   * one: settling the last decision of a feature releases nothing and merges
   * nothing, yet it is exactly the moment every ticket of that graph has come
   * to rest.
   *
   * Every repository of the feature, each queued on its own chain like a merge,
   * since what it may do is push a branch and open a pull request. One pull
   * request per repository and no coordination between them: they are separate
   * branches on separate remotes, and holding one back until the others are
   * green would mean squad polling the forge, which it does nowhere.
   */
  deliver(featureId: string): void {
    const { store } = this.dependencies;
    const feature = store.requireFeature(featureId);
    for (const carried of feature.repositories) {
      if (carried.worktree === null || carried.pullRequestUrl !== null) continue;
      this.enqueue(carried.projectId, async () => {
        if (this.stopping) return;
        await this.deliverIfDrained(featureId, carried.projectId);
      });
    }
  }

  /**
   * Takes back the merges the previous run was in the middle of. A merge is a
   * chain of git commands and a check, none of which outlives the process that
   * ran them, so a row still saying `merging` is a merge to run again rather
   * than a state to show. Running it again is safe: a branch already merged
   * merges into nothing, and the rest of the chain is what was left to do.
   */
  resumeInterrupted(): void {
    for (const ticket of this.dependencies.store.ticketsMerging()) this.merge(ticket);
  }

  /** Waits for what is in flight, and starts nothing more. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.resolving].map((session) => session.stop()));
    await Promise.all([...this.chains.values()]);
  }

  private enqueue(projectId: string, work: () => Promise<void>): void {
    const chain = (this.chains.get(projectId) ?? Promise.resolve())
      .then(work)
      // Whatever a merge could not deal with is a bug: it is logged rather than
      // left to reject a chain everything else of this project queues behind.
      .catch((failure: unknown) => {
        console.error(`a merge of project ${projectId} failed`, failure);
      });
    this.chains.set(projectId, chain);
    void chain.then(() => {
      if (this.chains.get(projectId) === chain) this.chains.delete(projectId);
    });
  }

  /** One ticket, from its validated step to a feature that may be delivered. */
  private async carryOut(ticketId: string): Promise<void> {
    if (this.stopping) return;
    const { store, subSessions } = this.dependencies;
    const ticket = store.requireTicket(ticketId);
    if (ticket.state === "merged") return;

    // Before anything touches the worktree: a session still working in a
    // checkout squad is about to merge and remove would write into a directory
    // that is being pulled from under it.
    await subSessions.close(ticket.id);
    // The store refuses this on a step nobody validated, which is where "a
    // ticket that was not validated never merges" actually holds.
    const merging = store.startMerge(ticket.id);
    this.publishGraph(merging.featureId);

    const feature = store.requireFeature(merging.featureId);
    // The ticket's own repository: its branch goes home there, and the check
    // that follows is the one that repository declares.
    const project = store.requireProject(merging.projectId);
    const merge: Merge = {
      ticket: merging,
      feature,
      project,
      featureWorktree: await this.dependencies.worktrees.forFeature(feature, project),
    };
    if (!(await this.bringBranchBack(merge))) {
      // Whatever the ticket was holding up stays held up, but a place under the
      // caps has just been freed by the session that was closed above.
      subSessions.schedule();
      return;
    }

    await this.check(merge);
    // Every repository of the feature, not only the one that just merged: the
    // ticket that drained the graph may well be the last of its own repository
    // while another was already waiting for it.
    this.deliver(feature.id);
    subSessions.schedule();
  }

  /**
   * The merge itself: once as it stands, and if it conflicts, once more after a
   * session has been given the ticket's own worktree to settle it. Two attempts
   * and no more: an agent that could not resolve a conflict twice is an agent
   * that will not resolve it on the third try either, and the developer is the
   * one who decides what the two sides meant.
   */
  private async bringBranchBack(merge: Merge): Promise<boolean> {
    const { ticket, featureWorktree } = merge;
    if (ticket.worktree === null) {
      this.stopMerging(ticket, "squad has no branch written down for this ticket", false);
      return false;
    }
    const branch = ticket.worktree.branch;
    const message = `Merge ticket "${ticket.title}" into ${featureWorktree.branch}`;
    // Read while the branch is certainly there, and written down before the
    // merge rather than after: what answers "did this land" when the branch is
    // gone has to survive the run that was going to merge it.
    const head = await branchHead(featureWorktree.path, branch);
    if (head !== null) this.dependencies.store.recordMergeHead(ticket.id, head);

    let outcome = await mergeBranch(featureWorktree.path, branch, message);
    if (!outcome.merged && outcome.conflicted) {
      this.note(ticket, {
        kind: "notice",
        text: "merging this branch into the feature branch conflicted",
        detail: `${outcome.detail}\n\nsquad is opening a resolution session in this ticket's own worktree, and will try again once it ends`,
      });
      await this.resolveConflict(merge);
      // A shutdown that cut the resolution session short is not a conflict
      // nobody could settle. The ticket is left saying `merging`, which is
      // exactly what the next start reads as a merge to run again.
      if (this.stopping) return false;
      outcome = await mergeBranch(featureWorktree.path, branch, message);
    }
    if (!outcome.merged && (await this.alreadyIn(merge, head))) {
      outcome = { merged: true };
    }
    if (!outcome.merged) {
      this.stopMerging(ticket, outcome.detail, outcome.conflicted);
      return false;
    }

    // The checkout and the branch go together: the work is in the feature
    // branch now, and what is left is a directory nobody will open again.
    // Cleaning it up is not allowed to undo the merge, though: a directory that
    // could not be removed is a directory to remove by hand, and reading it as
    // a ticket that did not merge would send the work through again.
    const worktreePath = ticket.worktree.path;
    const cleaned = await this.cleanUp(merge, worktreePath, branch);
    this.publishGraph(this.dependencies.store.markMerged(ticket.id, cleaned === null).featureId);
    this.note(ticket, {
      kind: "notice",
      text: `the branch was merged into ${featureWorktree.branch}`,
      detail:
        cleaned === null
          ? "its worktree and its branch are gone: the work is on the feature branch"
          : `the work is on the feature branch, but ${branch} and ${worktreePath} are still there and have to go by hand: ${cleaned}`,
    });
    return true;
  }

  /**
   * Whether the work is on the feature branch already, whoever put it there.
   *
   * Asked before concluding that a merge failed, because two things put it
   * there without squad knowing. A resolution session is not confined
   * (ADR 0004) and one of them carried the merge through itself, deleting the
   * branch behind it. And a merge cut short by a restart is retried at the next
   * start, on a branch the first run had already merged and cleaned up. Both
   * leave git saying "not something we can merge", which is not a failure but a
   * merge that already happened: reading it as one marks a ticket failed whose
   * work is in, and a graph that says false is worse than no graph.
   */
  private async alreadyIn(merge: Merge, head: string | null): Promise<boolean> {
    const known = head ?? this.dependencies.store.mergeHeadOf(merge.ticket.id);
    if (known === null) return false;
    if (!(await isMergedInto(merge.featureWorktree.path, known))) return false;
    this.note(merge.ticket, {
      kind: "notice",
      text: "the work is on the feature branch already",
      detail: `${merge.featureWorktree.branch} contains ${known}: squad had nothing left to merge, and says merged rather than failed`,
    });
    return true;
  }

  /** Throws away what carried the work, and says so rather than failing. */
  private async cleanUp(
    merge: Merge,
    worktreePath: string,
    branch: string,
  ): Promise<string | null> {
    const left: string[] = [];
    try {
      await removeWorktree(merge.project.path, worktreePath);
    } catch (failure) {
      left.push(failure instanceof Error ? failure.message : String(failure));
    }
    // Asked rather than assumed: a resolution session that finished the merge
    // itself may have deleted the branch already, and saying it is still there
    // would send the developer looking for something that is gone.
    if (await branchExists(merge.project.path, branch)) {
      try {
        await deleteBranch(merge.featureWorktree.path, branch);
      } catch (failure) {
        left.push(failure instanceof Error ? failure.message : String(failure));
      }
    }
    return left.length === 0 ? null : left.join("; ");
  }

  /** Where a merge stops, on the state that says why, with a word to whoever asked. */
  private stopMerging(ticket: Ticket, detail: string, conflicted: boolean): void {
    const { store, alerts, autonomy } = this.dependencies;
    const stopped = conflicted ? store.markConflict(ticket.id) : store.failStep(ticket.id);
    this.publishGraph(stopped.featureId);
    this.note(ticket, {
      kind: "notice",
      text: conflicted
        ? "the conflict is still there after the resolution session"
        : "the branch could not be merged into the feature branch",
      detail,
    });
    alerts.raise(
      conflicted ? alertFor.mergeConflicted(ticket) : alertFor.mergeFailed(ticket),
    );
    // A branch that does not go home is work nobody may pile onto: the
    // unattended run ends here, as it does on a sub-session that stopped.
    autonomy.ticketStopped(stopped);
  }

  /**
   * A session opened for one job, in the ticket's own worktree: bring the
   * feature branch in and settle what the two sides did to the same lines. It is
   * not the ticket's sub-session, and it does not become one: the ticket keeps
   * pointing at the session that built it, which is the one a resume takes back.
   *
   * Nothing is read from what it says. Squad retries the merge when it ends, and
   * git is what answers.
   */
  private async resolveConflict(merge: Merge): Promise<void> {
    const { ticket, feature, featureWorktree } = merge;
    const { launcher, mcpUrl } = this.dependencies;
    if (ticket.worktree === null) return;
    const session = await launcher.open({
      role: "resolving",
      featureId: feature.id,
      ticketId: ticket.id,
      workingDirectory: ticket.worktree.path,
      mcpUrl: mcpUrl(),
      briefing: conflictResolutionBriefing(feature, ticket, featureWorktree.branch),
    });
    this.resolving.add(session);
    const instruction = conflictResolutionInstruction(featureWorktree.branch);
    const write = (line: ThreadLine) => this.append(ticket, session.id, line);
    write({ kind: "pilot", text: instruction });
    try {
      await session.send(instruction);
    } catch (failure) {
      write({
        kind: "notice",
        text: "squad could not hand the resolution session its instruction",
        detail: failure instanceof Error ? failure.message : String(failure),
      });
      await session.stop();
    }
    const ending = await drainSession(session, write);
    this.resolving.delete(session);
    if (this.stopping) return;
    write({
      kind: "notice",
      text:
        ending.outcome === "failed"
          ? "the resolution session failed"
          : "the resolution session ended; squad is trying the merge again",
      detail: ending.detail ?? null,
    });
  }

  /**
   * The project's own verification, on the feature branch, after every merge.
   * What it catches is what no sub-session can see from its own worktree: two
   * tickets that were green apart and are red together.
   */
  private async check(merge: Merge): Promise<void> {
    const { ticket, feature, project, featureWorktree } = merge;
    const check = await runVerification(project.verifyCommand, featureWorktree.path);
    if (!check.ran) return;
    this.note(ticket, {
      kind: "notice",
      text: check.passed
        ? "the integration check passed on the feature branch"
        : "the integration check failed on the feature branch",
      detail: `${project.verifyCommand}\n\n${check.output}`,
    });
    if (check.passed) return;
    // The command is what ran, hence non-null: passed on rather than read again
    // from the project, so the ticket cannot name a command other than the one
    // that came back red.
    this.raiseFix(ticket, feature, project.verifyCommand ?? "", check);
  }

  /**
   * A red check becomes a ticket, posted in front of everything that has not
   * started: work piled on a broken feature branch is work to do twice.
   */
  private raiseFix(
    ticket: Ticket,
    feature: Feature,
    command: string,
    check: IntegrationCheck,
  ): void {
    const { store, alerts, autonomy } = this.dependencies;
    // In the repository whose check went red, and in front of what has not
    // started there: a branch that no longer passes its own verification is
    // that repository's business, and blocking another repository's tickets on
    // it would stop work that has nothing to do with the breakage.
    const fix = store.createTicket(
      fixTicketFor(store.featureGraph(feature.id), ticket, command, check),
    );
    // Before the graph is announced, for the same reason the tools do it in
    // that order: what the mode does next is decided by what it is told, and a
    // cascade that reached its depth stops it before it launches.
    autonomy.ticketCreated(fix);
    this.publishGraph(feature.id);
    alerts.raise(alertFor.integrationCheckFailed(feature));
    this.note(ticket, {
      kind: "notice",
      text: "a fix ticket was posted in front of what has not started",
      detail: fix.title,
    });
  }

  /**
   * A feature every ticket of which has come back is a feature to deliver: its
   * branch is published and a pull request describes it from its own graph.
   *
   * The pull request is opened once and only once, which is what the address
   * written on the feature says: a drain is worked out again after every merge,
   * and a fix ticket merged after the delivery would otherwise open a second one.
   */
  private async deliverIfDrained(featureId: string, projectId: string): Promise<void> {
    const { store, alerts, bus } = this.dependencies;
    const graph = store.featureGraph(featureId);
    if (graph.tickets.length === 0) return;
    // The whole graph, not this repository's share of it: a feature is one
    // piece of work, and sending off one repository while another is still
    // being built would publish half an interface.
    if (!graph.tickets.every((each) => each.state === "merged")) return;
    const feature = store.requireFeature(featureId);
    const carried = store.requireFeatureRepository(featureId, projectId);
    if (carried.pullRequestUrl !== null || carried.worktree === null) return;
    const project = store.requireProject(projectId);
    // What was built in this repository, which is what its pull request
    // describes: the tickets of the others belong to their own.
    const built = { ...graph, tickets: graph.tickets.filter((each) => each.projectId === projectId) };

    // Whose thread the delivery is told on: the last ticket of this repository
    // that actually ran a session. A feature is not a session and has no thread
    // of its own, and the node that drained the graph may be a decision, which
    // never opened one.
    const ticket = lastWithSession(built);
    const branch = carried.worktree.branch;
    try {
      if (!(await hasRemote(project.path, remote))) {
        throw new Error(`the repository has no remote named ${remote} to push ${branch} to`);
      }
      await pushBranch(project.path, remote, branch);
      const url = await openPullRequest({
        repositoryRoot: project.path,
        base: project.defaultBranch,
        head: branch,
        title: feature.title,
        body: pullRequestBody(feature, built),
      });
      bus.publish({
        type: "feature-changed",
        feature: store.recordPullRequest(featureId, projectId, url),
      });
      this.note(ticket, {
        kind: "notice",
        text: `the feature is drained: its branch is pushed on ${project.name} and a pull request is open`,
        detail: url,
      });
      await this.settleAutoMerge(ticket, feature, project, url);
    } catch (failure) {
      const why = failure instanceof Error ? failure.message : String(failure);
      this.note(ticket, {
        kind: "notice",
        text: `the feature is drained but could not be sent off on ${project.name}`,
        detail: why,
      });
      alerts.raise(alertFor.featureNotDelivered(feature, why));
    }
  }

  /**
   * Whether the pull request may go in on its own. It may when nothing of this
   * feature was ever put in front of a person: a feature whose steps all came
   * back with an empty test sheet went through no human hands, and there is
   * nobody to wait for. As soon as one sheet held a point, someone looked at
   * this work, and the pull request waits for them to look once more.
   *
   * What squad never decides is whether the branch is green: that is asked of
   * the forge, which merges when its own checks allow it.
   */
  private async settleAutoMerge(
    ticket: Ticket | null,
    feature: Feature,
    project: Project,
    url: string,
  ): Promise<void> {
    const { store, alerts } = this.dependencies;
    // Asked of this repository alone: each pull request is merged on its own,
    // so a point checked by hand in one says nothing about the other.
    if (store.repositoryAskedForManualTesting(feature.id, project.id)) {
      this.note(ticket, {
        kind: "notice",
        text: "the pull request waits for the developer",
        detail: "something of this feature was checked by hand, so squad does not merge it on its own",
      });
      alerts.raise(alertFor.pullRequestWaiting(feature, url));
      return;
    }
    try {
      await requestAutoMerge(project.path, url);
      this.note(ticket, {
        kind: "notice",
        text: "the forge was asked to merge the pull request as soon as its checks allow",
        detail: "no step of this feature asked for a hand check, so nobody is waiting on it",
      });
    } catch (failure) {
      // Caught here rather than with the delivery: the pull request is open and
      // the branch is pushed, so saying the feature could not be sent off would
      // send the developer looking for something that is already there. What
      // did not happen is the merge, and that is what waits for them now.
      const why = failure instanceof Error ? failure.message : String(failure);
      this.note(ticket, {
        kind: "notice",
        text: "the forge would not take the pull request on its own",
        detail: why,
      });
      alerts.raise(alertFor.pullRequestWaiting(feature, url));
    }
  }

  /**
   * A line on the thread of the sub-session that built a ticket. A feature with
   * no ticket that ever ran one has nowhere to say this, and the alert beside it
   * is then the whole of what reaches the developer.
   */
  private note(ticket: Ticket | null, line: ThreadLine): void {
    if (ticket === null || ticket.sessionId === null) {
      console.error(`${line.text} (${ticket === null ? "no ticket" : ticket.id} to say it on)`);
      return;
    }
    this.append(ticket, ticket.sessionId, line);
  }

  private append(ticket: Ticket, sessionId: string, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(
      store,
      bus,
      { featureId: ticket.featureId, ticketId: ticket.id, sessionId },
      line,
    );
  }

  private publishGraph(featureId: string): void {
    publishGraph(this.dependencies.store, this.dependencies.bus, featureId);
  }
}

/**
 * The last ticket of a graph whose sub-session ever opened, which is where a
 * line about the feature as a whole is written. The last rather than the first:
 * what is said there is about what has just happened, so it belongs on the
 * thread the developer would look at next.
 */
function lastWithSession(graph: FeatureGraph): Ticket | null {
  return [...graph.tickets].reverse().find((ticket) => ticket.sessionId !== null) ?? null;
}
