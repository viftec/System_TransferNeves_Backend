import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { ridesRoutes } from './routes/rides'
import { driversRoutes } from './routes/drivers'
import { clientsRoutes } from './routes/clients'
import { uploadsRoutes } from './routes/uploads'
import { getDb } from './db'
import { rides, rideEvents, clients, drivers, users } from './db/schema'
import { eq, and, sql, isNull } from 'drizzle-orm'
import { notifyAdmins, notifyDriver } from './lib/push'

const app = new Hono<{ Bindings: Env }>()

// CORS — permite frontend local e Cloudflare Pages
app.use('/*', cors({
  origin: [
    'http://localhost:3000',
    'http://10.0.70.125:3000',
    'https://transferneves.pages.dev',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Health check
app.get('/health', (c) => c.json({
  ok: true,
  env: c.env.ENVIRONMENT ?? 'production',
  timestamp: new Date().toISOString(),
}))

// Endpoint HTTP para disparo manual do cron (teste/debug)
app.get('/scheduled', async (c) => {
  const result = await runScheduled(c.env)
  return c.json(result)
})

// Rotas
app.route('/api/auth', authRoutes)
app.route('/api/rides', ridesRoutes)
app.route('/api/drivers', driversRoutes)
app.route('/api/clients', clientsRoutes)
app.route('/api/uploads', uploadsRoutes)

// 404 padrão
app.notFound((c) => c.json({ error: 'Rota não encontrada' }, 404))

// Erro global
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'Erro interno do servidor', details: err.message }, 500)
})

