import { getDb } from '../db'
import { rateLimits } from '../db/schema'
import { eq, and, gt, sql } from 'drizzle-orm'
import type { D1Database } from '@cloudflare/workers-types'

interface RateLimitConfig {
  maxAttempts: number
  windowMinutes: number
  blockMinutes: number
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxAttempts: 5,
  windowMinutes: 15,
  blockMinutes: 30,
}

export async function checkRateLimit(
  dbInstance: D1Database,
  identifier: string,
  endpoint: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): Promise<{ allowed: boolean; remaining: number; blockedUntil?: string }> {
  const db = getDb(dbInstance)
  const now = new Date()
  const windowStart = new Date(now.getTime() - config.windowMinutes * 60 * 1000).toISOString()
  const blockEnd = new Date(now.getTime() + config.blockMinutes * 60 * 1000).toISOString()

  // Check if currently blocked
  const existing = await db
    .select()
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.identifier, identifier),
        eq(rateLimits.endpoint, endpoint)
      )
    )
    .get()

  if (existing && existing.blockedUntil) {
    const blockedUntil = new Date(existing.blockedUntil)
    if (blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        blockedUntil: existing.blockedUntil,
      }
    }
  }

  // Count attempts within window
  const attempts = await db
    .select({ count: sql<number>`count(*)` })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.identifier, identifier),
        eq(rateLimits.endpoint, endpoint),
        sql`${rateLimits.lastAttempt} >= ${windowStart}`
      )
    )
    .get()

  const currentAttempts = attempts?.count ?? 0

  if (currentAttempts >= config.maxAttempts) {
    // Block the identifier
    if (existing) {
      await db
        .update(rateLimits)
        .set({
          blockedUntil: blockEnd,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(rateLimits.id, existing.id))
    } else {
      await db.insert(rateLimits).values({
        identifier,
        endpoint,
        attempts: currentAttempts + 1,
        blockedUntil: blockEnd,
      })
    }

    return {
      allowed: false,
      remaining: 0,
      blockedUntil: blockEnd,
    }
  }

  // Update or create record
  if (existing) {
    await db
      .update(rateLimits)
      .set({
        attempts: currentAttempts + 1,
        lastAttempt: sql`(datetime('now'))`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(rateLimits.id, existing.id))
  } else {
    await db.insert(rateLimits).values({
      identifier,
      endpoint,
      attempts: 1,
    })
  }

  return {
    allowed: true,
    remaining: config.maxAttempts - currentAttempts - 1,
  }
}

export async function resetRateLimit(dbInstance: D1Database, identifier: string, endpoint: string): Promise<void> {
  const db = getDb(dbInstance)
  await db
    .delete(rateLimits)
    .where(
      and(
        eq(rateLimits.identifier, identifier),
        eq(rateLimits.endpoint, endpoint)
      )
    )
}
