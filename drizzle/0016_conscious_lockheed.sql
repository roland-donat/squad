PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_test_sheet_points` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`position` integer NOT NULL,
	`criterion_id` text,
	`text` text NOT NULL,
	`verdict` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	`settlement` text,
	`settlement_note` text,
	`settlement_recommendation` text,
	`settlement_scope_changing` integer,
	FOREIGN KEY (`report_id`) REFERENCES `step_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_sheet_points_verdict" CHECK("__new_test_sheet_points"."verdict" in ('pending', 'passed', 'failed')),
	CONSTRAINT "test_sheet_points_settlement" CHECK("__new_test_sheet_points"."settlement" is null or "__new_test_sheet_points"."settlement" in ('holds', 'broken', 'human', 'decision'))
);
--> statement-breakpoint
INSERT INTO `__new_test_sheet_points`("id", "report_id", "position", "criterion_id", "text", "verdict", "comment", "settlement", "settlement_note", "settlement_recommendation", "settlement_scope_changing") SELECT "id", "report_id", "position", "criterion_id", "text", "verdict", "comment", "settlement", "settlement_note", NULL, NULL FROM `test_sheet_points`;--> statement-breakpoint
DROP TABLE `test_sheet_points`;--> statement-breakpoint
ALTER TABLE `__new_test_sheet_points` RENAME TO `test_sheet_points`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `test_sheet_points_report_idx` ON `test_sheet_points` (`report_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_sheet_points_position` ON `test_sheet_points` (`report_id`,`position`);