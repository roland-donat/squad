ALTER TABLE `step_reports` RENAME COLUMN "summary" TO "work";--> statement-breakpoint
ALTER TABLE `features` ADD `running_example` text;--> statement-breakpoint
ALTER TABLE `question_options` ADD `consequence` text;--> statement-breakpoint
ALTER TABLE `question_options` ADD `illustration` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `summary_context` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `summary_problem` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `summary_example` text;