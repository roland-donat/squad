CREATE TABLE `criterion_coverage` (
	`report_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`covered` integer NOT NULL,
	PRIMARY KEY(`report_id`, `criterion_id`),
	FOREIGN KEY (`report_id`) REFERENCES `step_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `criterion_coverage_report_idx` ON `criterion_coverage` (`report_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`webhook_url` text,
	`desktop_notifications` integer DEFAULT true NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `step_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`session_id` text NOT NULL,
	`summary` text NOT NULL,
	`recommendation` text NOT NULL,
	`feedback` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `step_reports_ticket_idx` ON `step_reports` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `test_sheet_points` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`position` integer NOT NULL,
	`criterion_id` text,
	`text` text NOT NULL,
	`verdict` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	FOREIGN KEY (`report_id`) REFERENCES `step_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_sheet_points_verdict" CHECK("test_sheet_points"."verdict" in ('pending', 'passed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `test_sheet_points_report_idx` ON `test_sheet_points` (`report_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_sheet_points_position` ON `test_sheet_points` (`report_id`,`position`);--> statement-breakpoint
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
	CONSTRAINT "tickets_lifecycle" CHECK("__new_tickets"."lifecycle" in ('unstarted', 'running', 'awaiting-validation', 'failed', 'interrupted', 'merged', 'settled'))
);
--> statement-breakpoint
INSERT INTO `__new_tickets`("id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", "created_at") SELECT "id", "feature_id", "kind", "title", "description", "lifecycle", "external_id", "conclusion", "branch", "worktree_path", "session_id", "created_at" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tickets_feature_idx` ON `tickets` (`feature_id`);