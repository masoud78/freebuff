CREATE TABLE `generated_content_knowledge` (
	`id` integer PRIMARY KEY NOT NULL,
	`generated_content_id` integer NOT NULL,
	`knowledge_id` integer NOT NULL,
	`knowledge_version_id` integer NOT NULL,
	`change_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`generated_content_id`) REFERENCES `generated_contents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_version_id`) REFERENCES `knowledge_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_id`) REFERENCES `knowledge_changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generated_content_knowledge_unique_idx` ON `generated_content_knowledge` (`generated_content_id`,`change_id`);--> statement-breakpoint
CREATE INDEX `generated_content_knowledge_knowledge_idx` ON `generated_content_knowledge` (`knowledge_id`);--> statement-breakpoint
CREATE TABLE `generated_contents` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`destination_id` integer,
	`content` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version_id` integer NOT NULL,
	`delta_signature` text NOT NULL,
	`generation_number` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'GENERATED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generated_contents_batch_dest_gen_unique_idx` ON `generated_contents` (`batch_id`,`destination_id`,`generation_number`);--> statement-breakpoint
CREATE INDEX `generated_contents_batch_idx` ON `generated_contents` (`batch_id`);--> statement-breakpoint
CREATE INDEX `generated_contents_destination_idx` ON `generated_contents` (`destination_id`);--> statement-breakpoint
ALTER TABLE `api_usage` ADD `destination_id` integer;