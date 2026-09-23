-- Migration para adicionar campo is_recurring na tabela rides
-- Execute: wrangler d1 migrations apply DB --local  (dev)
--          wrangler d1 migrations apply DB --remote  (produção)

ALTER TABLE `rides` ADD COLUMN `is_recurring` integer NOT NULL DEFAULT 0;