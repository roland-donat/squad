import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  defaultBranch: text("default_branch").notNull(),
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
