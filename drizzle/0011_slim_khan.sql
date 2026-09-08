PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`webhook_url` text,
	`desktop_notifications` integer DEFAULT true NOT NULL,
	`machine_concurrency_cap` integer DEFAULT 4 NOT NULL,
	`generation_depth_cap` integer DEFAULT 3 NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("__new_settings"."id" = 1),
	CONSTRAINT "settings_theme" CHECK("__new_settings"."theme" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "webhook_url", "desktop_notifications", "machine_concurrency_cap", "generation_depth_cap", "theme") SELECT "id", "webhook_url", "desktop_notifications", "machine_concurrency_cap", "generation_depth_cap", 'system' FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;