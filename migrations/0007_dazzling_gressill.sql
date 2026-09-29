CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`endpoint` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_attempt` text DEFAULT (datetime('now')) NOT NULL,
	`blocked_until` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
