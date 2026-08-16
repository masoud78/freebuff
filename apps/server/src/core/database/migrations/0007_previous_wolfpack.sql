CREATE TABLE `batch_destination_summaries` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`destination_id` integer NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`confirmation_count` integer DEFAULT 0 NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`ignored_count` integer DEFAULT 0 NOT NULL,
	`publishable_delta_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'FINALIZED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batch_destination_summaries_unique_idx` ON `batch_destination_summaries` (`batch_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `batch_destination_summaries_batch_idx` ON `batch_destination_summaries` (`batch_id`);--> statement-breakpoint
CREATE TABLE `knowledge_changes` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`destination_id` integer,
	`knowledge_id` integer NOT NULL,
	`change_type` text NOT NULL,
	`old_version_id` integer,
	`new_version_id` integer NOT NULL,
	`source_decision_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`old_version_id`) REFERENCES `knowledge_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`new_version_id`) REFERENCES `knowledge_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_decision_id`) REFERENCES `knowledge_delta_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_changes_decision_unique_idx` ON `knowledge_changes` (`source_decision_id`);--> statement-breakpoint
CREATE INDEX `knowledge_changes_batch_destination_idx` ON `knowledge_changes` (`batch_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `knowledge_changes_knowledge_idx` ON `knowledge_changes` (`knowledge_id`);--> statement-breakpoint
CREATE TABLE `knowledge_conflicts` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_id` integer,
	`knowledge_id` integer,
	`candidate_id` integer NOT NULL,
	`existing_version_id` integer,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`conflict_type` text,
	`conflict_group_key` text NOT NULL,
	`resolution_note` text,
	`resolved_version_id` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `knowledge_candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`existing_version_id`) REFERENCES `knowledge_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_conflicts_candidate_unique_idx` ON `knowledge_conflicts` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `knowledge_conflicts_destination_status_idx` ON `knowledge_conflicts` (`destination_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_conflicts_group_idx` ON `knowledge_conflicts` (`conflict_group_key`);--> statement-breakpoint
ALTER TABLE `knowledge_candidates` ADD `source_segment_id` integer;--> statement-breakpoint
ALTER TABLE `knowledge_candidates` ADD `source_text` text;--> statement-breakpoint
ALTER TABLE `knowledge_delta_decisions` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `knowledge_items` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `knowledge_items` ADD `last_seen_batch_id` integer;--> statement-breakpoint
ALTER TABLE `knowledge_items` ADD `last_seen_at` integer;--> statement-breakpoint
CREATE INDEX `knowledge_items_destination_idx` ON `knowledge_items` (`destination_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_canonical_unique_idx` ON `knowledge_items` (`destination_id`,`identity_key`) WHERE status IN ('ACTIVE', 'PROVISIONAL');--> statement-breakpoint
CREATE INDEX `knowledge_evidence_transcript_idx` ON `knowledge_evidence` (`transcript_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_evidence_source_unique_idx` ON `knowledge_evidence` (`knowledge_id`,`knowledge_version_id`,`transcript_id`,`segment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_versions_one_current_idx` ON `knowledge_versions` (`knowledge_id`) WHERE is_current = 1;