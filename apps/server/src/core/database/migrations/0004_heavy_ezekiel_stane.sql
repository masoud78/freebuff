CREATE TABLE `api_usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer,
	`job_id` integer,
	`audio_id` integer,
	`stage` text NOT NULL,
	`model_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`total_tokens` integer,
	`duration_ms` integer NOT NULL,
	`status` text DEFAULT 'SUCCESS' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` integer PRIMARY KEY NOT NULL,
	`transcript_id` integer NOT NULL,
	`sequence` integer NOT NULL,
	`speaker` text,
	`text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`text_hash` text NOT NULL,
	`start_time` integer,
	`end_time` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transcript_segments_transcript_id_idx` ON `transcript_segments` (`transcript_id`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` integer PRIMARY KEY NOT NULL,
	`audio_id` integer NOT NULL,
	`full_text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`normalized_hash` text NOT NULL,
	`language` text,
	`model_id` text NOT NULL,
	`prompt_version_id` integer NOT NULL,
	`status` text DEFAULT 'COMPLETED' NOT NULL,
	`duplicate_of_transcript_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_version_id`) REFERENCES `prompt_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_audio_completed_idx` ON `transcripts` (`audio_id`) WHERE status = 'COMPLETED';--> statement-breakpoint
CREATE INDEX `transcripts_normalized_hash_idx` ON `transcripts` (`normalized_hash`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `next_attempt_at` integer;