CREATE TABLE `destination_aliases` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_aliases_normalized_alias_idx` ON `destination_aliases` (`normalized_alias`);--> statement-breakpoint
CREATE TABLE `destinations` (
	`id` integer PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`type` text DEFAULT 'OTHER' NOT NULL,
	`status` text DEFAULT 'PROVISIONAL' NOT NULL,
	`first_seen_batch_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `destinations_normalized_name_idx` ON `destinations` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `knowledge_analysis_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`transcript_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version_id` integer NOT NULL,
	`input_signature` text NOT NULL,
	`status` text DEFAULT 'COMPLETED' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `knowledge_evidence` (
	`id` integer PRIMARY KEY NOT NULL,
	`knowledge_id` integer NOT NULL,
	`knowledge_version_id` integer NOT NULL,
	`batch_id` integer,
	`audio_id` integer,
	`transcript_id` integer NOT NULL,
	`segment_id` integer,
	`source_text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_version_id`) REFERENCES `knowledge_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`segment_id`) REFERENCES `transcript_segments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledge_evidence_knowledge_id_idx` ON `knowledge_evidence` (`knowledge_id`);--> statement-breakpoint
CREATE TABLE `knowledge_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer,
	`knowledge_type` text NOT NULL,
	`category` text,
	`entity_type` text,
	`entity_name` text,
	`attribute` text,
	`identity_key` text NOT NULL,
	`canonical_text` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`first_seen_batch_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledge_items_identity_key_idx` ON `knowledge_items` (`identity_key`);--> statement-breakpoint
CREATE TABLE `knowledge_versions` (
	`id` integer PRIMARY KEY NOT NULL,
	`knowledge_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`value_text` text,
	`value_json` text,
	`unit` text,
	`qualifiers_json` text,
	`canonical_text` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledge_versions_knowledge_id_idx` ON `knowledge_versions` (`knowledge_id`);--> statement-breakpoint
CREATE INDEX `knowledge_versions_current_idx` ON `knowledge_versions` (`knowledge_id`) WHERE is_current = 1;--> statement-breakpoint
CREATE TABLE `transcript_destinations` (
	`id` integer PRIMARY KEY NOT NULL,
	`transcript_id` integer NOT NULL,
	`destination_id` integer NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transcript_destinations_transcript_id_idx` ON `transcript_destinations` (`transcript_id`);--> statement-breakpoint
CREATE INDEX `transcript_destinations_destination_id_idx` ON `transcript_destinations` (`destination_id`);