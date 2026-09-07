CREATE TABLE `thread_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`ticket_id` text,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_entries_kind" CHECK("thread_entries"."kind" in ('pilot', 'agent', 'tool', 'notice'))
);
--> statement-breakpoint
CREATE INDEX `thread_entries_feature_idx` ON `thread_entries` (`feature_id`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `conclusion` text;