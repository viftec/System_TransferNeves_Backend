ALTER TABLE `rides` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `rides` ADD `has_luggage` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rides` ADD `luggage_description` text;--> statement-breakpoint
ALTER TABLE `rides` ADD `cargo_width` real;--> statement-breakpoint
ALTER TABLE `rides` ADD `cargo_length` real;--> statement-breakpoint
ALTER TABLE `rides` ADD `cargo_height` real;--> statement-breakpoint
ALTER TABLE `rides` ADD `cargo_fragile` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rides` ADD `cargo_notes` text;--> statement-breakpoint