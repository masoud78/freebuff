CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`workspace_path` text NOT NULL,
	`processing_concurrency` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
