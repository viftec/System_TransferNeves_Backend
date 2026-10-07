-- Marcar corridas antigas (antes de 25/09/2026) como canceladas
-- Isso vai limpar as corridas do dia 20/09 que estão aparecendo

UPDATE rides
SET status = 'cancelada',
    updated_at = datetime('now')
WHERE scheduled_at < '2026-09-25 00:00:00'
  AND status IN ('disponivel', 'aceita');

-- Soft delete corridas muito antigas (antes de 20/09/2026)
UPDATE rides
SET deleted_at = datetime('now'),
    updated_at = datetime('now')
WHERE scheduled_at < '2026-09-20 00:00:00';
