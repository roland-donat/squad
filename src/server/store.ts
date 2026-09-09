import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, asc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { defaultConcurrencyCaps, defaultGenerationDepthCap } from "../shared/api";
import type {
  AcceptanceCriterion,
  AnswerSource,
  AutonomyHalt,
  AutonomyHaltReason,
  BlockingEdge,
  CriterionCoverage,
  CriterionVerdict,
  Feature,
  FeatureGraph,
  FeatureRepository,
  LaunchAngle,
  OpenFeatureBody,
  Project,
  Question,
  RegisterProjectBody,
  Settings,
  SettlementOutcome,
  SheetVerdict,
  StepReport,
  StoredState,
  TestSheetPoint,
  ThreadEntry,
  ThreadEntryKind,
  Ticket,
  TicketKind,
  UpdateProjectBody,
  UpdateSettingsBody,
  Worktree,
} from "../shared/api";
import {
  blockersByTicket,
  findCycle,
  holdsNothingBack,
  resolveTicketState,
  type GraphEdge,
  type TicketLifecycle,
} from "../shared/graph";
import { sheetWasValidated } from "../shared/validation";
import type { SquadDatabase } from "./db/open";
import {
  acceptanceCriteria,
  blockingEdges,
  criterionCoverage,
  featureRepositories,
  features,
  projects,
  questionOptions,
  questions,
  settings,
  stepReports,
  testSheetPoints,
  threadEntries,
  tickets,
} from "./db/schema";
import { SquadError } from "./errors";
import { branchExists, resolveDefaultBranch, resolveRepositoryRoot } from "./git";
import { isInside } from "./paths";
import type { ScheduledFeature } from "./scheduler";

/** What an agent hands over when it writes a node of the graph. */
export interface CreateTicketInput {
  featureId: string;
  /**
   * The repository this ticket is built in, among those its feature carries.
   * Left out, it is the feature's home project: the common case is a feature
   * that carries one repository, and naming it every time would be noise.
   */
  projectId?: string | undefined;
  kind: TicketKind;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Tickets that must be merged before this one may start. */
  blockedBy: string[];
  /** Tickets this one must be merged before, used when a fix lands in front of pending work. */
  blocks: string[];
  /**
   * The ticket whose work uncovered this one, when an agent asked for it while
   * building something else. It decides the new ticket's depth, which is what
   * bounds a cascade; absent, the ticket is a first generation, as everything
   * the main session writes is.
   */
  bornOf?: string | null;
}

/** What an agent hands over when it asks the developer a question. */
export interface AskQuestionInput {
  featureId: string;
  /** The ticket whose sub-session is asking, or null for the main session. */
  ticketId: string | null;
  sessionId: string;
  prompt: string;
  options: string[];
  recommendation: string;
  scopeChanging: boolean;
}

/**
 * What opening a feature takes. The recorded conversation is squad's own to
 * pass, never the caller's: it is written when a session is attached, and the
 * route that opens a blank feature has nothing to say about it.
 */
export interface OpenFeatureInput extends OpenFeatureBody {
  resumedSessionId?: string | null;
}

/** What settling a decision records on the ticket that was waiting. */
export interface SettleDecisionInput {
  /** The feature the ticket belongs to: a session only settles its own graph. */
  featureId: string;
  ticketId: string;
  conclusion: string;
}

/** What a sub-session hands over when its step ends. */
export interface RecordStepReportInput {
  /** The feature the ticket belongs to: a session only reports on its own graph. */
  featureId: string;
  ticketId: string;
  summary: string;
  recommendation: string;
  /** One entry per acceptance criterion of the ticket, no more and no fewer. */
  coverage: Array<{ criterionId: string; verdict: CriterionVerdict; note?: string | null }>;
  /** What the agent suggests checking by hand beyond the criteria. */
  suggestions: string[];
}

/** What a settling pass hands back, one entry per point of the sheet. */
export interface SettleSheetInput {
  /** The feature the ticket belongs to: a pass only settles its own graph. */
  featureId: string;
  ticketId: string;
  points: Array<{ pointId: string; outcome: SettlementOutcome; note: string }>;
}

/** What the developer says of a test sheet once they have been through it. */
export interface ReviewTestSheetInput {
  ticketId: string;
  /** Empty means nothing general was said. */
  feedback: string;
  points: Array<{ id: string; passed: boolean; comment: string }>;
}

/** One line to write on a session thread. */
export interface AppendThreadEntryInput {
  featureId: string;
  /** Null on the main session; the ticket of a sub-session once those exist. */
  ticketId?: string | null;
  sessionId: string;
  kind: ThreadEntryKind;
  text: string;
  detail?: string | null;
}

/**
 * Every read and write of squad's durable state. Rows are ordered by SQLite's
 * `rowid`, which is insertion order: two features opened within the same
 * millisecond would otherwise come back in an undefined order.
 */
export class Store {
  constructor(
    private readonly db: SquadDatabase,
    private readonly dataDir: string,
  ) {}

  listProjects(): Project[] {
    return this.db.select().from(projects).orderBy(sql`rowid`).all();
  }

  /**
   * Every feature, or those of one project. A feature is listed under its home
   * project only: that is where its main session runs, and a feature carrying
   * a repository is not a feature of it.
   */
  listFeatures(projectId?: string): Feature[] {
    const query = this.db.select().from(features).$dynamic();
    if (projectId !== undefined) query.where(eq(features.projectId, projectId));
    const rows = query.orderBy(sql`rowid`).all();
    const carried = this.readFeatureRepositories(rows.map((row) => row.id));
    return rows.map((row) => toFeature(row, carried.get(row.id) ?? []));
  }

  /**
   * What each feature carries, in the order the rows were written, which puts
   * the home project first: it is inserted when the feature is opened, and
   * everything attached afterwards comes after it.
   */
  private readFeatureRepositories(featureIds: string[]): Map<string, FeatureRepository[]> {
    const byFeature = new Map<string, FeatureRepository[]>();
    if (featureIds.length === 0) return byFeature;
    for (const row of this.db
      .select()
      .from(featureRepositories)
      .where(inArray(featureRepositories.featureId, featureIds))
      .orderBy(sql`rowid`)
      .all()) {
      const list = byFeature.get(row.featureId) ?? [];
      list.push({
        projectId: row.projectId,
        worktree: toWorktree(row.branch, row.worktreePath),
        pullRequestUrl: row.pullRequestUrl,
      });
      byFeature.set(row.featureId, list);
    }
    return byFeature;
  }

  storedState(): StoredState {
    const openFeatures = this.listFeatures();
    return {
      projects: this.listProjects(),
      features: openFeatures,
      graphs: openFeatures.map((feature) => this.featureGraph(feature.id)),
      threads: this.listThreadEntries(),
      questions: this.listQuestions(),
      settings: this.settings(),
    };
  }

  /** Every line written on the threads, oldest first, all features together. */
  listThreadEntries(featureId?: string): ThreadEntry[] {
    const query = this.db.select().from(threadEntries).$dynamic();
    if (featureId !== undefined) query.where(eq(threadEntries.featureId, featureId));
    return query.orderBy(sql`rowid`).all();
  }

