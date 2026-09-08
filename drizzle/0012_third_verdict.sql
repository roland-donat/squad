PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_criterion_coverage` (
	`report_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`verdict` text NOT NULL,
	`note` text,
	PRIMARY KEY(`report_id`, `criterion_id`),
	FOREIGN KEY (`report_id`) REFERENCES `step_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "criterion_coverage_verdict" CHECK("__new_criterion_coverage"."verdict" in ('automated', 'checked', 'judgement'))
);
--> statement-breakpoint
INSERT INTO `__new_criterion_coverage`("report_id", "criterion_id", "position", "text", "verdict", "note") SELECT "report_id", "criterion_id", "position", "text", CASE WHEN "covered" THEN 'automated' ELSE 'judgement' END, NULL FROM `criterion_coverage`;--> statement-breakpoint
DROP TABLE `criterion_coverage`;--> statement-breakpoint
ALTER TABLE `__new_criterion_coverage` RENAME TO `criterion_coverage`;--> statement-breakpoint
CREATE INDEX `criterion_coverage_report_idx` ON `criterion_coverage` (`report_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
