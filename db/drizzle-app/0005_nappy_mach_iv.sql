ALTER TABLE `environment` ADD `locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `environment` ADD `visibility` text DEFAULT 'public' NOT NULL;