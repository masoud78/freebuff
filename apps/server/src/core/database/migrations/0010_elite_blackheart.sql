CREATE TABLE `destination_note_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer NOT NULL,
	`note_id` integer,
	`event_type` text NOT NULL,
	`source_audio_ids` text,
	`source_processing_session` integer,
	`reason` text,
	`old_version_id` integer,
	`new_version_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `destination_notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_note_logs_destination_idx` ON `destination_note_logs` (`destination_id`);--> statement-breakpoint
CREATE INDEX `destination_note_logs_note_idx` ON `destination_note_logs` (`note_id`);--> statement-breakpoint
CREATE TABLE `destination_note_sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`audio_id` integer,
	`transcript_id` integer NOT NULL,
	`processing_session_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `destination_notes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `destination_note_sources_unique_idx` ON `destination_note_sources` (`note_id`,`transcript_id`);--> statement-breakpoint
CREATE INDEX `destination_note_sources_note_idx` ON `destination_note_sources` (`note_id`);--> statement-breakpoint
CREATE TABLE `destination_note_versions` (
	`id` integer PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`relevant_date` text,
	`source_processing_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `destination_notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_note_versions_note_idx` ON `destination_note_versions` (`note_id`);--> statement-breakpoint
CREATE TABLE `destination_notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer NOT NULL,
	`current_title` text NOT NULL,
	`current_description` text NOT NULL,
	`status` text DEFAULT 'CURRENT' NOT NULL,
	`relevant_date` text,
	`first_observed_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_notes_destination_idx` ON `destination_notes` (`destination_id`);--> statement-breakpoint
CREATE INDEX `destination_notes_status_idx` ON `destination_notes` (`status`);--> statement-breakpoint
CREATE TABLE `note_proposals` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`transcript_id` integer NOT NULL,
	`audio_id` integer NOT NULL,
	`destination_id` integer,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`relevant_date` text,
	`proposed_action` text NOT NULL,
	`matched_note_id` integer,
	`reason_summary` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `note_proposals_batch_idx` ON `note_proposals` (`batch_id`);--> statement-breakpoint
CREATE INDEX `note_proposals_destination_idx` ON `note_proposals` (`destination_id`);--> statement-breakpoint
CREATE TABLE `voice_reports` (
	`id` integer PRIMARY KEY NOT NULL,
	`audio_id` integer NOT NULL,
	`transcript_id` integer NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_reports_audio_unique_idx` ON `voice_reports` (`audio_id`);--> statement-breakpoint
ALTER TABLE `batches` ADD `session_stage` text DEFAULT 'UPLOAD' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_embeddings` ADD `note_id` integer;