ALTER TABLE `features` ADD `resumed_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `features_resumed_session_id_unique` ON `features` (`resumed_session_id`);