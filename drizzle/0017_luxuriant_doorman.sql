PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`merge_head` text,
	`session_id` text,
	`queued_at` text,
	`queued_angle` text,
	`service_job` text,
	`service_queued_at` text,
	`service_started_at` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tickets_kind" CHECK("__new_tickets"."kind" in ('build', 'decision', 'fix')),
	CONSTRAINT "tickets_lifecycle" CHECK("__new_tickets"."lifecycle" in ('unstarted', 'running', 'awaiting-validation', 'merging', 'failed', 'interrupted', 'conflict', 'merged', 'settled', 'discarded')),
	CONSTRAINT "tickets_queued_angle" CHECK("__new_tickets"."queued_angle" in ('implement', 'diagnose')),
	CONSTRAINT "tickets_service_job" CHECK("__new_tickets"."service_job" in ('settling', 'resolving'))
);
--> statement-breakpoint
INSERT INTO `__new_tickets`("id", "feature_id", "project_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "merge_head", "session_id", "queued_at", "queued_angle", "service_job", "service_queued_at", "service_started_at", "generation", "created_at") SELECT "id", "feature_id", "project_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "merge_head", "session_id", "queued_at", "queued_angle", "service_job", "service_queued_at", "service_started_at", "generation", "created_at" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tickets_feature_idx` ON `tickets` (`feature_id`);