  appendThreadEntry(input: AppendThreadEntryInput): ThreadEntry {
    const entry: ThreadEntry = {
      id: randomUUID(),
      featureId: input.featureId,
      ticketId: input.ticketId ?? null,
      sessionId: input.sessionId,
      kind: input.kind,
      text: input.text,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(threadEntries).values(entry).run();
    return entry;
  }

  /**
   * Closes a decision on the conclusion the developer reached. The record says
   * `settled`, since nothing was merged anywhere, and the graph reads it as a
   * ticket that holds nothing back, which is what releases the tickets that were
   * waiting on the answer.
   */
  settleDecision(input: SettleDecisionInput): Ticket {
    const ticket = this.requireTicketIn(input.featureId, input.ticketId);
    if (ticket.kind !== "decision") {
      throw new SquadError(
        "ticket_not_a_decision",
        400,
        `ticket "${ticket.title}" is of kind ${ticket.kind}: only a decision ticket is settled this way`,
      );
    }
    if (ticket.conclusion !== null) {
      throw new SquadError(
        "decision_already_settled",
        409,
        `decision "${ticket.title}" was already settled: ${ticket.conclusion}`,
      );
    }

    this.db
      .update(tickets)
      .set({ lifecycle: "settled", conclusion: input.conclusion })
      .where(eq(tickets.id, ticket.id))
      .run();

    const graph = this.featureGraph(ticket.featureId);
    const settled = graph.tickets.find((each) => each.id === ticket.id);
    if (!settled) throw new Error("the ticket just settled is missing from its own graph");
    return settled;
  }

  async registerProject(input: RegisterProjectBody): Promise<Project> {
    const root = await this.resolveProjectRoot(input.path);
    // Read now and stored, not read at each use: a repository someone left on
    // another branch would otherwise silently become the base of the next
    // feature branch.
    const defaultBranch = input.defaultBranch ?? (await resolveDefaultBranch(root));

    const project: Project = {
      id: randomUUID(),
      name: input.name ?? basename(root),
      path: root,
      defaultBranch,
      featureConcurrencyCap: input.featureConcurrencyCap ?? defaultConcurrencyCaps.feature,
      verifyCommand: input.verifyCommand ?? null,
      createdAt: new Date().toISOString(),
    };

    try {
      this.db.insert(projects).values(project).run();
    } catch (cause) {
      // The unique index on `path` is what actually decides, rather than a
      // preliminary read: two registrations of the same repository can be in
      // flight at once, since resolving the path awaits git.
      if (isUniqueViolation(cause)) {
        throw new SquadError(
          "project_already_registered",
          409,
          `${root} is already registered as a project`,
        );
      }
      throw cause;
    }
    return project;
  }

  /**
   * Changes what was named on a project, and leaves the rest as it stands. The
   * path and the default branch are checked exactly as a registration checks
   * them: a settings screen is not a back door onto a directory that is not a
   * repository, or onto a branch that is not there.
   */
  async updateProject(projectId: string, patch: UpdateProjectBody): Promise<Project> {
    const project = this.requireProject(projectId);
    const root = patch.path === undefined ? project.path : await this.resolveProjectRoot(patch.path);
    if (root !== project.path) this.requireNothingInFlight(project);
    if (patch.defaultBranch !== undefined && !(await branchExists(root, patch.defaultBranch))) {
      throw new SquadError(
        "branch_not_found",
        400,
        `${root} has no branch named ${patch.defaultBranch}`,
      );
    }
    // Built from what was named, so a field left out keeps its value and a
    // field named as null clears it: the verification command has to be
    // removable, and `undefined` is the only thing that means "not said".
    const changes = {
      ...(root === project.path ? {} : { path: root }),
      ...(patch.defaultBranch === undefined ? {} : { defaultBranch: patch.defaultBranch }),
      ...(patch.featureConcurrencyCap === undefined
        ? {}
        : { featureConcurrencyCap: patch.featureConcurrencyCap }),
      ...(patch.verifyCommand === undefined ? {} : { verifyCommand: patch.verifyCommand }),
    };
    if (Object.keys(changes).length > 0) {
      try {
        this.db.update(projects).set(changes).where(eq(projects.id, project.id)).run();
      } catch (cause) {
        if (isUniqueViolation(cause)) {
          throw new SquadError(
            "project_already_registered",
            409,
            `${root} is already registered as a project`,
          );
        }
        throw cause;
      }
    }
    return this.requireProject(project.id);
  }

  /** A path resolved to a repository root, and refused if squad lives inside it. */
  private async resolveProjectRoot(path: string): Promise<string> {
    const root = await resolveRepositoryRoot(path);
    if (isInside(this.dataDir, root)) {
      throw new SquadError(
        "data_directory_inside_project",
        400,
        `squad stores its database in ${this.dataDir}, which is inside ${root}`,
      );
    }
    return root;
  }

  /**
   * Refuses to move a project out from under work that is already checked out.
   * Squad's worktrees are checked out of the repository the project names, and
   * their branches merge back into it: pointing the project elsewhere while one
   * exists would send a merge into another repository.
   */
  private requireNothingInFlight(project: Project): void {
    const inFlight = this.db
      .select({ title: features.title })
      .from(featureRepositories)
      .innerJoin(features, eq(featureRepositories.featureId, features.id))
      .where(
        and(
          eq(featureRepositories.projectId, project.id),
          isNotNull(featureRepositories.worktreePath),
        ),
      )
      .all();
    if (inFlight.length > 0) {
      throw new SquadError(
        "project_has_work_in_flight",
        409,
        `${project.name} has checked-out work (${inFlight.map((row) => `"${row.title}"`).join(", ")}): its repository path is changed once nothing of it is checked out`,
      );
    }
  }

  /**
   * Opens a feature on a home project, carrying it and whatever else was named.
   * Nothing is checked out: a feature opened to paste a spec into it must not
   * cost a checkout of one repository, let alone three. Each gets one the first
   * time a ticket of that repository is launched.
   */
  openFeature(input: OpenFeatureInput): Feature {
    const project = this.requireProject(input.projectId);
    // The home project first and once, whatever the caller named: it is what
    // the order of the rows means, and what a ticket falls back to.
    const carried = [project.id, ...input.otherProjectIds].filter(
      (projectId, index, all) => all.indexOf(projectId) === index,
    );
    for (const projectId of carried) this.requireProject(projectId);

    const createdAt = new Date().toISOString();
    const row = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title,
      resumedSessionId: input.resumedSessionId ?? null,
      goAsRecommended: false,
      autonomyHaltReason: null,
      autonomyHaltDetail: null,
      autonomyHaltedAt: null,
      createdAt,
    };
    this.db.transaction((tx) => {
      tx.insert(features).values(row).run();
      tx.insert(featureRepositories)
        .values(carried.map((projectId) => carriedRow(row.id, projectId, createdAt)))
        .run();
    });
    return this.requireFeature(row.id);
  }

  /**
   * Adds the repository a path points at to what a feature may touch. The path
   * is what an agent reads in a `CLAUDE.md`, and squad resolves it to a project
   * it already drives: squad reads no prose, and a path it was never handed is
   * not a repository it starts driving because an agent named it.
   */
  async carryRepositoryAt(featureId: string, path: string): Promise<Feature> {
    const root = await resolveRepositoryRoot(path);
    const project = await this.projectAt(root);
    if (!project) {
      const driven = this.listProjects()
        .map((each) => `${each.name} (${each.path})`)
        .join(", ");
      throw new SquadError(
        "project_not_found",
        404,
        `${root} is not a repository squad drives: it drives ${driven === "" ? "none yet" : driven}`,
      );
    }
    return this.carryRepository(featureId, project.id);
  }

