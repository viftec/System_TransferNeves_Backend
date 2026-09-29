-- Migration 0009: Fix ride_events FK (points to old_rides) and drop old_rides
--
-- Root cause: migration 0008 renamed `rides` → `old_rides`. SQLite automatically
-- updated the FK in ride_events so it now points to `old_rides` instead of `rides`.
-- Any ride created AFTER migration 0008 only exists in the new `rides` table,
-- so inserting ride_events for those rides fails with FOREIGN KEY constraint error.
--
-- Fix: recreate ride_events with FK pointing to the new `rides` table, then drop old_rides.

PRAGMA foreign_keys=OFF;

-- 1. Backup existing ride_events data
CREATE TABLE _ride_events_backup AS SELECT * FROM ride_events;

-- 2. Drop the broken ride_events table (FK → old_rides)
DROP TABLE ride_events;

-- 3. Recreate ride_events with correct FK → rides
CREATE TABLE `ride_events` (
  `id` text PRIMARY KEY NOT NULL,
  `ride_id` text NOT NULL REFERENCES `rides`(`id`),
  `event` text NOT NULL,
  `description` text NOT NULL,
  `user_id` text REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

-- 4. Restore only events whose ride_id exists in the new rides table
INSERT INTO ride_events
  SELECT * FROM _ride_events_backup
  WHERE ride_id IN (SELECT id FROM rides);

-- 5. Clean up backup
DROP TABLE _ride_events_backup;

-- 6. Now drop old_rides safely (no FK references it anymore)
DROP TABLE IF EXISTS old_rides;

-- 7. Recreate index
CREATE INDEX IF NOT EXISTS `idx_ride_events_ride` ON `ride_events`(`ride_id`);

PRAGMA foreign_keys=ON;
