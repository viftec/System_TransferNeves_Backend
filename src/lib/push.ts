import { pushSubscriptions, drivers, vehicles, users } from '../db/schema'
import { eq, and, or } from 'drizzle-orm'
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

function cleanCity(str: string): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*-\s*[a-z]{2}$/i, '')
    .replace(/\s*\/\s*[a-z]{2}$/i, '')
    .trim()
}

function doesDriverServeCity(
  driverCitiesJson: string | null | undefined,
  driverCity: string | null | undefined,
  originCity: string,
  serviceCities?: string[]
): boolean {
  const normOrigin = cleanCity(originCity)
  const normServiceCities = (serviceCities || []).map(cleanCity).filter(Boolean)

  let driverCities: string[] = []
  if (driverCitiesJson) {
    try {
      const parsed = JSON.parse(driverCitiesJson)
      if (Array.isArray(parsed)) {
        driverCities = parsed.map(c => cleanCity(String(c))).filter(Boolean)
      }
    } catch {}
  }

  // Se não tem cidades cadastradas em driver.cities, usa a cidade do endereço residencial
  if (driverCities.length === 0 && driverCity) {
    driverCities = [cleanCity(driverCity)].filter(Boolean)
  }

  // Se o motorista não tem nenhuma cidade cadastrada, atende todas (não descartar!)
  if (driverCities.length === 0) {
    return true
  }

  // Se a corrida tem cidades de atendimento autorizadas
  if (normServiceCities.length > 0) {
    const matchesService = normServiceCities.some(sc =>
      driverCities.some(dc => dc === sc || dc.includes(sc) || sc.includes(dc))
    )
    if (matchesService) return true
  }

  // Comparar com a cidade de origem
  if (normOrigin) {
    const matchesOrigin = driverCities.some(dc =>
      dc === normOrigin || dc.includes(normOrigin) || normOrigin.includes(dc)
    )
    if (matchesOrigin) return true
  }

  return false
}

