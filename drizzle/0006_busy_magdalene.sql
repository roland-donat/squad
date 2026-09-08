ALTER TABLE `projects` ADD `feature_concurrency_cap` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `machine_concurrency_cap` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
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
	`queued_at` text,
	`queued_angle` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tickets_kind" CHECK("__new_tickets"."kind" in ('build', 'decision', 'fix')),
	CONSTRAINT "tickets_lifecycle" CHECK("__new_tickets"."lifecycle" in ('unstarted', 'running', 'awaiting-validation', 'failed', 'interrupted', 'merged', 'settled')),
	CONSTRAINT "tickets_queued_angle" CHECK("__new_tickets"."queued_angle" in ('implement', 'diagnose'))
);
--> statement-breakpoint
-- the two new columns are selected as NULL: the table being copied predates
-- them, and no ticket written before this migration is waiting for a place.
INSERT INTO `__new_tickets`("id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", "queued_at", "queued_angle", "created_at") SELECT "id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", NULL, NULL, "created_at" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tickets_feature_idx` ON `tickets` (`feature_id`);