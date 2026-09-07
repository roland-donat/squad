import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  AcceptanceCriterion,
  BlockingEdge,
  Feature,
  FeatureGraph,
  OpenFeatureBody,
  Project,
  RegisterProjectBody,
  StoredState,
  ThreadEntry,
  ThreadEntryKind,
  Ticket,
  TicketKind,
} from "../shared/api";
import {
  blockersByTicket,
  findCycle,
  holdsNothingBack,
  resolveTicketState,
  type GraphEdge,
} from "../shared/graph";
import type { SquadDatabase } from "./db/open";
import {
  acceptanceCriteria,
  blockingEdges,
  features,
  projects,
  threadEntries,
  tickets,
} from "./db/schema";
import { SquadError } from "./errors";
import { resolveRepositoryRoot } from "./git";
import { isInside } from "./paths";

/** What an agent hands over when it writes a node of the graph. */
export interface CreateTicketInput {
  featureId: string;
  kind: TicketKind;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Tickets that must be merged before this one may start. */
  blockedBy: string[];
  /** Tickets this one must be merged before, used when a fix lands in front of pending work. */
  blocks: string[];
}

/** What settling a decision records on the ticket that was waiting. */
export interface SettleDecisionInput {
  /** The feature the ticket belongs to: a session only settles its own graph. */
  featureId: string;
  ticketId: string;
  conclusion: string;
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

  listFeatures(projectId?: string): Feature[] {
    const query = this.db.select().from(features).$dynamic();
    if (projectId !== undefined) query.where(eq(features.projectId, projectId));
    return query.orderBy(sql`rowid`).all();
  }

  storedState(): StoredState {
    const openFeatures = this.listFeatures();
    return {
      projects: this.listProjects(),
      features: openFeatures,
      graphs: openFeatures.map((feature) => this.featureGraph(feature.id)),
      threads: this.listThreadEntries(),
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
    // Looked up within its feature rather than by id alone: a session is opened
    // on one feature, and nothing it says should be able to close a decision
    // taken on another.
    const ticket = this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, input.ticketId), eq(tickets.featureId, input.featureId)))
      .get();
    if (!ticket) {
      throw new SquadError(
        "ticket_not_found",
        404,
        `no ticket with id ${input.ticketId} in feature ${input.featureId}`,
      );
    }
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
    const root = await resolveRepositoryRoot(input.path);

    if (isInside(this.dataDir, root)) {
      throw new SquadError(
        "data_directory_inside_project",
        400,
        `squad stores its database in ${this.dataDir}, which is inside ${root}`,
      );
    }

    const project: Project = {
      id: randomUUID(),
      name: input.name ?? basename(root),
      path: root,
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

  openFeature(input: OpenFeatureBody): Feature {
    const project = this.requireProject(input.projectId);

    const feature: Feature = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(features).values(feature).run();
    return feature;
  }

  requireProject(projectId: string): Project {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      throw new SquadError("project_not_found", 404, `no project with id ${projectId}`);
    }
    return project;
  }

  requireFeature(featureId: string): Feature {
    const feature = this.db.select().from(features).where(eq(features.id, featureId)).get();
    if (!feature) {
      throw new SquadError("feature_not_found", 404, `no feature with id ${featureId}`);
    }
    return feature;
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

    const known = new Map(existing.map((ticket) => [ticket.id, ticket]));
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
          kind: input.kind,
          title: input.title,
          description: input.description,
          lifecycle: "unstarted",
          externalId: null,
          conclusion: null,
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
        kind: row.kind,
        title: row.title,
        description: row.description,
        acceptanceCriteria: criteria.get(row.id) ?? [],
        externalId: row.externalId,
        conclusion: row.conclusion,
        state: resolveTicketState(row.kind, row.lifecycle, blockers.get(row.id) ?? [], cleared),
        createdAt: row.createdAt,
      })),
      edges: edges.map((edge) => ({
        featureId: feature.id,
        blockerId: edge.blockerId,
        blockedId: edge.blockedId,
      })),
    };
  }

  private requireTicketOfFeature(ticketId: string, featureId: string): void {
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

function isUniqueViolation(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.startsWith("SQLITE_CONSTRAINT")
  );
}