// ─── Notificar motoristas elegíveis sobre nova corrida ────────────────────────
export async function notifyEligibleDrivers(
  db: DB,
  rideData: {
    rideId: string; code: string; originCity: string; destCity: string
    scheduledAt: string; value: number; type: string; serviceCities?: string[]
  },
  allowedVehicleTypes: string[] | null,
  env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string },
  excludeDriverId?: string
) {
  const vapid = getVapid(env)
  if (!vapid) { console.warn('[push] VAPID não configurado — pulando envio'); return { notified: 0 } }

  try {
    // 1. Buscar motoristas aptos (status 'online' ou 'approved')
    const allDrivers = await db.select().from(drivers)
      .where(or(eq(drivers.status, 'online'), eq(drivers.status, 'approved')))
      .all()

    console.log(`[push] Total de motoristas cadastrados e aptos (online/approved): ${allDrivers.length}`)

    // 2. Buscar veículos de todos os motoristas
    const allVehicles = await db.select({ driverId: vehicles.driverId, type: vehicles.type }).from(vehicles).all()
    const vehiclesByDriver: Record<string, string[]> = {}
    for (const v of allVehicles) {
      if (!vehiclesByDriver[v.driverId]) vehiclesByDriver[v.driverId] = []
      if (v.type) vehiclesByDriver[v.driverId].push(v.type.toLowerCase().trim())
    }

    // 3. Filtrar motoristas elegíveis por cidade e veículo
    const normAllowedVehicles = allowedVehicleTypes && allowedVehicleTypes.length > 0
      ? allowedVehicleTypes.map(t => t.toLowerCase().trim())
      : null

    const eligibleDrivers = allDrivers.filter((driver) => {
      if (excludeDriverId && driver.id === excludeDriverId) return false

      // Verificar cidade
      const servesCity = doesDriverServeCity(driver.cities, driver.city, rideData.originCity, rideData.serviceCities)
      if (!servesCity) {
        console.log(`[push] Motorista ${driver.id} descartado por cidade (origem: ${rideData.originCity})`)
        return false
      }

      // Verificar veículo (se especificado)
      if (normAllowedVehicles) {
        const driverTypes = vehiclesByDriver[driver.id] ?? []
        if (driver.preferredVehicleType) {
          driverTypes.push(driver.preferredVehicleType.toLowerCase().trim())
        }
        if (driverTypes.length > 0 && !driverTypes.some(t => normAllowedVehicles.includes(t))) {
          console.log(`[push] Motorista ${driver.id} descartado por veículo incompatível`)
          return false
        }
      }

      return true
    })

    console.log(`[push] ${eligibleDrivers.length} motoristas passaram no filtro de elegibilidade`)

    if (eligibleDrivers.length === 0) {
      return { notified: 0 }
    }

    // 4. Buscar todas as push subscriptions ativas
    const activeSubs = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.active, true))
      .all()

    console.log(`[push] Total de subscriptions ativas no banco: ${activeSubs.length}`)

    // 5. Vincular subscriptions aos motoristas elegíveis (por driverId OU userId)
    const seenEndpoints = new Set<string>()
    const targetSubs: Array<{ id: string; endpoint: string; p256dhKey: string; authKey: string }> = []

    for (const driver of eligibleDrivers) {
      const driverSubs = activeSubs.filter(s => s.driverId === driver.id || s.userId === driver.userId)
      for (const sub of driverSubs) {
        if (!seenEndpoints.has(sub.endpoint)) {
          seenEndpoints.add(sub.endpoint)
          targetSubs.push({
            id: sub.id,
            endpoint: sub.endpoint,
            p256dhKey: sub.p256dhKey,
            authKey: sub.authKey,
          })
        }
      }
    }

    console.log(`[push] Disparando push para ${targetSubs.length} subscriptions dos motoristas elegíveis`)

    if (targetSubs.length === 0) {
      console.warn('[push] Nenhum motorista elegível possui assinatura push ativa registrada')
      return { notified: 0 }
    }

    const payload: PushPayload = {
      title: '🚨 Nova Corrida Disponível!',
      body: `${rideData.originCity} → ${rideData.destCity} · ${new Date(rideData.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}\nToque para ver detalhes e aceitar.`,
      icon: '/icon-192x192.png',
      badge: '/icon-32x32.png',
      tag: `new-ride-${rideData.rideId}`,
      sound: true,
      requireInteraction: true,
      data: {
        rideId: rideData.rideId,
        code: rideData.code,
        action: 'new_ride',
        url: '/driver',
        timestamp: Date.now(),
      },
      actions: [
        { action: 'view', title: 'Ver corrida' },
        { action: 'close', title: 'Ignorar' }
      ],
    }

    const notified = await sendToSubscriptions(db, targetSubs, payload, vapid)
    console.log(`[push] ${notified}/${targetSubs.length} notificações de nova corrida enviadas`)
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

// ─── Notificar motorista específico (por userId ou driverId) ───────────────────
export async function notifyDriver(
  db: DB,
  driverIdentifier: string,
  payload: PushPayload,
  env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
) {
  console.log(`[push] notifyDriver chamado para: ${driverIdentifier}`)

  const vapid = getVapid(env)
  if (!vapid) {
    console.log('[push] VAPID não configurado - pulando envio')
    return { notified: 0 }
  }

  try {
    // Buscar perfil do motorista para descobrir userId e driverId
    const driver = await db.select().from(drivers)
      .where(or(eq(drivers.userId, driverIdentifier), eq(drivers.id, driverIdentifier)))
      .get()

    const userId = driver ? driver.userId : driverIdentifier
    const driverId = driver ? driver.id : null

    const allSubs = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.active, true))
      .all()

    const subs = allSubs.filter(s => s.userId === userId || (driverId && s.driverId === driverId))

    console.log(`[push] ${subs.length} subscriptions ativas encontradas para ${driverIdentifier}`)

    if (subs.length === 0) {
      console.log('[push] Nenhuma subscription ativa encontrada')
      return { notified: 0 }
    }

    const notified = await sendToSubscriptions(db, subs, payload, vapid)
    console.log(`[push] notifyDriver concluído: ${notified} notificações enviadas`)
    return { notified }
  } catch (err) {
    console.error('[push] Erro ao notificar motorista:', err)
    return { notified: 0 }
  }
}