  /**
   * Adds a repository to what a feature may touch. Only a registered project
   * can be carried: squad drives what its owner handed it and nothing else, and
   * an agent reading a path out of a `CLAUDE.md` must not be able to widen that.
   * Carrying one twice is not an error, since two agents may read the same line.
   */
  private carryRepository(featureId: string, projectId: string): Feature {
    const feature = this.requireFeature(featureId);
    const project = this.requireProject(projectId);
    if (!feature.repositories.some((each) => each.projectId === project.id)) {
      this.db
        .insert(featureRepositories)
        .values(carriedRow(feature.id, project.id, new Date().toISOString()))
        .run();
    }
    return this.requireFeature(feature.id);
  }

  /**
   * Declares the whole list of what a feature carries. The home project stays
   * whatever is left out, and a repository holding a checkout is refused rather
   * than dropped: its branch is where work is, and forgetting it here would
   * leave that branch with nothing pointing at it.
   */
  setCarriedRepositories(featureId: string, projectIds: readonly string[]): Feature {
    const feature = this.requireFeature(featureId);
    const wanted = new Set([feature.projectId, ...projectIds]);
    for (const projectId of wanted) this.requireProject(projectId);
    const dropped = feature.repositories.filter((each) => !wanted.has(each.projectId));
    // A repository is dropped only when nothing of the feature points at it any
    // more: a checkout holds work on a branch, and a ticket written for it would
    // be a ticket squad has nowhere left to build.
    const held = dropped.filter(
      (each) =>
        each.worktree !== null ||
        this.db
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.featureId, feature.id), eq(tickets.projectId, each.projectId)))
          .all().length > 0,
    );
    if (held.length > 0) {
      throw new SquadError(
        "repository_still_used",
        409,
        `feature "${feature.title}" still has work in ${held.map((each) => this.requireProject(each.projectId).name).join(", ")}: a repository is dropped once no ticket of the feature is built there and nothing of it is checked out`,
      );
    }
    this.db.transaction((tx) => {
      for (const each of dropped) {
        tx.delete(featureRepositories)
          .where(
            and(
              eq(featureRepositories.featureId, feature.id),
              eq(featureRepositories.projectId, each.projectId),
            ),
          )
          .run();
      }
      const createdAt = new Date().toISOString();
      const added = [...wanted].filter(
        (projectId) => !feature.repositories.some((each) => each.projectId === projectId),
      );
      if (added.length > 0) {
        tx.insert(featureRepositories)
          .values(added.map((projectId) => carriedRow(feature.id, projectId, createdAt)))
          .run();
      }
    });
    return this.requireFeature(feature.id);
  }

  requireProject(projectId: string): Project {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      throw new SquadError("project_not_found", 404, `no project with id ${projectId}`);
    }
    return project;
  }

  /**
   * The feature whose main session is a given recorded conversation, or null
   * when no feature has taken it. What says a conversation is already a thread.
   */
  featureResumedFrom(sessionId: string): Feature | null {
    const row = this.db
      .select({ id: features.id })
      .from(features)
      .where(eq(features.resumedSessionId, sessionId))
      .get();
    return row ? this.requireFeature(row.id) : null;
  }

  /**
   * The project squad drives at a path, or null when it drives none there. The
   * path is resolved to a repository root first, so a path inside a repository
   * finds the project of that repository.
   */
  async projectAt(path: string): Promise<Project | null> {
    const root = await resolveRepositoryRoot(path);
    return this.db.select().from(projects).where(eq(projects.path, root)).get() ?? null;
  }

  /**
   * The feature with this id, or null when squad does not have it. Read by what
   * must not fail on a feature that is gone: an alert points at what it reports
   * and is raised after the fact, so an address it cannot build is one it does
   * without, never an error thrown back at a caller that has finished its work.
   */
  feature(featureId: string): Feature | null {
    const row = this.db.select().from(features).where(eq(features.id, featureId)).get();
    if (!row) return null;
    return toFeature(row, this.readFeatureRepositories([row.id]).get(row.id) ?? []);
  }

  requireFeature(featureId: string): Feature {
    const feature = this.feature(featureId);
    if (!feature) {
      throw new SquadError("feature_not_found", 404, `no feature with id ${featureId}`);
    }
    return feature;
  }

  /**
   * One repository of a feature, refused when the feature does not carry it. A
   * ticket, a checkout and a pull request all hang on this pair, and reading it
   * in one place is what keeps "a feature only touches what it declared" from
   * being checked differently in three.
   */
  requireFeatureRepository(featureId: string, projectId: string): FeatureRepository {
    const feature = this.requireFeature(featureId);
    const carried = feature.repositories.find((each) => each.projectId === projectId);
    if (!carried) {
      const names = feature.repositories
        .map((each) => `"${this.requireProject(each.projectId).name}"`)
        .join(", ");
      throw new SquadError(
        "project_not_carried",
        400,
        `feature "${feature.title}" does not carry the repository ${projectId}: it carries ${names}`,
      );
    }
    return carried;
  }

  /**
   * Writes a node of the graph and its edges in one go. The edges are checked
   * against the whole feature before anything is written: an edge is only
   * meaningful next to the ones already there, and a graph that briefly holds a
   * cycle is a graph whose frontier is briefly wrong.
   */
  createTicket(input: CreateTicketInput): Ticket {
    const feature = this.requireFeature(input.featureId);
    const existing = this.db
      .select()
      .from(tickets)
      .where(eq(tickets.featureId, feature.id))
      .orderBy(sql`rowid`)
      .all();

    // The repository this ticket is built in: what it named, or the feature's
    // home project. Refused when the feature does not carry it, which is what
    // catches a ticket written for the wrong repository as it is written
    // rather than two hours later, when its sub-session finds nothing there.
    const carried = this.requireFeatureRepository(
      feature.id,
      input.projectId ?? feature.projectId,
    );
    const known = new Map(existing.map((ticket) => [ticket.id, ticket]));
    // One deeper than the ticket whose work uncovered this one, and a first
    // generation otherwise. Read from the parent's own depth rather than
    // counted along the edges: what a ticket blocks says nothing about who
    // asked for it.
    const bornOf =
      input.bornOf === undefined || input.bornOf === null
        ? null
        : this.requireTicketOfFeature(input.bornOf, feature.id);
    const generation = bornOf === null ? 0 : bornOf.generation + 1;
    const id = randomUUID();
    const proposed: GraphEdge[] = [
      ...input.blockedBy.map((blockerId) => ({ blockerId, blockedId: id })),
      ...input.blocks.map((blockedId) => ({ blockerId: id, blockedId })),
    ];
    for (const edge of proposed) {
      const other = edge.blockerId === id ? edge.blockedId : edge.blockerId;
      this.requireTicketOfFeature(other, feature.id);
    }

    const prospective = [...this.readEdges(feature.id), ...proposed];
    const cycle = findCycle([...known.keys(), id], prospective);
    if (cycle) {
      const name = (ticketId: string) =>
        ticketId === id ? input.title : (known.get(ticketId)?.title ?? ticketId);
      throw new SquadError(
        "edge_would_create_cycle",
        409,
        `these blocking edges would create a cycle: ${[...cycle, cycle[0]].map((each) => `"${name(each!)}"`).join(" blocks ")}`,
      );
    }

    const createdAt = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.insert(tickets)
        .values({
          id,
          featureId: feature.id,
          projectId: carried.projectId,
          kind: input.kind,
          title: input.title,
          description: input.description,
          lifecycle: "unstarted",
          externalId: null,
          conclusion: null,
          branch: null,
          worktreePath: null,
          sessionId: null,
          generation,
          createdAt,
        })
        .run();
      if (input.acceptanceCriteria.length > 0) {
        tx.insert(acceptanceCriteria)
          .values(
            input.acceptanceCriteria.map((text, position) => ({
              id: randomUUID(),
              ticketId: id,
              position,
              text,
            })),
          )
          .run();
      }
      if (proposed.length > 0) {
        tx.insert(blockingEdges)
          .values(
            proposed.map((edge) => ({
              featureId: feature.id,
              blockerId: edge.blockerId,
              blockedId: edge.blockedId,
              createdAt,
            })),
          )
          // The same pair may be declared twice, by the ticket that depends and
          // by the one that is depended upon; the edge is one edge either way.
          .onConflictDoNothing()
          .run();
      }
    });

    const graph = this.featureGraph(feature.id);
    const created = graph.tickets.find((ticket) => ticket.id === id);
    if (!created) throw new Error("the ticket just written is missing from its own graph");
    return created;
  }

  /** The whole graph of a feature, with every ticket state computed from the edges. */
  featureGraph(featureId: string): FeatureGraph {
    const feature = this.requireFeature(featureId);
    const rows = this.db
      .select()
      .from(tickets)
      .where(eq(tickets.featureId, feature.id))
      .orderBy(sql`rowid`)
      .all();
    const edges = this.readEdges(feature.id);
    const criteria = this.readAcceptanceCriteria(rows.map((row) => row.id));
    const reports = this.readStepReports(rows.map((row) => row.id));

    const blockers = blockersByTicket(
      rows.map((row) => row.id),
      edges,
    );
    const cleared = new Set(
      rows.filter((row) => holdsNothingBack(row.lifecycle)).map((row) => row.id),
    );

    return {
      featureId: feature.id,
      tickets: rows.map((row) => ({
        id: row.id,
        featureId: row.featureId,
        projectId: row.projectId,
        kind: row.kind,
        title: row.title,
        description: row.description,
        acceptanceCriteria: criteria.get(row.id) ?? [],
        externalId: row.externalId,
        conclusion: row.conclusion,
        state: resolveTicketState(row, blockers.get(row.id) ?? [], cleared),
        worktree: toWorktree(row.branch, row.worktreePath),
        sessionId: row.sessionId,
        queuedAt: row.queuedAt,
        generation: row.generation,
        stepReport: reports.get(row.id) ?? null,
        createdAt: row.createdAt,
      })),
      edges: edges.map((edge) => ({
        featureId: feature.id,
        blockerId: edge.blockerId,
        blockedId: edge.blockedId,
      })),
    };
  }

  /** One ticket, with its state computed like every other read of the graph. */
  requireTicket(ticketId: string): Ticket {
    const row = this.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!row) {
      throw new SquadError("ticket_not_found", 404, `no ticket with id ${ticketId}`);
    }
    const ticket = this.featureGraph(row.featureId).tickets.find((each) => each.id === ticketId);
    if (!ticket) throw new Error("a ticket is missing from its own feature graph");
    return ticket;
  }

  /**
   * One ticket of one feature, which is how every write a session makes is
   * looked up: a session is opened on one feature, and nothing it says should
   * be able to reach a ticket of another. A ticket of another feature reads as
   * absent rather than as forbidden, since from where the session stands it is.
   */
  private requireTicketIn(featureId: string, ticketId: string): Ticket {
    const ticket = this.featureGraph(featureId).tickets.find((each) => each.id === ticketId);
    if (!ticket) {
      throw new SquadError(
        "ticket_not_found",
        404,
        `no ticket with id ${ticketId} in feature ${featureId}`,
      );
    }
    return ticket;
  }

  /**
   * Where a feature's branch lives in one of its repositories, written the
   * first time it is checked out there.
   */
  recordFeatureWorktree(featureId: string, projectId: string, worktree: Worktree): Feature {
    this.db
      .update(featureRepositories)
      .set({ branch: worktree.branch, worktreePath: worktree.path })
      .where(
        and(
          eq(featureRepositories.featureId, featureId),
          eq(featureRepositories.projectId, projectId),
        ),
      )
      .run();
    return this.requireFeature(featureId);
  }

  recordTicketWorktree(ticketId: string, worktree: Worktree): void {
    this.db
      .update(tickets)
      .set({ branch: worktree.branch, worktreePath: worktree.path })
      .where(eq(tickets.id, ticketId))
      .run();
  }

  /**
   * Records a launch the developer asked for and squad has not opened yet. It
   * is a request, not a run: the lifecycle underneath is left alone, so a
   * failed ticket waiting for a place is still known to have failed, and the
   * session it resumes is still the one written on its row.
   */
  queueLaunch(ticketId: string, angle: LaunchAngle): Ticket {
    this.db
      .update(tickets)
      .set({ queuedAt: new Date().toISOString(), queuedAngle: angle })
      .where(eq(tickets.id, ticketId))
      .run();
    return this.requireTicket(ticketId);
  }

  /**
   * The launch waiting on a ticket, with the run recorded under it: opening the
   * sub-session needs both, one to know what to say to it and one to know
   * whether there is a session to take back.
   */
  queuedLaunch(ticketId: string): { angle: LaunchAngle; lifecycle: TicketLifecycle } | null {
    const row = this.db
      .select({
        queuedAt: tickets.queuedAt,
        queuedAngle: tickets.queuedAngle,
        lifecycle: tickets.lifecycle,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .get();
    if (!row || row.queuedAt === null) return null;
    // The two columns are written together and cleared together, so an angle is
    // there whenever a timestamp is. The fallback is what the type asks for,
    // and it reads as a first launch, which is what a missing angle would be.
    return { angle: row.queuedAngle ?? "implement", lifecycle: row.lifecycle };
  }

  /**
   * Drops a launch request without touching what squad recorded of the ticket's
   * runs. Used when the sub-session could not be opened at all: nothing ran, so
   * the ticket goes back to reading exactly as it did before the request.
   */
  dropQueuedLaunch(ticketId: string): Ticket {
    this.db
      .update(tickets)
      .set({ queuedAt: null, queuedAngle: null })
      .where(eq(tickets.id, ticketId))
      .run();
    return this.requireTicket(ticketId);
  }

  /**
   * What the scheduler decides on: every feature holding a launch that waits or
   * a sub-session that runs, each beside the cap its home project declares. The
   * home project and not the most restrictive of what the feature carries: the
   * cap says how much of one piece of work may run at once, and a feature that
   * merely touches a narrow repository is not a narrower piece of work. The
   * others are left out because they contribute nothing to the count, not as an
   * approximation: a feature with neither would change no answer.
   */
  scheduledFeatures(): ScheduledFeature[] {
    const inFlight = this.db
      .selectDistinct({ featureId: tickets.featureId })
      .from(tickets)
      .where(or(eq(tickets.lifecycle, "running"), isNotNull(tickets.queuedAt)))
      .all();
    if (inFlight.length === 0) return [];

    const caps = new Map(
      this.db
        .select({ featureId: features.id, cap: projects.featureConcurrencyCap })
        .from(features)
        .innerJoin(projects, eq(features.projectId, projects.id))
        .all()
        .map((row) => [row.featureId, row.cap]),
    );
    return inFlight.map((row) => ({
      graph: this.featureGraph(row.featureId),
      cap: caps.get(row.featureId) ?? defaultConcurrencyCaps.feature,
    }));
  }

  /**
   * Records that a step has begun: a sub-session is carrying the ticket, and
   * this is the one. The session id is what a later resume runs on, so it is
   * written the moment the session opens rather than when it first speaks.
   */
  startStep(ticketId: string, sessionId: string): Ticket {
    this.db
      .update(tickets)
      // The launch request is consumed here and nowhere else: what was asked
      // for has happened, and a row that still said so would be scheduled again.
      .set({ lifecycle: "running", sessionId, queuedAt: null, queuedAngle: null })
      .where(eq(tickets.id, ticketId))
      .run();
    return this.requireTicket(ticketId);
  }

  /**
   * Records that a step stopped without reaching an end. Nothing is cleaned up:
   * the branch, the worktree and the session id stay on the row, because they
   * are what a resume starts from.
   */
  failStep(ticketId: string): Ticket {
    this.db.update(tickets).set({ lifecycle: "failed" }).where(eq(tickets.id, ticketId)).run();
    return this.requireTicket(ticketId);
  }

  /**
   * Records that a validated step is being merged. Refused on a step nobody
   * validated, and refused here rather than by whoever asks: "a ticket that was
   * not validated never merges" is the guarantee the whole chain rests on, and a
   * guarantee checked by every caller is a guarantee one caller will forget.
   */
  startMerge(ticketId: string): Ticket {
    const ticket = this.requireTicket(ticketId);
    if (!sheetWasValidated(ticket.stepReport)) {
      throw new SquadError(
        "ticket_not_mergeable",
        409,
        `ticket "${ticket.title}" has no validated step: its branch is not merged until its test sheet comes back with every point checked`,
      );
    }
    this.db.update(tickets).set({ lifecycle: "merging" }).where(eq(tickets.id, ticket.id)).run();
    return this.requireTicket(ticket.id);
  }

  /**
   * Records a merged ticket. Where its work used to live is forgotten only when
   * that place is really gone: a row naming a checkout nobody can open sends its
   * reader to a path that is not there, and a checkout squad could not remove
   * has to stay nameable, since removing it by hand is the only way out. The
   * session id stays either way: it is the record of who did the work.
   */
  markMerged(ticketId: string, cleanedUp: boolean): Ticket {
    this.db
      .update(tickets)
      .set({
        lifecycle: "merged",
        ...(cleanedUp ? { branch: null, worktreePath: null } : {}),
      })
      .where(eq(tickets.id, ticketId))
      .run();
    return this.requireTicket(ticketId);
  }

  /**
   * Records a merge that conflicted and that a resolution session could not
   * settle. Nothing is cleaned up, exactly as after a failure: the work is on
   * the branch, the worktree is where the conflict is, and taking the
   * sub-session back is the way out.
   */
  markConflict(ticketId: string): Ticket {
    this.db.update(tickets).set({ lifecycle: "conflict" }).where(eq(tickets.id, ticketId)).run();
    return this.requireTicket(ticketId);
  }

  /**
   * Puts a ticket back under its sub-session, which is what a rejected test
   * sheet asks for. Used only when that session is still alive: a correction
   * that has to reopen one queues a launch like any other, and the step starts
   * when it opens.
   */
  reopenStep(ticketId: string): Ticket {
    this.db.update(tickets).set({ lifecycle: "running" }).where(eq(tickets.id, ticketId)).run();
    return this.requireTicket(ticketId);
  }

  /**
   * Every merge the store still believes is in flight. A merge is a chain of
   * git commands and a check, none of which survives the process that ran them,
   * so such a row at startup is a merge to run again rather than a state to
   * show.
   */
  ticketsMerging(): Ticket[] {
    return this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.lifecycle, "merging"))
      .orderBy(sql`rowid`)
      .all()
      .map((row) => this.requireTicket(row.id));
  }

  /**
   * Where the pull request of one repository lives, written when squad opens
   * it. One per repository the feature carries: they are separate branches on
   * separate remotes, and nothing could make them one request.
   */
  recordPullRequest(featureId: string, projectId: string, url: string): Feature {
    this.db
      .update(featureRepositories)
      .set({ pullRequestUrl: url })
      .where(
        and(
          eq(featureRepositories.featureId, featureId),
          eq(featureRepositories.projectId, projectId),
        ),
      )
      .run();
    return this.requireFeature(featureId);
  }

  /**
   * Whether anything built in one repository of this feature was ever put in
   * front of a human. Asked per repository, because each has its own pull
   * request and each is merged on its own: a point checked by hand in one says
   * nothing about the work done in another.
   *
   * Read over every report rather than the latest one of each ticket: a ticket
   * corrected after a red sheet reports again, and the second report may well
   * be empty while the work still went through someone's hands.
   */
  repositoryAskedForManualTesting(featureId: string, projectId: string): boolean {
    const [row] = this.db
      .select({ points: sql<number>`count(*)` })
      .from(testSheetPoints)
      .innerJoin(stepReports, eq(testSheetPoints.reportId, stepReports.id))
      .innerJoin(tickets, eq(stepReports.ticketId, tickets.id))
      .where(and(eq(tickets.featureId, featureId), eq(tickets.projectId, projectId)))
      .all();
    return (row?.points ?? 0) > 0;
  }

  /** Every step the store still believes is running, moved to `interrupted`. */
  interruptRunningSteps(): Ticket[] {
    const stranded = this.db
      .select({ id: tickets.id, featureId: tickets.featureId })
      .from(tickets)
      .where(eq(tickets.lifecycle, "running"))
      .orderBy(sql`rowid`)
      .all();
    if (stranded.length === 0) return [];
    this.db
      .update(tickets)
      .set({ lifecycle: "interrupted" })
      .where(eq(tickets.lifecycle, "running"))
      .run();
    // One graph per feature rather than one per ticket: reading a ticket back
    // computes the states of every ticket around it anyway.
    const graphs = new Map(
      [...new Set(stranded.map((row) => row.featureId))].map((featureId) => [
        featureId,
        this.featureGraph(featureId),
      ]),
    );
    return stranded.map((row) => {
      const ticket = graphs.get(row.featureId)?.tickets.find((each) => each.id === row.id);
      if (!ticket) throw new Error("a ticket is missing from its own feature graph");
      return ticket;
    });
  }

  /**
   * Records the end of a step, and with it the test sheet the developer will go
   * through: the acceptance criteria only a person can settle, followed by what
   * the agent suggests looking at on top of them. A criterion the agent settled
   * itself by running something stays in the report, with what it ran, and does
   * not reach the sheet.
   *
   * The coverage has to name every criterion of the ticket and nothing else. A
   * partial declaration is refused rather than read as "the rest is covered":
   * what is missing from the sheet is exactly what nobody will check.
   *
   * Only a running sub-session reports, which is why a step corrected after a
   * red sheet reports from `running` too: handing the failing points back is
   * what puts the ticket there, and a ticket sitting on a sheet nobody has been
   * through has already said its piece.
   */
  recordStepReport(input: RecordStepReportInput): Ticket {
    const ticket = this.requireTicketIn(input.featureId, input.ticketId);
    if (ticket.state !== "running" || ticket.sessionId === null) {
      throw new SquadError(
        "no_step_in_progress",
        409,
        `ticket "${ticket.title}" is ${ticket.state}: the end of a step is reported by the sub-session running it`,
      );
    }

    const sheet = this.buildSheet(ticket, input);
    const createdAt = new Date().toISOString();
    const reportId = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(stepReports)
        .values({
          id: reportId,
          ticketId: ticket.id,
          sessionId: ticket.sessionId ?? "",
          summary: input.summary,
          recommendation: input.recommendation,
          feedback: null,
          reviewedAt: null,
          createdAt,
        })
        .run();
      if (sheet.coverage.length > 0) {
        tx.insert(criterionCoverage)
          .values(
            sheet.coverage.map((entry, position) => ({
              reportId,
              criterionId: entry.criterionId,
              position,
              text: entry.text,
              verdict: entry.verdict,
              note: entry.note,
            })),
          )
          .run();
      }
      if (sheet.points.length > 0) {
        tx.insert(testSheetPoints)
          .values(
            sheet.points.map((point, position) => ({
              id: randomUUID(),
              reportId,
              position,
              criterionId: point.criterionId,
              text: point.text,
              verdict: "pending" as const,
              comment: null,
            })),
          )
          .run();
      }
      tx.update(tickets)
        .set({ lifecycle: "awaiting-validation" })
        .where(eq(tickets.id, ticket.id))
        .run();
    });

    return this.requireTicket(ticket.id);
  }

  /**
   * The test sheet a report produces, and the coverage it declared. Built before
   * anything is written so a coverage that does not match the ticket is refused
   * without leaving half a report behind.
   */
  private buildSheet(
    ticket: Ticket,
    input: RecordStepReportInput,
  ): { coverage: CriterionCoverage[]; points: Array<{ criterionId: string | null; text: string }> } {
    const declared = new Map(input.coverage.map((entry) => [entry.criterionId, entry]));
    const known = new Set(ticket.acceptanceCriteria.map((criterion) => criterion.id));
    const missing = ticket.acceptanceCriteria.filter((criterion) => !declared.has(criterion.id));
    const unknown = input.coverage.filter((entry) => !known.has(entry.criterionId));
    if (missing.length > 0 || unknown.length > 0 || declared.size !== input.coverage.length) {
      const said = [
        ...missing.map((criterion) => `nothing said about "${criterion.text}" (${criterion.id})`),
        ...unknown.map((entry) => `${entry.criterionId} is not a criterion of this ticket`),
        ...(declared.size === input.coverage.length ? [] : ["a criterion is declared twice"]),
      ];
      throw new SquadError(
        "coverage_mismatch",
        400,
        `the report must say, for each of the ${ticket.acceptanceCriteria.length} acceptance criteria of "${ticket.title}" and for those only, how it was settled: ${said.join("; ")}`,
      );
    }

    const coverage = ticket.acceptanceCriteria.map((criterion) => {
      const entry = declared.get(criterion.id);
      const note = entry?.note?.trim() ?? "";
      return {
        criterionId: criterion.id,
        text: criterion.text,
        verdict: entry?.verdict ?? "judgement",
        note: note === "" ? null : note,
      };
    });

    // A criterion the agent settled itself is only worth the sheet it spares if
    // it says what it ran: without that, the developer has no way to tell a
    // verification from a claim, and doing the work again is the only recourse.
    const unsaid = coverage.filter((entry) => entry.verdict === "checked" && entry.note === null);
    if (unsaid.length > 0) {
      throw new SquadError(
        "checked_without_note",
        400,
        `a criterion settled by the agent has to say what was run and what it answered: ${unsaid
          .map((entry) => `nothing said of "${entry.text}"`)
          .join("; ")}`,
      );
    }

    return {
      coverage,
      // The sheet is what nobody but a person can settle, in the order the
      // ticket wrote them, then what the agent suggested on top of them.
      points: [
        ...coverage
          .filter((entry) => entry.verdict === "judgement")
          .map((entry) => ({ criterionId: entry.criterionId, text: entry.text })),
        ...input.suggestions.map((text) => ({ criterionId: null, text })),
      ],
    };
  }

  /**
   * Records what the developer said of a test sheet: a verdict and a comment per
   * point, and a general return. A sheet is gone through once; a step corrected
   * afterwards is reported again, and that report carries a sheet of its own.
   */
  /**
   * What a settling pass found, applied to the sheet before anyone is woken.
   *
   * The pass answers in its own vocabulary and squad turns it into the
   * developer's: a point that holds is checked, a point that is broken is left
   * unchecked and goes back with its evidence, a point handed over stays
   * pending and is the only kind that reaches a human. The note is kept whatever
   * the outcome, so what the pass ran is readable next to what it concluded.
   *
   * Two things are refused rather than interpreted. A pass that answers some
   * points and not others, because a sheet half settled would silently drop what
   * it skipped. And a point born of an acceptance criterion the sub-session
   * itself declared `judgement`: one agent does not get to certify what another
   * declared beyond its reach, and it is exactly the promise the ticket made.
   */
  settleSheet(input: SettleSheetInput): Ticket {
    const ticket = this.requireTicketIn(input.featureId, input.ticketId);
    const report = ticket.stepReport;
    if (!report || report.reviewedAt !== null) {
      throw new SquadError(
        "sheet_not_settleable",
        409,
        `ticket "${ticket.title}" has no test sheet waiting to be settled`,
      );
    }
    const pending = report.sheet.filter((point) => point.verdict === "pending");
    const expected = new Set(pending.map((point) => point.id));
    const given = new Set(input.points.map((entry) => entry.pointId));
    if (expected.size !== given.size || [...expected].some((id) => !given.has(id))) {
      throw new SquadError(
        "settlement_mismatch",
        400,
        `the pass must answer each of the ${expected.size} point(s) of this test sheet, and no other`,
      );
    }
    const judgement = new Set(
      report.coverage
        .filter((entry) => entry.verdict === "judgement")
        .map((entry) => entry.criterionId),
    );
    const byId = new Map(report.sheet.map((point) => [point.id, point]));
    const certified = input.points.filter((entry) => {
      if (entry.outcome !== "holds") return false;
      const criterionId = byId.get(entry.pointId)?.criterionId ?? null;
      return criterionId !== null && judgement.has(criterionId);
    });
    if (certified.length > 0) {
      throw new SquadError(
        "criterion_needs_a_person",
        400,
        `the sub-session declared these criteria beyond a command's reach, so the pass may hand them over or show them broken, never check them off: ${certified
          .map((entry) => `"${byId.get(entry.pointId)?.text ?? entry.pointId}"`)
          .join("; ")}`,
      );
    }

    const verdicts: Record<SettlementOutcome, SheetVerdict> = {
      holds: "passed",
      broken: "failed",
      human: "pending",
    };
    this.db.transaction((tx) => {
      for (const entry of input.points) {
        tx.update(testSheetPoints)
          .set({
            verdict: verdicts[entry.outcome],
            settlement: entry.outcome,
            settlementNote: entry.note,
          })
          .where(eq(testSheetPoints.id, entry.pointId))
          .run();
      }
      // A sheet with nothing left pending has been gone through, by squad rather
      // than by the developer: dating it here is what stops the interface from
      // asking them to fill in a form nobody is waiting on.
      if (input.points.every((entry) => entry.outcome !== "human")) {
        tx.update(stepReports)
          .set({ reviewedAt: new Date().toISOString() })
          .where(eq(stepReports.id, report.id))
          .run();
      }
    });
    return this.requireTicket(ticket.id);
  }

  reviewTestSheet(input: ReviewTestSheetInput): Ticket {
    const ticket = this.requireTicket(input.ticketId);
    const report = ticket.stepReport;
    if (!report) {
      throw new SquadError(
        "test_sheet_not_found",
        404,
        `ticket "${ticket.title}" has no step report: there is no test sheet to go through`,
      );
    }
    if (report.reviewedAt !== null) {
      throw new SquadError(
        "test_sheet_already_reviewed",
        409,
        `the test sheet of "${ticket.title}" was already gone through on ${report.reviewedAt}`,
      );
    }
    // What is asked of the developer is what is still pending: a point squad's
    // settling pass answered carries its own verdict and its evidence, and
    // asking about it again would be asking them to do the work it spared.
    const expected = new Set(
      report.sheet.filter((point) => point.verdict === "pending").map((point) => point.id),
    );
    const given = new Set(input.points.map((point) => point.id));
    if (expected.size !== given.size || [...expected].some((id) => !given.has(id))) {
      throw new SquadError(
        "invalid_request",
        400,
        `the review must answer each of the ${expected.size} point(s) of this test sheet still waiting on you, and no other`,
      );
    }

    const reviewedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const point of input.points) {
        tx.update(testSheetPoints)
          .set({
            verdict: point.passed ? "passed" : "failed",
            comment: point.comment === "" ? null : point.comment,
          })
          .where(eq(testSheetPoints.id, point.id))
          .run();
      }
      tx.update(stepReports)
        .set({ feedback: input.feedback === "" ? null : input.feedback, reviewedAt })
        .where(eq(stepReports.id, report.id))
        .run();
    });
    return this.requireTicket(ticket.id);
  }

  /**
   * Writes a question an agent is asking, which is what the tool call that asks
   * it blocks on. The recommendation has to be one of the options: squad
   * answers an implementation question with it when the mode is armed, and an
   * answer nobody offered is one the agent never agreed to.
   */
  askQuestion(input: AskQuestionInput): Question {
    const feature = this.requireFeature(input.featureId);
    // Checked here rather than trusted: a session only asks about its own
    // feature, and a ticket of another one reads as absent from where it stands.
    if (input.ticketId !== null) this.requireTicketIn(feature.id, input.ticketId);
    if (!input.options.includes(input.recommendation)) {
      throw new SquadError(
        "recommendation_not_an_option",
        400,
        `the recommendation must be one of the options offered: "${input.recommendation}" is not among ${input.options.map((option) => `"${option}"`).join(", ")}`,
      );
    }

    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(questions)
        .values({
          id,
          featureId: feature.id,
          ticketId: input.ticketId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          recommendation: input.recommendation,
          scopeChanging: input.scopeChanging,
          state: "pending",
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: new Date().toISOString(),
        })
        .run();
      tx.insert(questionOptions)
        .values(input.options.map((text, position) => ({ questionId: id, position, text })))
        .run();
    });
    return this.requireQuestion(id);
  }

  /**
   * Records what a question was answered, and by whom. A question is answered
   * once: the tool call waiting on it returns, and there is nobody left to hand
   * a second answer to.
   */
  answerQuestion(questionId: string, answer: string, answeredBy: AnswerSource): Question {
    const question = this.requireQuestion(questionId);
    if (question.state !== "pending") {
      throw new SquadError(
        "question_not_pending",
        409,
        `this question is ${question.state}: only a pending question is answered`,
      );
    }
    this.db
      .update(questions)
      .set({ state: "answered", answer, answeredBy, answeredAt: new Date().toISOString() })
      .where(eq(questions.id, question.id))
      .run();
    return this.requireQuestion(question.id);
  }

  /**
   * Every question the store still believes is waiting, marked abandoned. The
   * session that asked cannot outlive the server that opened it, so such a row
   * is a question whose answer would reach nobody. Called once, before squad
   * listens, like the running steps it interrupts.
   */
  abandonPendingQuestions(): Question[] {
    return this.abandonQuestions(eq(questions.state, "pending"));
  }

  /**
   * The questions one session was waiting on, marked abandoned. A session that
   * is over cannot read an answer, so leaving its question in front of the
   * developer would ask them for something nobody would ever hear.
   */
  abandonQuestionsOfSession(sessionId: string): Question[] {
    return this.abandonQuestions(
      and(eq(questions.state, "pending"), eq(questions.sessionId, sessionId)),
    );
  }

  private abandonQuestions(waiting: SQL | undefined): Question[] {
    const pending = this.db
      .select({ id: questions.id })
      .from(questions)
      .where(waiting)
      .orderBy(sql`rowid`)
      .all();
    if (pending.length === 0) return [];
    this.db
      .update(questions)
      .set({ state: "abandoned", answeredAt: new Date().toISOString() })
      .where(waiting)
      .run();
    return pending.map((row) => this.requireQuestion(row.id));
  }

  requireQuestion(questionId: string): Question {
    const row = this.db.select().from(questions).where(eq(questions.id, questionId)).get();
    if (!row) {
      throw new SquadError("question_not_found", 404, `no question with id ${questionId}`);
    }
    return { ...row, options: this.readQuestionOptions([row.id]).get(row.id) ?? [] };
  }

  /** Every question ever asked, oldest first, answered and abandoned included. */
  listQuestions(featureId?: string): Question[] {
    const query = this.db.select().from(questions).$dynamic();
    if (featureId !== undefined) query.where(eq(questions.featureId, featureId));
    const rows = query.orderBy(sql`rowid`).all();
    const options = this.readQuestionOptions(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, options: options.get(row.id) ?? [] }));
  }

  private readQuestionOptions(questionIds: string[]): Map<string, string[]> {
    const byQuestion = new Map<string, string[]>();
    if (questionIds.length === 0) return byQuestion;
    for (const row of this.db
      .select()
      .from(questionOptions)
      .where(inArray(questionOptions.questionId, questionIds))
      .orderBy(asc(questionOptions.position))
      .all()) {
      const list = byQuestion.get(row.questionId) ?? [];
      list.push(row.text);
      byQuestion.set(row.questionId, list);
    }
    return byQuestion;
  }

  /**
   * Arms or disarms go-as-recommended on a feature. Arming clears whatever halt
   * was written: squad stopped for a reason it cannot judge to be dealt with,
   * and the developer saying "go" again is the whole of what says it is.
   */
  setGoAsRecommended(featureId: string, goAsRecommended: boolean): Feature {
    const feature = this.requireFeature(featureId);
    this.db
      .update(features)
      .set({
        goAsRecommended,
        autonomyHaltReason: null,
        autonomyHaltDetail: null,
        autonomyHaltedAt: null,
      })
      .where(eq(features.id, feature.id))
      .run();
    return this.requireFeature(feature.id);
  }

  /**
   * Records why squad stopped driving a feature. The mode stays armed: what is
   * written here is that it is held, and by what, so the interface can say so
   * and the developer can lift it once they have looked.
   */
  haltAutonomy(featureId: string, reason: AutonomyHaltReason, detail: string): Feature {
    const feature = this.requireFeature(featureId);
    this.db
      .update(features)
      .set({
        autonomyHaltReason: reason,
        autonomyHaltDetail: detail,
        autonomyHaltedAt: new Date().toISOString(),
      })
      .where(eq(features.id, feature.id))
      .run();
    return this.requireFeature(feature.id);
  }

  /** What squad is configured with, with its defaults when nothing was set. */
  settings(): Settings {
    const row = this.db.select().from(settings).where(eq(settings.id, singleSettingsRow)).get();
    return {
      webhookUrl: row?.webhookUrl ?? null,
      desktopNotifications: row?.desktopNotifications ?? true,
      machineConcurrencyCap: row?.machineConcurrencyCap ?? defaultConcurrencyCaps.machine,
      generationDepthCap: row?.generationDepthCap ?? defaultGenerationDepthCap,
      theme: row?.theme ?? "system",
    };
  }

  /** Changes what was named and leaves the rest as it stands. */
  updateSettings(patch: UpdateSettingsBody): Settings {
    const next: Settings = { ...this.settings(), ...patch };
    this.db
      .insert(settings)
      .values({ id: singleSettingsRow, ...next })
      .onConflictDoUpdate({ target: settings.id, set: next })
      .run();
    return next;
  }

  /**
   * A ticket's row, refused when it belongs to another feature. Close to
   * `requireTicketIn` and deliberately not the same: this one answers "is this
   * ticket of this graph" for something an agent named beside another ticket,
   * so its refusal names the crossing rather than hiding it as an absence, and
   * it hands back the row rather than the computed node.
   */
  private requireTicketOfFeature(
    ticketId: string,
    featureId: string,
  ): typeof tickets.$inferSelect {
    const ticket = this.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!ticket) {
      throw new SquadError("ticket_not_found", 404, `no ticket with id ${ticketId}`);
    }
    if (ticket.featureId !== featureId) {
      throw new SquadError(
        "edge_crosses_features",
        400,
        `ticket ${ticketId} belongs to another feature: a blocking edge links two tickets of the same feature`,
      );
    }
    return ticket;
  }

  private readEdges(featureId: string): BlockingEdge[] {
    return this.db
      .select()
      .from(blockingEdges)
      .where(eq(blockingEdges.featureId, featureId))
      .orderBy(sql`rowid`)
      .all()
      .map((edge) => ({
        featureId: edge.featureId,
        blockerId: edge.blockerId,
        blockedId: edge.blockedId,
      }));
  }

  /**
   * Writes down the commit a ticket branch is on, just before squad sets out to
   * merge it. Kept afterwards: it is what lets a second attempt ask git whether
   * the work landed, when the branch that carried it is no longer there.
   */
  recordMergeHead(ticketId: string, head: string): void {
    this.db.update(tickets).set({ mergeHead: head }).where(eq(tickets.id, ticketId)).run();
  }

  /** What the last merge attempt wrote down, or null if none ever did. */
  mergeHeadOf(ticketId: string): string | null {
    return (
      this.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()?.mergeHead ?? null
    );
  }

  /**
   * How many steps a ticket has reported. What bounds the settling pass: a
   * sheet answered, corrected and reported again has already had squad's word
   * once, and a third round is a disagreement between two agents that a person
   * should be the one to end.
   */
  reportedSteps(ticketId: string): number {
    return this.db
      .select()
      .from(stepReports)
      .where(eq(stepReports.ticketId, ticketId))
      .all().length;
  }

  /**
   * The latest step report of each ticket, with its coverage and its sheet. The
   * latest one and not all of them: a ticket corrected after a red sheet reports
   * again, and what the graph shows is where it stands now.
   */
  private readStepReports(ticketIds: string[]): Map<string, StepReport> {
    const latest = new Map<string, StepReport>();
    if (ticketIds.length === 0) return latest;
    const rows = this.db
      .select()
      .from(stepReports)
      .where(inArray(stepReports.ticketId, ticketIds))
      .orderBy(sql`rowid`)
      .all();
    if (rows.length === 0) return latest;

    const reportIds = rows.map((row) => row.id);
    const coverage = new Map<string, CriterionCoverage[]>();
    for (const row of this.db
      .select()
      .from(criterionCoverage)
      .where(inArray(criterionCoverage.reportId, reportIds))
      .orderBy(asc(criterionCoverage.position))
      .all()) {
      const list = coverage.get(row.reportId) ?? [];
      list.push({
        criterionId: row.criterionId,
        text: row.text,
        verdict: row.verdict,
        note: row.note,
      });
      coverage.set(row.reportId, list);
    }
    const sheets = new Map<string, TestSheetPoint[]>();
    for (const row of this.db
      .select()
      .from(testSheetPoints)
      .where(inArray(testSheetPoints.reportId, reportIds))
      .orderBy(asc(testSheetPoints.position))
      .all()) {
      const list = sheets.get(row.reportId) ?? [];
      list.push({
        id: row.id,
        criterionId: row.criterionId,
        text: row.text,
        verdict: row.verdict,
        comment: row.comment,
        settlement:
          row.settlement === null || row.settlementNote === null
            ? null
            : { outcome: row.settlement, note: row.settlementNote },
      });
      sheets.set(row.reportId, list);
    }

    // Insertion order, so the last row read for a ticket is its latest report.
    for (const row of rows) {
      latest.set(row.ticketId, {
        id: row.id,
        ticketId: row.ticketId,
        sessionId: row.sessionId,
        summary: row.summary,
        recommendation: row.recommendation,
        coverage: coverage.get(row.id) ?? [],
        sheet: sheets.get(row.id) ?? [],
        feedback: row.feedback,
        reviewedAt: row.reviewedAt,
        createdAt: row.createdAt,
      });
    }
    return latest;
  }

  private readAcceptanceCriteria(ticketIds: string[]): Map<string, AcceptanceCriterion[]> {
    const byTicket = new Map<string, AcceptanceCriterion[]>();
    if (ticketIds.length === 0) return byTicket;
    const rows = this.db
      .select()
      .from(acceptanceCriteria)
      .where(inArray(acceptanceCriteria.ticketId, ticketIds))
      .orderBy(asc(acceptanceCriteria.position))
      .all();
    for (const row of rows) {
      const list = byTicket.get(row.ticketId) ?? [];
      list.push({ id: row.id, text: row.text });
      byTicket.set(row.ticketId, list);
    }
    return byTicket;
  }
}

