import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { threadEntryKinds, ticketKinds } from "../../shared/api";
import { ticketLifecycles } from "../../shared/graph";

/**
 * The durable state of squad. This schema is the single declaration of what is
 * stored; `pnpm db:generate` turns any change here into a versioned migration
 * file under `drizzle/`, applied at server startup.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Repository root, resolved by git and free of symlinks, hence unique. */
  path: text("path").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * The nodes of the graph. `lifecycle` holds what squad has recorded of a
 * ticket's execution, and nothing else: `blocked` and `ready` are read off the
 * edges at every query, so no write is ever needed to keep them true.
 */
export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ticketKinds }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** `unstarted` or `merged` for now, and one more value per execution state to come. */
    lifecycle: text("lifecycle", { enum: ticketLifecycles }).notNull().default("unstarted"),
    /** Reserved for a projection towards an issue tracker, never written (ADR 0001). */
    externalId: text("external_id"),
    /** What was settled, on a `decision` ticket the developer has closed. */
    conclusion: text("conclusion"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("tickets_feature_idx").on(table.featureId),
    // The unions are declared twice on purpose: once in the type, so the rows
    // read back typed, and once in the table, so a value squad never writes
    // cannot appear behind its back either.
    check("tickets_kind", sql`${table.kind} in (${literals(ticketKinds)})`),
    check("tickets_lifecycle", sql`${table.lifecycle} in (${literals(ticketLifecycles)})`),
  ],
);

/** The declared values of a column, as a SQL list. */
function literals(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/**
 * Acceptance criteria are rows rather than a JSON list because the test sheet
 * declares automatic coverage criterion by criterion: a reference by position
 * would silently point elsewhere the day a ticket is adjusted.
 */
export const acceptanceCriteria = sqliteTable(
  "acceptance_criteria",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (table) => [
    index("acceptance_criteria_ticket_idx").on(table.ticketId),
    unique("acceptance_criteria_position").on(table.ticketId, table.position),
  ],
);

/**
 * Every line of every session thread, written as it happens. Squad keeps the
 * thread itself rather than pointing at a transcript on disk: what the developer
 * comes back to read must survive a restart of the server, and it is the same
 * record the interface renders live.
 */
export const threadEntries = sqliteTable(
  "thread_entries",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /** Null on the main session; the ticket of a sub-session once those exist. */
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    kind: text("kind", { enum: threadEntryKinds }).notNull(),
    text: text("text").notNull(),
    /** What the interface folds away: a tool call's arguments, a failure's detail. */
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("thread_entries_feature_idx").on(table.featureId),
    check("thread_entries_kind", sql`${table.kind} in (${literals(threadEntryKinds)})`),
  ],
);

/**
 * The only relation of the graph: the blocker must be merged before the blocked
 * ticket may start. `feature_id` is carried on the edge so the constraint "both
 * ends belong to the same feature" is expressible in one row.
 */
export const blockingEdges = sqliteTable(
  "blocking_edges",
  {
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    blockerId: text("blocker_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("blocking_edges_feature_idx").on(table.featureId),
  ],
);
