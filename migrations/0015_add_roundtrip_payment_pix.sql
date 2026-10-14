-- Adiciona corrida ida e volta, data de pagamento e chave pix do motorista
ALTER TABLE `rides` ADD COLUMN `is_round_trip` integer NOT NULL DEFAULT 0;
ALTER TABLE `rides` ADD COLUMN `payment_date` text;
ALTER TABLE `drivers` ADD COLUMN `pix_key` text;