/**
 * A repository a feature carries and has not touched yet: no branch, no
 * checkout, no pull request. Written in one place, since the three ways of
 * carrying one all start from the same nothing.
 */
function carriedRow(featureId: string, projectId: string, createdAt: string) {
  return {
    featureId,
    projectId,
    branch: null,
    worktreePath: null,
    pullRequestUrl: null,
    createdAt,
  };
}

/** The settings are one row, and this is it. */
const singleSettingsRow = 1;

/** A feature row, with its two worktree columns read back as the one thing they are. */
function toFeature(
  row: {
    id: string;
    projectId: string;
    title: string;
    resumedSessionId: string | null;
    goAsRecommended: boolean;
    autonomyHaltReason: AutonomyHaltReason | null;
    autonomyHaltDetail: string | null;
    autonomyHaltedAt: string | null;
    createdAt: string;
  },
  repositories: FeatureRepository[],
): Feature {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    repositories,
    resumedSessionId: row.resumedSessionId,
    goAsRecommended: row.goAsRecommended,
    autonomyHalt: toHalt(row),
    createdAt: row.createdAt,
  };
}

/**
 * The three halt columns read back as the one thing they are. They are written
 * together and cleared together, so either the mode is halted and all three say
 * why, or none of them is there.
 */
function toHalt(row: {
  autonomyHaltReason: AutonomyHaltReason | null;
  autonomyHaltDetail: string | null;
  autonomyHaltedAt: string | null;
}): AutonomyHalt | null {
  if (row.autonomyHaltReason === null || row.autonomyHaltedAt === null) return null;
  return {
    reason: row.autonomyHaltReason,
    detail: row.autonomyHaltDetail ?? "",
    at: row.autonomyHaltedAt,
  };
}

/**
 * The two columns read back as the one thing they are. They are written
 * together and only together, so either both are there or neither is.
 */
function toWorktree(branch: string | null, path: string | null): Worktree | null {
  return branch === null || path === null ? null : { branch, path };
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.startsWith("SQLITE_CONSTRAINT")
  );
}
