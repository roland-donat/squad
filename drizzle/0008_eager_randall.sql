CREATE TABLE `question_options` (
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`question_id`, `position`),
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_options_question_idx` ON `question_options` (`question_id`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`ticket_id` text,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`recommendation` text NOT NULL,
	`scope_changing` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`answered_by` text,
	`answered_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "questions_state" CHECK("questions"."state" in ('pending', 'answered', 'abandoned')),
	CONSTRAINT "questions_answered_by" CHECK("questions"."answered_by" in ('developer', 'squad'))
);
--> statement-breakpoint
CREATE INDEX `questions_feature_idx` ON `questions` (`feature_id`);--> statement-breakpoint
CREATE INDEX `questions_ticket_idx` ON `questions` (`ticket_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`pull_request_url` text,
	`go_as_recommended` integer DEFAULT false NOT NULL,
	`autonomy_halt_reason` text,
	`autonomy_halt_detail` text,
	`autonomy_halted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "features_autonomy_halt_reason" CHECK("__new_features"."autonomy_halt_reason" in ('scope-question', 'decision', 'failure', 'depth-cap'))
);
--> statement-breakpoint
-- Corrected by hand, as drizzle/0004 was: drizzle-kit recreates this table for
-- the new check constraint and copies it by selecting the columns of the new
-- shape, four of which do not exist in the old one. An existing database would
-- fail here, and a fresh one would not: the copy therefore names what is really
-- there and writes the defaults for the rest.
INSERT INTO `__new_features`("id", "project_id", "title", "branch", "worktree_path", "pull_request_url", "go_as_recommended", "autonomy_halt_reason", "autonomy_halt_detail", "autonomy_halted_at", "created_at") SELECT "id", "project_id", "title", "branch", "worktree_path", "pull_request_url", 0, NULL, NULL, NULL, "created_at" FROM `features`;--> statement-breakpoint
DROP TABLE `features`;--> statement-breakpoint
ALTER TABLE `__new_features` RENAME TO `features`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `settings` ADD `generation_depth_cap` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `generation` integer DEFAULT 0 NOT NULL;