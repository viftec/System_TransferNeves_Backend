import { pushSubscriptions, drivers, vehicles, users } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import type { DB } from '../db'
import { sendWebPush, type VapidConfig, type PushPayload, type PushSendResult } from './vapid'

function getVapid(env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }): VapidConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.warn('[push] VAPID keys não configuradas:', {
      hasPublicKey: !!env.VAPID_PUBLIC_KEY,
      hasPrivateKey: !!env.VAPID_PRIVATE_KEY,
      hasSubject: !!env.VAPID_SUBJECT
    })
    return null
  }
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
}

// ─── Enviar push para uma lista de subscriptions ──────────────────────────────
async function sendToSubscriptions(
  db: DB,
  subscriptions: Array<{ id: string; endpoint: string; p256dhKey: string; authKey: string }>,
  payload: PushPayload,
  vapid: VapidConfig
): Promise<number> {
  console.log(`[push] Enviando para ${subscriptions.length} subscriptions`)
  let sent = 0
  let configError = false

  for (const sub of subscriptions) {
    const result = await sendWebPush({ endpoint: sub.endpoint, p256dhKey: sub.p256dhKey, authKey: sub.authKey }, payload, vapid)

    if (result.success) {
      sent++
      console.log(`[push] ✓ Enviado para ${sub.endpoint.substring(0, 50)}...`)
    } else {
      console.log(`[push] ✗ Falha ao enviar para ${sub.endpoint.substring(0, 50)}... (${result.error})`)

      // Tratar diferentes tipos de erro
      if (result.error === 'config_error') {
        // Erro de configuração global - não desativar assinaturas
        configError = true
        console.error(`[push] Erro de configuração global VAPID - pulando desativação de assinaturas`)
        break // Não continue tentando outras assinaturas se for erro de config
      }
      if (result.error === 'subscription_invalid') {
        // Assinatura específica inválida - desativar esta assinatura
        console.log(`[push] Desativando assinatura inválida: ${sub.id}`)
        await db.update(pushSubscriptions)
          .set({ active: false, updatedAt: new Date().toISOString() })
          .where(eq(pushSubscriptions.id, sub.id))
      }
      if (result.error === 'http_permanent') {
        // Endpoint permanentemente inválido (404, 410) - desativar assinatura
        console.log(`[push] Desativando assinatura com endpoint expirado: ${sub.id}`)
        await db.update(pushSubscriptions)
          .set({ active: false, updatedAt: new Date().toISOString() })
          .where(eq(pushSubscriptions.id, sub.id))
      }
      if (result.error === 'http_temporary' || result.error === 'rate_limited') {
        // Erro temporário - não desativar assinatura
        const statusInfo = result.error === 'http_temporary' ? ` (${result.status})` : ''
        console.log(`[push] Erro temporário${statusInfo} - mantendo assinatura ativa`)
      }
    }
  }

  if (configError) {
    console.error(`[push] Abortando envio devido a erro de configuração global VAPID`)
  }

  console.log(`[push] Total enviado: ${sent}/${subscriptions.length}`)
  return sent
}

// ─── Buscar subscriptions ativas de admins ────────────────────────────────────
async function getAdminSubscriptions(db: DB) {
  const adminUsers = await db.select().from(users).where(eq(users.role, 'admin')).all()
  const adminIds = adminUsers.map(u => u.id)
  if (adminIds.length === 0) return []
  const subs = await db.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.active, true)))
    .all()
  return subs.filter(s => adminIds.includes(s.userId))
}

