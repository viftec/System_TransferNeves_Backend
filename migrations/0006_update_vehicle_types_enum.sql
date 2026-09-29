-- Update vehicles table type enum to include van and caminhonete
-- SQLite doesn't support ALTER COLUMN for enum changes, so we recreate the table
CREATE TABLE `vehicles_new` (
  `id` text PRIMARY KEY NOT NULL,
  `driver_id` text NOT NULL,
  `type` text NOT NULL CHECK(`type` IN ('sedan', 'suv', 'hatch', 'van', 'caminhonete', 'caminhao')),
  `model` text NOT NULL,
  `plate` text NOT NULL UNIQUE,
  `year` integer,
  `color` text,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action
);

-- Copy data from old table
INSERT INTO `vehicles_new` SELECT * FROM `vehicles`;

-- Drop old table
DROP TABLE `vehicles`;

-- Rename new table
ALTER TABLE `vehicles_new` RENAME TO `vehicles`;
