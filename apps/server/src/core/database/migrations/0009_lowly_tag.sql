CREATE INDEX `api_usage_batch_stage_idx` ON `api_usage` (`batch_id`,`stage`);--> statement-breakpoint
CREATE INDEX `api_usage_destination_idx` ON `api_usage` (`destination_id`);