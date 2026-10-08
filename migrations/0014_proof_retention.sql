-- Retenção de comprovantes: 30 dias para download, exclusão definitiva após +1 dia
ALTER TABLE `rides` ADD COLUMN `completed_at` text;
ALTER TABLE `rides` ADD COLUMN `proof_expires_at` text;
ALTER TABLE `rides` ADD COLUMN `proof_expired` integer NOT NULL DEFAULT 0;

-- Corridas já concluídas com comprovante: expira 30 dias após updated_at
UPDATE `rides`
SET
  `completed_at` = COALESCE(`completed_at`, `updated_at`),
  `proof_expires_at` = datetime(COALESCE(`completed_at`, `updated_at`), '+30 days')
WHERE `status` = 'concluida'
  AND `proof_key` IS NOT NULL
  AND `proof_expires_at` IS NULL;
