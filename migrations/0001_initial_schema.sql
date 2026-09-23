-- Migration gerada manualmente para Cloudflare D1
-- Execute: wrangler d1 migrations apply DB --local  (dev)
--          wrangler d1 migrations apply DB --remote  (produção)

CREATE TABLE IF NOT EXISTS `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL UNIQUE,
  `password_hash` text NOT NULL,
  `name` text NOT NULL,
  `role` text NOT NULL CHECK(`role` IN ('admin','driver')),
  `phone` text,
  `company` text DEFAULT 'Transfer Neves - VIFTEC',
  `active` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `drivers` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `cpf` text NOT NULL UNIQUE,
  `cnh` text NOT NULL,
  `cnh_expiry` text,
  `street` text,
  `number` text,
  `complement` text,
  `neighborhood` text,
  `city` text,
  `state` text,
  `cep` text,
  `status` text NOT NULL DEFAULT 'pending' CHECK(`status` IN ('pending','approved','online','offline','suspended')),
  `document_verified` integer NOT NULL DEFAULT 0,
  `rating` real DEFAULT 0,
  `total_rides` integer NOT NULL DEFAULT 0,
  `avatar_key` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `vehicles` (
  `id` text PRIMARY KEY NOT NULL,
  `driver_id` text NOT NULL REFERENCES `drivers`(`id`),
  `type` text NOT NULL CHECK(`type` IN ('sedan','suv','hatch','utilitario','caminhao')),
  `model` text NOT NULL,
  `plate` text NOT NULL UNIQUE,
  `year` integer,
  `color` text,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `clients` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `fantasy_name` text,
  `type` text NOT NULL CHECK(`type` IN ('pf','pj')),
  `cpf_cnpj` text NOT NULL UNIQUE,
  `phone` text NOT NULL,
  `whatsapp` text,
  `email` text,
  `secondary_phone` text,
  `street` text,
  `number` text,
  `complement` text,
  `neighborhood` text,
  `city` text,
  `state` text,
  `cep` text,
  `is_recurring` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active' CHECK(`status` IN ('active','inactive')),
  `notes` text,
  `total_rides` integer NOT NULL DEFAULT 0,
  `last_ride_date` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `rides` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL UNIQUE,
  `client_id` text REFERENCES `clients`(`id`),
  `driver_id` text REFERENCES `drivers`(`id`),
  `vehicle_id` text REFERENCES `vehicles`(`id`),
  `type` text NOT NULL CHECK(`type` IN ('passageiros','carga')),
  `passenger_count` integer,
  `cargo_type` text,
  `cargo_weight_kg` real,
  `vehicle_type` text,
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
  `status` text NOT NULL DEFAULT 'disponivel' CHECK(`status` IN ('disponivel','aceita','andamento','concluida','cancelada')),
  `notes` text,
  `requires_photo` integer NOT NULL DEFAULT 0,
  `is_urgent` integer NOT NULL DEFAULT 0,
  `allow_cancellation` integer NOT NULL DEFAULT 1,
  `show_value_to_driver` integer NOT NULL DEFAULT 1,
  `proof_key` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `ride_events` (
  `id` text PRIMARY KEY NOT NULL,
  `ride_id` text NOT NULL REFERENCES `rides`(`id`),
  `event` text NOT NULL,
  `description` text NOT NULL,
  `user_id` text REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `uploads` (
  `id` text PRIMARY KEY NOT NULL,
  `r2_key` text NOT NULL UNIQUE,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `content_type` text NOT NULL,
  `size_bytes` integer,
  `uploaded_by` text REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS `idx_rides_status` ON `rides`(`status`);
CREATE INDEX IF NOT EXISTS `idx_rides_driver` ON `rides`(`driver_id`);
CREATE INDEX IF NOT EXISTS `idx_rides_client` ON `rides`(`client_id`);
CREATE INDEX IF NOT EXISTS `idx_rides_date` ON `rides`(`scheduled_date`);
CREATE INDEX IF NOT EXISTS `idx_drivers_user` ON `drivers`(`user_id`);
CREATE INDEX IF NOT EXISTS `idx_vehicles_driver` ON `vehicles`(`driver_id`);
CREATE INDEX IF NOT EXISTS `idx_ride_events_ride` ON `ride_events`(`ride_id`);
CREATE INDEX IF NOT EXISTS `idx_uploads_entity` ON `uploads`(`entity_type`, `entity_id`);

-- Seed: Admin padrão (senha: 123456, hash bcrypt-like simulado — vai ser substituído pelo real)
-- IMPORTANTE: Troque o password_hash pelo hash real após implementar bcrypt no Worker
INSERT OR IGNORE INTO `users` (`id`, `email`, `password_hash`, `name`, `role`, `company`)
VALUES (
  'admin-default-1',
  'admin@transferneves.com',
  'HASH_PLACEHOLDER_123456',
  'José das Neves',
  'admin',
  'Transfer Neves - VIFTEC'
);