// ─────────────────────────────────────────────────────────────
// LÓGICA DO CRON (executada a cada 1 min pelo trigger Cloudflare)
// ─────────────────────────────────────────────────────────────
async function runScheduled(env: Env) {
  const db = getDb(env.DB)
  const now = new Date()
  const nowIso = now.toISOString()
  const stats = { expired: 0, cancelled: 0, deleted: 0, alarm5min: 0, lateAlerts: 0, autoCancel1h: 0 }

  try {
    // ── 1. Expirar corridas disponíveis sem motorista (além de 5 min do horário) ──
    const expiredRides = await db.select().from(rides)
      .where(and(eq(rides.status, 'disponivel'), sql`${rides.expiresAt} < ${nowIso}`))
      .all()

    for (const ride of expiredRides) {
      await db.update(rides).set({ status: 'sem_motoristas', updatedAt: nowIso }).where(eq(rides.id, ride.id))
      try {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(), rideId: ride.id, event: 'sem_motoristas',
          description: 'Corrida expirou sem motoristas disponíveis', userId: null,
        })
      } catch { /* non-critical */ }
      stats.expired++
    }

    // ── 2. Alarme de 5 minutos antes para o motorista que aceitou ────────────────
    // Corridas 'aceita' cujo horário está entre agora e agora+5min (janela de 1 min para não duplicar)
    const fiveMin = new Date(now.getTime() + 5 * 60000).toISOString()
    const sixMin = new Date(now.getTime() + 6 * 60000).toISOString()

    const soonRides = await db.select().from(rides)
      .where(and(
        eq(rides.status, 'aceita'),
        sql`${rides.scheduledAt} >= ${fiveMin}`,
        sql`${rides.scheduledAt} < ${sixMin}`
      ))
      .all()

    for (const ride of soonRides) {
      if (!ride.driverId) continue
      const driver = await db.select().from(drivers).where(eq(drivers.id, ride.driverId)).get()
      if (!driver) continue
      const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
      if (!driverUser) continue

      await notifyDriver(db, driverUser.id, {
        title: '⏰ Atenção! Corrida em 5 minutos',
        body: `${ride.originCity} → ${ride.destCity} · Inicie em até 5 minutos.`,
        icon: '/apple-icon.png',
        tag: `alarm-5min-${ride.id}`,
        sound: true,
        requireInteraction: true,
        data: { rideId: ride.id, action: 'start_ride' },
        actions: [{ action: 'view', title: 'Ir para corrida' }],
      }, env)
      stats.alarm5min++
    }

    // ── 3. Alertas de atraso a cada 5 minutos (corrida 'aceita' após o horário) ─
    const acceptedLate = await db.select().from(rides)
      .where(and(eq(rides.status, 'aceita'), sql`${rides.scheduledAt} < ${nowIso}`))
      .all()

    for (const ride of acceptedLate) {
      if (!ride.driverId || !ride.scheduledAt) continue
      const driver = await db.select().from(drivers).where(eq(drivers.id, ride.driverId)).get()
      if (!driver) continue
      const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
      if (!driverUser) continue

      const scheduledMs = new Date(ride.scheduledAt).getTime()
      const lateMs = now.getTime() - scheduledMs
      const lateMin = Math.floor(lateMs / 60000)

      // Notificar a cada 5 minutos de atraso (até 55 min — 1h cancela)
      if (lateMin > 0 && lateMin < 60 && lateMin % 5 === 0) {
        const remainingMin = 60 - lateMin
        await notifyDriver(db, driverUser.id, {
          title: `⚠️ Você está ${lateMin} min atrasado`,
          body: `Corrida ${ride.code}: ${ride.originCity} → ${ride.destCity}. Inicie em até ${remainingMin} min ou será cancelada.`,
          icon: '/apple-icon.png',
          tag: `late-${ride.id}-${lateMin}`,
          sound: true,
          requireInteraction: true,
          data: { rideId: ride.id, action: 'start_ride' },
        }, env)
        stats.lateAlerts++
      }
    }

    // ── 4. Auto-cancelar corridas aceitas há mais de 1h sem iniciar ──────────────
    const oneHourAgo = new Date(now.getTime() - 60 * 60000).toISOString()
    const abandonedRides = await db.select().from(rides)
      .where(and(
        eq(rides.status, 'aceita'),
        sql`${rides.scheduledAt} < ${oneHourAgo}`
      ))
      .all()

    for (const ride of abandonedRides) {
      // Cancelar a corrida (status nao_iniciada)
      await db.update(rides).set({ status: 'nao_iniciada', updatedAt: nowIso }).where(eq(rides.id, ride.id))
      try {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(), rideId: ride.id, event: 'nao_iniciada',
          description: 'Corrida não iniciada automaticamente: aceita mas não iniciada em 1 hora', userId: null,
        })
      } catch { /* non-critical */ }

      // Notificar motorista
      if (ride.driverId) {
        const driver = await db.select().from(drivers).where(eq(drivers.id, ride.driverId)).get()
        if (driver) {
          const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
          if (driverUser) {
            await notifyDriver(db, driverUser.id, {
              title: '❌ Corrida cancelada automaticamente',
              body: `A corrida ${ride.code} (${ride.originCity} → ${ride.destCity}) foi cancelada pois não foi iniciada em 1 hora. Entre em contato com o suporte.`,
              icon: '/apple-icon.png',
              tag: `cancelled-${ride.id}`,
              requireInteraction: true,
              data: { rideId: ride.id, action: 'cancelled' },
            }, env)

            // Notificar admins
            await notifyAdmins(db, {
              title: '🚨 Motorista não iniciou corrida',
              body: `${driverUser.name} aceitou a corrida ${ride.code} mas não iniciou em 1 hora. Entre em contato.`,
              icon: '/apple-icon.png',
              tag: `admin-cancelled-${ride.id}`,
              requireInteraction: true,
              data: { rideId: ride.id, driverName: driverUser.name, action: 'admin_alert' },
            }, env)
          }
        }
      }
      stats.autoCancel1h++
    }

    // ── 5. Cancelar corridas disponíveis antigas (mais de 1 dia) ─────────────────
    const oneDayAgo = new Date(now.getTime() - 24 * 3600000).toISOString()
    const oldAvailable = await db.select().from(rides)
      .where(and(eq(rides.status, 'disponivel'), sql`${rides.scheduledAt} < ${oneDayAgo}`))
      .all()

    for (const ride of oldAvailable) {
      await db.update(rides).set({ status: 'cancelada', updatedAt: nowIso }).where(eq(rides.id, ride.id))
      try {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(), rideId: ride.id, event: 'cancelada',
          description: 'Corrida cancelada automaticamente (antiga)', userId: null,
        })
      } catch { /* non-critical */ }
      stats.cancelled++
    }

    // ── 6. Soft delete corridas com mais de 7 dias ────────────────────────────────
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600000).toISOString()
    const veryOld = await db.select().from(rides)
      .where(and(sql`${rides.scheduledAt} < ${sevenDaysAgo}`, isNull(rides.deletedAt)))
      .all()

    for (const ride of veryOld) {
      await db.update(rides).set({ deletedAt: nowIso, updatedAt: nowIso }).where(eq(rides.id, ride.id))
      stats.deleted++
    }

    console.log(`[cron] expired=${stats.expired} cancelled=${stats.cancelled} deleted=${stats.deleted} alarm5=${stats.alarm5min} late=${stats.lateAlerts} autoCancel1h=${stats.autoCancel1h}`)
    return { success: true, ...stats }
  } catch (error: any) {
    console.error('[cron] Erro:', error)
    return { success: false, error: error?.message }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env))
  },
}

