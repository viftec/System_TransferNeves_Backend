/** Comprovante disponível por 30 dias após conclusão; removido do R2 no 31º dia. */
export const PROOF_RETENTION_DAYS = 30
export const PROOF_DELETE_GRACE_DAYS = 1

export function proofExpiresAtFromCompletion(completedAt: Date): string {
  const d = new Date(completedAt.getTime())
  d.setUTCDate(d.getUTCDate() + PROOF_RETENTION_DAYS)
  return d.toISOString()
}

export function proofHardDeleteAfter(completedAt: Date): Date {
  const d = new Date(completedAt.getTime())
  d.setUTCDate(d.getUTCDate() + PROOF_RETENTION_DAYS + PROOF_DELETE_GRACE_DAYS)
  return d
}

export function isProofDownloadAllowed(proofKey: string | null | undefined, proofExpired: boolean, proofExpiresAt: string | null | undefined): boolean {
  if (!proofKey || proofExpired) return false
  if (!proofExpiresAt) return true
  return new Date(proofExpiresAt).getTime() > Date.now()
}

export function sanitizeFilenamePart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'motorista'
}

export function buildProofDownloadFilename(rideCode: string, driverName: string, proofKey: string): string {
  const ext = proofKey.split('.').pop()?.toLowerCase() || 'jpg'
  const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(ext) ? ext : 'jpg'
  return `${sanitizeFilenamePart(rideCode)}-${sanitizeFilenamePart(driverName)}.${safeExt}`
}
