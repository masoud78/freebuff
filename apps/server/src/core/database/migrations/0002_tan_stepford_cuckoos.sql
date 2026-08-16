CREATE TABLE `gemini_models` (
	`id` integer PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`capabilities_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gemini_models_model_id_unique` ON `gemini_models` (`model_id`);--> statement-breakpoint
CREATE TABLE `model_configs` (
	`id` integer PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_configs_stage_unique` ON `model_configs` (`stage`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` integer PRIMARY KEY NOT NULL,
	`prompt_type` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_templates_prompt_type_unique` ON `prompt_templates` (`prompt_type`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` integer PRIMARY KEY NOT NULL,
	`prompt_template_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`prompt_template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE no action
);
