PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`lifecycle` text DEFAULT 'unstarted' NOT NULL,
	`external_id` text,
	`conclusion` text,
	`branch` text,
	`worktree_path` text,
	`session_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tickets_kind" CHECK("__new_tickets"."kind" in ('build', 'decision', 'fix')),
	CONSTRAINT "tickets_lifecycle" CHECK("__new_tickets"."lifecycle" in ('unstarted', 'running', 'failed', 'interrupted', 'merged', 'settled'))
);
--> statement-breakpoint
-- `branch`, `worktree_path` and `session_id` arrive with this migration, so
-- they are left out of the copy: reading them from the old table would fail.
-- Hand-corrected: drizzle-kit selects the new columns from the old shape when a
-- table is recreated for a constraint change and widened in the same step.
INSERT INTO `__new_tickets`("id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "created_at") SELECT "id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "created_at" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tickets_feature_idx` ON `tickets` (`feature_id`);--> statement-breakpoint
ALTER TABLE `features` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `features` ADD `worktree_path` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_branch` text DEFAULT 'main' NOT NULL;