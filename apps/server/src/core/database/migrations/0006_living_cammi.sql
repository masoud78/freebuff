CREATE TABLE `delta_metrics` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer,
	`metric_key` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delta_metrics_batch_key_unique_idx` ON `delta_metrics` (`batch_id`,`metric_key`);--> statement-breakpoint
CREATE TABLE `knowledge_candidates` (
	`id` integer PRIMARY KEY NOT NULL,
	`analysis_run_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`transcript_id` integer NOT NULL,
	`destination_id` integer,
	`knowledge_type` text NOT NULL,
	`category` text,
	`entity_type` text,
	`entity_name` text,
	`attribute` text,
	`value_text` text,
	`value_json` text,
	`unit` text,
	`qualifiers_json` text,
	`canonical_text` text NOT NULL,
	`identity_key` text NOT NULL,
	`value_hash` text NOT NULL,
	`confidence` integer DEFAULT 0.5 NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `knowledge_analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledge_candidates_destination_identity_idx` ON `knowledge_candidates` (`destination_id`,`identity_key`);--> statement-breakpoint
CREATE INDEX `knowledge_candidates_status_idx` ON `knowledge_candidates` (`status`);--> statement-breakpoint
CREATE INDEX `knowledge_candidates_transcript_idx` ON `knowledge_candidates` (`transcript_id`);--> statement-breakpoint
CREATE INDEX `knowledge_candidates_batch_idx` ON `knowledge_candidates` (`batch_id`);--> statement-breakpoint
CREATE TABLE `knowledge_delta_decisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`candidate_id` integer NOT NULL,
	`destination_id` integer,
	`decision` text NOT NULL,
	`matched_knowledge_id` integer,
	`matched_version_id` integer,
	`matched_candidate_id` integer,
	`reason_code` text,
	`confidence` integer DEFAULT 0.5 NOT NULL,
	`reasoning_summary` text,
	`input_signature` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `knowledge_candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_delta_decisions_candidate_unique_idx` ON `knowledge_delta_decisions` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `knowledge_delta_decisions_destination_idx` ON `knowledge_delta_decisions` (`destination_id`);--> statement-breakpoint
CREATE TABLE `knowledge_embeddings` (
	`id` integer PRIMARY KEY NOT NULL,
	`knowledge_id` integer,
	`knowledge_version_id` integer,
	`candidate_id` integer,
	`model_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`dimensions` integer NOT NULL,
	`embedding` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_embeddings_model_source_unique_idx` ON `knowledge_embeddings` (`model_id`,`source_hash`);--> statement-breakpoint
CREATE INDEX `knowledge_embeddings_knowledge_id_idx` ON `knowledge_embeddings` (`knowledge_id`);