ALTER TABLE `audio_files` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `destination_note_sources` ADD `audio_name_snapshot` text;--> statement-breakpoint
ALTER TABLE `note_proposals` ADD `log_reason` text;--> statement-breakpoint
ALTER TABLE `voice_reports` ADD `conversation_topic` text;--> statement-breakpoint
ALTER TABLE `voice_reports` ADD `result_status` text DEFAULT 'ACTIONABLE' NOT NULL;