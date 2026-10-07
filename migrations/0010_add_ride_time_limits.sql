-- Adicionar campos de tempo para corridas
-- scheduled_at: datetime combinado para facilitar comparações
-- expires_at: datetime limite para aceitação (scheduledAt + 5 min)
-- Adicionar status 'sem_motoristas' ao enum

-- Adicionar campos novos
ALTER TABLE rides ADD COLUMN scheduled_at TEXT;
ALTER TABLE rides ADD COLUMN expires_at TEXT;

-- Atualizar corridas existentes para calcular scheduled_at e expires_at
UPDATE rides
SET scheduled_at = scheduled_date || ' ' || scheduled_time
WHERE scheduled_at IS NULL;

-- Calcular expires_at como scheduled_at + 5 minutos
UPDATE rides
SET expires_at = datetime(scheduled_at, '+5 minutes')
WHERE scheduled_at IS NOT NULL AND expires_at IS NULL;