// ─── Notificar motoristas elegíveis sobre nova corrida ────────────────────────
export async function notifyEligibleDrivers(
  db: DB,
  rideData: {
    rideId: string; code: string; originCity: string; destCity: string
    scheduledAt: string; value: number; type: string; serviceCities?: string[]
  },
  allowedVehicleTypes: string[] | null,
  env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
) {
  const vapid = getVapid(env)
  if (!vapid) { console.warn('[push] VAPID não configurado — pulando envio'); return { notified: 0 } }

  try {
    const eligibleDrivers = await db.select({ driver: drivers, subscription: pushSubscriptions })
      .from(drivers)
      .innerJoin(pushSubscriptions, eq(drivers.id, pushSubscriptions.driverId))
      .where(and(eq(drivers.status, 'online'), eq(pushSubscriptions.active, true)))
      .all()

    const allVehicles = await db.select({ driverId: vehicles.driverId, type: vehicles.type }).from(vehicles).all()
    const vehiclesByDriver: Record<string, string[]> = {}
    for (const v of allVehicles) {
      if (!vehiclesByDriver[v.driverId]) vehiclesByDriver[v.driverId] = []
      if (v.type) vehiclesByDriver[v.driverId].push(v.type)
    }

    const filtered = eligibleDrivers.filter(({ driver }) => {
      if (!driver.cities) return false
      try {
        const cities = JSON.parse(driver.cities) as string[]
        if (rideData.serviceCities && rideData.serviceCities.length > 0) {
          if (!rideData.serviceCities.some(c => cities.includes(c))) return false
        } else {
          if (!cities.includes(rideData.originCity)) return false
        }
      } catch { return false }
      if (allowedVehicleTypes?.length) {
        const driverTypes = vehiclesByDriver[driver.id] ?? []
        if (!driverTypes.some(t => allowedVehicleTypes.includes(t))) return false
      }
      return true
    })

    const payload: PushPayload = {
      title: '🚗 Nova corrida disponível!',
      body: `${rideData.originCity} → ${rideData.destCity} · ${new Date(rideData.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
      icon: '/apple-icon.png',
      tag: `new-ride-${rideData.rideId}`,
      requireInteraction: true,
      data: { rideId: rideData.rideId, code: rideData.code, action: 'new_ride' },
      actions: [{ action: 'view', title: 'Ver corrida' }, { action: 'close', title: 'Ignorar' }],
    }

    const subs = filtered.map(({ subscription: s }) => ({ id: s.id, endpoint: s.endpoint, p256dhKey: s.p256dhKey, authKey: s.authKey }))
    const notified = await sendToSubscriptions(db, subs, payload, vapid)
    console.log(`[push] ${notified}/${filtered.length} motoristas notificados sobre nova corrida`)
    return { notified }
  } catch (err) {
    console.error('[push] Erro ao notificar motoristas:', err)
    return { notified: 0, error: String(err) }
  }
}

// ─── Notificar TODOS os admins ────────────────────────────────────────────────
export async function notifyAdmins(
  db: DB,
  payload: PushPayload,
  env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
) {
  const vapid = getVapid(env)
  if (!vapid) return { notified: 0 }
  try {
    const subs = await getAdminSubscriptions(db)
    const notified = await sendToSubscriptions(db, subs, payload, vapid)
    console.log(`[push] ${notified} admins notificados`)
    return { notified }
  } catch (err) {
    console.error('[push] Erro ao notificar admins:', err)
    return { notified: 0 }
  }
}

// ─── Notificar motorista específico (por userId) ───────────────────────────────
export async function notifyDriver(
  db: DB,
  driverUserId: string,
  payload: PushPayload,
  env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
) {
  console.log(`[push] notifyDriver chamado para userId: ${driverUserId}`)
  console.log(`[push] Payload:`, payload)

  const vapid = getVapid(env)
  if (!vapid) {
    console.log('[push] VAPID não configurado - pulando envio')
    return { notified: 0 }
  }

  try {
    // Primeiro, buscar todas as subscriptions deste usuário (ativo ou não)
    const allSubs = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, driverUserId))
      .all()

    console.log(`[push] Total de subscriptions (ativas + inativas) para userId ${driverUserId}:`, allSubs.length)
    allSubs.forEach(s => {
      console.log(`[push] - Subscription id: ${s.id}, active: ${s.active}, driverId: ${s.driverId}`)
    })

    // Agora buscar apenas as ativas
    const subs = await db.select().from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, driverUserId), eq(pushSubscriptions.active, true)))
      .all()

    console.log(`[push] ${subs.length} subscriptions ativas encontradas para userId: ${driverUserId}`)

    if (subs.length === 0) {
      console.log('[push] Nenhuma subscription ativa encontrada')
    }

    const notified = await sendToSubscriptions(db, subs, payload, vapid)
    console.log(`[push] notifyDriver concluído: ${notified} notificações enviadas`)
    return { notified }
  } catch (err) {
    console.error('[push] Erro ao notificar motorista:', err)
    return { notified: 0 }
  }
}

