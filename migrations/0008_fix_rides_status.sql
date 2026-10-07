PRAGMA foreign_keys=OFF;

ALTER TABLE `rides` RENAME TO `old_rides`;

CREATE TABLE `rides` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL UNIQUE,
  `client_id` text REFERENCES `clients`(`id`),
  `client_name` text,
  `driver_id` text REFERENCES `drivers`(`id`),
  `vehicle_id` text REFERENCES `vehicles`(`id`),
  `type` text NOT NULL CHECK(`type` IN ('passageiros','carga')),
  `passenger_count` integer,
  `has_luggage` integer NOT NULL DEFAULT 0,
  `luggage_description` text,
  `cargo_type` text,
  `cargo_weight_kg` real,
  `cargo_width` real,
  `cargo_length` real,
  `cargo_height` real,
  `cargo_fragile` integer NOT NULL DEFAULT 0,
  `origin_street` text,
  `origin_number` text,
  `origin_neighborhood` text,
  `origin_city` text NOT NULL,
  `origin_state` text,
  `origin_cep` text,
  `dest_street` text,
  `dest_number` text,
  `dest_neighborhood` text,
  `dest_city` text NOT NULL,
  `dest_state` text,
  `dest_cep` text,
  `city` text,
  `scheduled_date` text NOT NULL,
  `scheduled_time` text NOT NULL,
  `value` real NOT NULL,
  `payment_method` text NOT NULL DEFAULT 'billed' CHECK(`payment_method` IN ('card','transfer','cash','billed')),
  `status` text NOT NULL DEFAULT 'disponivel', 
  `notes` text,
  `is_recurring` integer NOT NULL DEFAULT 0,
  `requires_photo` integer NOT NULL DEFAULT 0,
  `is_urgent` integer NOT NULL DEFAULT 0,
  `allow_cancellation` integer NOT NULL DEFAULT 1,
  `show_value_to_driver` integer NOT NULL DEFAULT 1,
  `proof_key` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  `deleted_at` text
);

INSERT INTO `rides` (
  id, code, client_id, client_name, driver_id, vehicle_id, type, 
  passenger_count, has_luggage, luggage_description, cargo_type, 
  cargo_weight_kg, cargo_width, cargo_length, cargo_height, cargo_fragile, 
  origin_street, origin_number, origin_neighborhood, 
  origin_city, origin_state, origin_cep, dest_street, dest_number, 
  dest_neighborhood, dest_city, dest_state, dest_cep, city, 
  scheduled_date, scheduled_time, value, payment_method, status, 
  notes, is_recurring, requires_photo, is_urgent, allow_cancellation, 
  show_value_to_driver, proof_key, created_at, updated_at, deleted_at
) 
SELECT 
  id, code, client_id, client_name, driver_id, vehicle_id, type, 
  passenger_count, has_luggage, luggage_description, cargo_type, 
  cargo_weight_kg, cargo_width, cargo_length, cargo_height, cargo_fragile, 
  origin_street, origin_number, origin_neighborhood, 
  origin_city, origin_state, origin_cep, dest_street, dest_number, 
  dest_neighborhood, dest_city, dest_state, dest_cep, city, 
  scheduled_date, scheduled_time, value, payment_method, status, 
  notes, is_recurring, requires_photo, is_urgent, allow_cancellation, 
  show_value_to_driver, proof_key, created_at, updated_at, deleted_at 
FROM `old_rides`;

-- DROP TABLE `old_rides`; -- Commented out to prevent FK constraint failure in SQLite D1

CREATE INDEX IF NOT EXISTS `idx_rides_status` ON `rides`(`status`);
CREATE INDEX IF NOT EXISTS `idx_rides_driver` ON `rides`(`driver_id`);
CREATE INDEX IF NOT EXISTS `idx_rides_client` ON `rides`(`client_id`);
CREATE INDEX IF NOT EXISTS `idx_rides_date` ON `rides`(`scheduled_date`);

PRAGMA foreign_keys=ON;
