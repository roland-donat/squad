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
import {
  defaultConcurrencyCaps,
  launchAngles,
  sheetVerdicts,
  threadEntryKinds,
  ticketKinds,
} from "../../shared/api";
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
  /**
   * The branch feature branches start from, and the one the main checkout never
   * leaves. The default only exists so the column could be added to rows
   * written before it: every registration resolves it from the repository.
   */
  defaultBranch: text("default_branch").notNull().default("main"),
  /**
   * How many sub-sessions one feature of this project may run at once. The
   * machine-wide cap in the settings bounds their sum.
   */
  featureConcurrencyCap: integer("feature_concurrency_cap")
    .notNull()
    .default(defaultConcurrencyCaps.feature),
  createdAt: text("created_at").notNull(),
});

export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /**
   * The feature branch and where it is checked out, written together the first
   * time a ticket of the feature is launched. Null before that: opening a
   * feature to paste a spec into it checks out nothing.
   */
  branch: text("branch"),
  worktreePath: text("worktree_path"),
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
    /** `unstarted`, `merged` or `settled`, and one more value per execution state to come. */
    lifecycle: text("lifecycle", { enum: ticketLifecycles }).notNull().default("unstarted"),
    /** Reserved for a projection towards an issue tracker, never written (ADR 0001). */
    externalId: text("external_id"),
    /** What was settled, on a `decision` ticket the developer has closed. */
    conclusion: text("conclusion"),
    /** The ticket branch and its worktree, written when the ticket is launched. */
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    /**
     * The sub-session that ran this ticket. Kept after a failure or an
     * interruption, because relaunching resumes this session rather than
     * opening a blank one.
     */
    sessionId: text("session_id"),
    /**
     * The launch squad accepted and has not opened yet, because the caps were
     * full: when it was asked for, and under which angle. Written together and
     * cleared together, the moment the sub-session opens.
     *
     * Stored rather than held in memory: squad owes the developer a launch it
     * accepted, and a restart that forgot it would leave a ticket waiting for a
     * place that had already come back.
     */
    queuedAt: text("queued_at"),
    queuedAngle: text("queued_angle", { enum: launchAngles }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("tickets_feature_idx").on(table.featureId),
    // The unions are declared twice on purpose: once in the type, so the rows
    // read back typed, and once in the table, so a value squad never writes
    // cannot appear behind its back either.
    check("tickets_kind", sql`${table.kind} in (${literals(ticketKinds)})`),
    check("tickets_lifecycle", sql`${table.lifecycle} in (${literals(ticketLifecycles)})`),
    check("tickets_queued_angle", sql`${table.queuedAngle} in (${literals(launchAngles)})`),
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
 * What a sub-session handed over when its step ended. One row per report rather
 * than one per ticket: a ticket corrected after a red sheet reports again, and
 * what was checked the first time stays readable.
 */
export const stepReports = sqliteTable(
  "step_reports",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** The sub-session that reported, which is the one a correction goes back to. */
    sessionId: text("session_id").notNull(),
    summary: text("summary").notNull(),
    recommendation: text("recommendation").notNull(),
    /** The developer's general return, written when they went through the sheet. */
    feedback: text("feedback"),
    /** When the sheet was gone through; null while it is still waiting. */
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("step_reports_ticket_idx").on(table.ticketId)],
);

/**
 * What the agent declared, criterion by criterion: covered by an automatic test,
 * or not. Kept even for the covered ones, which are exactly the ones absent from
 * the test sheet: without this row nothing would say the agent had claimed to
 * automate them.
 */
export const criterionCoverage = sqliteTable(
  "criterion_coverage",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => stepReports.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id")
      .notNull()
      .references(() => acceptanceCriteria.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** The criterion as it read when the step was reported. */
    text: text("text").notNull(),
    covered: integer("covered", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reportId, table.criterionId] }),
    index("criterion_coverage_report_idx").on(table.reportId),
  ],
);

/**
 * The test sheet itself: the points a human has to check by hand. Written down
 * rather than recomputed from the ticket at each read, so criteria adjusted
 * after a report cannot change what was put in front of the developer.
 *
 * `criterion_id` is what tells a criterion left uncovered from something the
 * agent suggested on its own; the wording never has to be read to know which.
 */
export const testSheetPoints = sqliteTable(
  "test_sheet_points",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => stepReports.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** The criterion this point stands for, or null when the agent suggested it. */
    criterionId: text("criterion_id").references(() => acceptanceCriteria.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    verdict: text("verdict", { enum: sheetVerdicts }).notNull().default("pending"),
    comment: text("comment"),
  },
  (table) => [
    index("test_sheet_points_report_idx").on(table.reportId),
    unique("test_sheet_points_position").on(table.reportId, table.position),
    check("test_sheet_points_verdict", sql`${table.verdict} in (${literals(sheetVerdicts)})`),
  ],
);

/**
 * Squad's own settings, machine-wide. One row, held to one by a constraint
 * rather than by a convention: a second row would make "the settings" ambiguous
 * without anything saying so.
 */
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    /** Where an alert is posted besides the desktop; null when none is set. */
    webhookUrl: text("webhook_url"),
    desktopNotifications: integer("desktop_notifications", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * How many sub-sessions may run at once on this machine, every project and
     * every feature together.
     */
    machineConcurrencyCap: integer("machine_concurrency_cap")
      .notNull()
      .default(defaultConcurrencyCaps.machine),
  },
  (table) => [check("settings_single_row", sql`${table.id} = 1`)],
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
