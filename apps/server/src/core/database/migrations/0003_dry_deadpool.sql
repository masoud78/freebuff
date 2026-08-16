CREATE TABLE `audio_files` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`original_name` text NOT NULL,
	`absolute_path` text NOT NULL,
	`extension` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text DEFAULT 'DISCOVERED' NOT NULL,
	`duplicate_of_audio_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audio_files_sha256_idx` ON `audio_files` (`sha256`);--> statement-breakpoint
CREATE INDEX `audio_files_batch_id_idx` ON `audio_files` (`batch_id`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'CREATED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`job_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`idempotency_key` text NOT NULL,
	`locked_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique_idx` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_batch_id_idx` ON `jobs` (`batch_id`);