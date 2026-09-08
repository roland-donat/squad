CREATE TABLE `feature_repositories` (
	`feature_id` text NOT NULL,
	`project_id` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`pull_request_url` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`feature_id`, `project_id`),
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feature_repositories_feature_idx` ON `feature_repositories` (`feature_id`);--> statement-breakpoint
-- Written by hand, and it is the whole point of this migration: what used to be
-- three columns on a feature becomes one row per repository it carries. Every
-- feature written before this carried exactly one, its own project, so the copy
-- is one row each. It runs before the columns are dropped below, or it would
-- read what is no longer there.
INSERT INTO `feature_repositories`("feature_id", "project_id", "branch", "worktree_path", "pull_request_url", "created_at") SELECT "id", "project_id", "branch", "worktree_path", "pull_request_url", "created_at" FROM `features`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Written by hand as well: drizzle-kit emits an `ALTER TABLE ... ADD` for a
-- column that is NOT NULL without a default, which SQLite refuses on a table
-- that has rows. The twelve-step rebuild is what it asks for instead, and the
-- copy fills the new column from the feature each ticket belongs to, since
-- until now a feature carried exactly one repository.
CREATE TABLE `__new_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`lifecycle` text DEFAULT 'unstarted' NOT NULL,
	`external_id` text,
	`conclusion` text,
	`branch` text,
	`worktree_path` text,
	`session_id` text,
	`queued_at` text,
	`queued_angle` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tickets_kind" CHECK("__new_tickets"."kind" in ('build', 'decision', 'fix')),
	CONSTRAINT "tickets_lifecycle" CHECK("__new_tickets"."lifecycle" in ('unstarted', 'running', 'awaiting-validation', 'merging', 'failed', 'interrupted', 'conflict', 'merged', 'settled')),
	CONSTRAINT "tickets_queued_angle" CHECK("__new_tickets"."queued_angle" in ('implement', 'diagnose'))
);
--> statement-breakpoint
INSERT INTO `__new_tickets`("id", "feature_id", "project_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", "queued_at", "queued_angle", "generation", "created_at") SELECT "id", "feature_id", (SELECT "project_id" FROM `features` WHERE `features`."id" = `tickets`."feature_id"), "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", "queued_at", "queued_angle", "generation", "created_at" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tickets_feature_idx` ON `tickets` (`feature_id`);--> statement-breakpoint
ALTER TABLE `features` DROP COLUMN `branch`;--> statement-breakpoint
ALTER TABLE `features` DROP COLUMN `worktree_path`;--> statement-breakpoint
ALTER TABLE `features` DROP COLUMN `pull_request_url`;