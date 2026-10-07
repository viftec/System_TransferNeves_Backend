-- Tabela para armazenar push subscriptions dos motoristas
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

-- Adicionar campo preferred_vehicle_type na tabela drivers
ALTER TABLE drivers ADD COLUMN preferred_vehicle_type TEXT;
