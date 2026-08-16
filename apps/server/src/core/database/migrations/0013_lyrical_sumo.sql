CREATE TABLE `destination_audience_insights` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`inference_basis` text NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`content_opportunity_title` text,
	`content_opportunity_reason` text,
	`status` text DEFAULT 'CURRENT' NOT NULL,
	`first_observed_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_audience_insights_destination_idx` ON `destination_audience_insights` (`destination_id`);--> statement-breakpoint
CREATE INDEX `destination_audience_insights_status_idx` ON `destination_audience_insights` (`status`);--> statement-breakpoint
CREATE TABLE `destination_insight_sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`insight_id` integer NOT NULL,
	`audio_id` integer,
	`transcript_id` integer NOT NULL,
	`processing_session_id` integer,
	`evidence_summary` text,
	`audio_name_snapshot` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`insight_id`) REFERENCES `destination_audience_insights`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `destination_insight_sources_unique_idx` ON `destination_insight_sources` (`insight_id`,`transcript_id`);--> statement-breakpoint
CREATE INDEX `destination_insight_sources_insight_idx` ON `destination_insight_sources` (`insight_id`);--> statement-breakpoint
CREATE TABLE `insight_proposals` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`transcript_id` integer NOT NULL,
	`audio_id` integer NOT NULL,
	`destination_id` integer,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`inference_basis` text NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`content_opportunity_title` text,
	`content_opportunity_reason` text,
	`proposed_action` text NOT NULL,
	`matched_insight_id` integer,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `insight_proposals_batch_idx` ON `insight_proposals` (`batch_id`);--> statement-breakpoint
CREATE INDEX `insight_proposals_destination_idx` ON `insight_proposals` (`destination_id`);--> statement-breakpoint
CREATE TABLE `processing_destination_news` (
	`id` integer PRIMARY KEY NOT NULL,
	`processing_session_id` integer NOT NULL,
	`destination_id` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`processing_session_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_destination_news_unique_idx` ON `processing_destination_news` (`processing_session_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `processing_destination_news_session_idx` ON `processing_destination_news` (`processing_session_id`);--> statement-breakpoint
ALTER TABLE `destination_notes` ADD `note_kind` text DEFAULT 'DESTINATION_INFO' NOT NULL;--> statement-breakpoint
ALTER TABLE `destination_notes` ADD `scope_type` text DEFAULT 'DESTINATION' NOT NULL;--> statement-breakpoint
ALTER TABLE `destination_notes` ADD `tour_subject` text;--> statement-breakpoint
ALTER TABLE `note_proposals` ADD `note_kind` text DEFAULT 'DESTINATION_INFO' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_proposals` ADD `scope_type` text DEFAULT 'DESTINATION' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_proposals` ADD `tour_subject` text;