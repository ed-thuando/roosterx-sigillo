CREATE TABLE `project_member` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`environment_id` text,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_project_member_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_member_environment_id_environment_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `api_token` ADD `capability` text DEFAULT 'read-write' NOT NULL;--> statement-breakpoint
CREATE INDEX `project_member_project_id_idx` ON `project_member` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_member_user_id_idx` ON `project_member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_member_project_user_env_unique` ON `project_member` (`project_id`,`user_id`,`environment_id`);