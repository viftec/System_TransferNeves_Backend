import type { Env } from '../middleware/auth'
import { getDb } from '../db'
import { rides, rideEvents, uploads } from '../db/schema'
import { eq, and, sql, isNotNull } from 'drizzle-orm'
import { proofHardDeleteAfter } from './proof-retention'

export async function markExpiredProofs(db: ReturnType<typeof getDb>, nowIso: string): Promise<number> {
  const rows = await db
    .select()
    .from(rides)
    .where(
      and(
        isNotNull(rides.proofKey),
        isNotNull(rides.proofExpiresAt),
        eq(rides.proofExpired, false),
        sql`${rides.proofExpiresAt} <= ${nowIso}`,
      ),
    )
    .all()

  for (const ride of rows) {
    await db
      .update(rides)
      .set({ proofExpired: true, updatedAt: nowIso })
      .where(eq(rides.id, ride.id))

    try {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: ride.id,
        event: 'proof_expired',
        description: 'Prazo de download do comprovante encerrado (30 dias após conclusão)',
        userId: null,
      })
    } catch {
      /* non-critical */
    }
  }

  return rows.length
}

export async function hardDeleteExpiredProofs(env: Env, db: ReturnType<typeof getDb>, now: Date): Promise<number> {
  const candidates = await db
    .select()
    .from(rides)
    .where(and(isNotNull(rides.proofKey), isNotNull(rides.completedAt)))
    .all()

  let deleted = 0
  const nowIso = now.toISOString()

  for (const ride of candidates) {
    if (!ride.proofKey || !ride.completedAt) continue
    const deleteAfter = proofHardDeleteAfter(new Date(ride.completedAt))
    if (now.getTime() < deleteAfter.getTime()) continue

    try {
      await env.FILES.delete(ride.proofKey)
    } catch (e) {
      console.error('[proof-purge] Falha ao remover R2:', ride.proofKey, e)
    }

    try {
      await db.delete(uploads).where(eq(uploads.r2Key, ride.proofKey))
    } catch {
      /* non-critical */
    }

    await db
      .update(rides)
      .set({
        proofKey: null,
        proofExpired: true,
        updatedAt: nowIso,
      })
      .where(eq(rides.id, ride.id))

    try {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: ride.id,
        event: 'proof_deleted',
        description: 'Comprovante removido permanentemente do armazenamento (retenção encerrada)',
        userId: null,
      })
    } catch {
      /* non-critical */
    }

    deleted++
  }

  return deleted
}
