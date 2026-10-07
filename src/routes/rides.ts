import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getDb } from '../db'
import { rides, rideEvents, clients, drivers, vehicles, users } from '../db/schema'
import { eq, desc, asc, and, like, isNull, or, sql } from 'drizzle-orm'
import { authMiddleware, adminOnly, type Env } from '../middleware/auth'
import { notifyEligibleDrivers, notifyAdmins } from '../lib/push'

export const ridesRoutes = new Hono<{ Bindings: Env }>()

// Todas as rotas de corridas exigem auth
ridesRoutes.use('/*', authMiddleware)

// GET /api/rides — lista corridas (admin vê todas, driver vê as suas)
ridesRoutes.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const user = c.get('jwtPayload')
  const status = c.req.query('status')
  const page = Number(c.req.query('page') ?? '1')
  const limit = Number(c.req.query('limit') ?? '50')

  let filters = [isNull(rides.deletedAt)]
  
  if (user.role === 'driver') {
    const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
    if (!driver) return c.json({ rides: [] })

    // Filter by driver's cities if cities field exists
    if (driver.cities) {
      try {
        const driverCities = JSON.parse(driver.cities) as string[]
        if (driverCities.length > 0) {
          // Get rides assigned to driver
          const assignedRides = await db.select().from(rides)
            .where(and(isNull(rides.deletedAt), eq(rides.driverId, driver.id)))
            .orderBy(desc(rides.createdAt))
            .all()

          // Get available rides in driver's cities
          const availableRides = await db.select().from(rides)
            .where(and(
              isNull(rides.deletedAt),
              eq(rides.status, 'disponivel'),
              sql`${rides.originCity} IN ${sql.raw(`(${driverCities.map(c => `'${c}'`).join(',')})`)}`
            ))
            .orderBy(desc(rides.createdAt))
            .all()

          // Buscar todos os veículos do motorista para filtro de tipo
          const driverVehicles = await db.select({ type: vehicles.type }).from(vehicles).where(eq(vehicles.driverId, driver.id)).all()
          const driverVehicleTypes = driverVehicles.map(v => v.type).filter(Boolean) as string[]

          // Filtrar corridas disponíveis: se a corrida tem tipos permitidos, o motorista precisa ter ao menos 1 veículo compatível
          const filteredAvailableRides = availableRides.filter(ride => {
            if (!ride.allowedVehicleTypes) return true
            try {
              const allowed = JSON.parse(ride.allowedVehicleTypes) as string[]
              if (!allowed || allowed.length === 0) return true
              return driverVehicleTypes.some(t => allowed.includes(t))
            } catch {
              return true
            }
          })

          // Buscar corridas aceitas/em andamento para verificar as datas ocupadas
          const activeDriverRides = assignedRides.filter(r => ['aceita', 'andamento'].includes(r.status))
          const occupiedDates = new Set(activeDriverRides.map(r => r.scheduledDate))

          // Combine and deduplicate (assigned rides always show, available filtered by vehicle AND not on an occupied date)
          const allRides = [...assignedRides, ...filteredAvailableRides.filter(r => !occupiedDates.has(r.scheduledDate))]
            .filter((ride, index, self) => index === self.findIndex(r => r.id === ride.id))
            .slice((page - 1) * limit, page * limit)

          const ridesWithDetails = await Promise.all(
            allRides.map(async (ride) => {
              let client = null;
              let driverInfo = null;
              if (ride.clientId) {
                client = await db.select().from(clients).where(eq(clients.id, ride.clientId)).get()
              }
              if (ride.driverId) {
                const d = await db.select().from(drivers).where(eq(drivers.id, ride.driverId)).get()
                if (d) {
                  const userObj = await db.select().from(users).where(eq(users.id, d.userId)).get()
                  driverInfo = { ...d, user: userObj }
                }
              }
              // Transform address fields to nested objects for frontend
              return {
                ...ride,
                origin: {
                  street: ride.originStreet,
                  number: ride.originNumber,
                  complement: ride.originComplement,
                  neighborhood: ride.originNeighborhood,
                  city: ride.originCity,
                  state: ride.originState,
                  cep: ride.originCep,
                },
                destination: {
                  street: ride.destStreet,
                  number: ride.destNumber,
                  complement: ride.destComplement,
                  neighborhood: ride.destNeighborhood,
                  city: ride.destCity,
                  state: ride.destState,
                  cep: ride.destCep,
                },
                client,
                driver: driverInfo
              }
            })
          )

          return c.json({ rides: ridesWithDetails, page, limit })
        } else {
          // No cities selected, only show assigned rides
          filters.push(eq(rides.driverId, driver.id))
        }
      } catch (e) {
        console.error('Error parsing driver cities:', e)
        filters.push(eq(rides.driverId, driver.id))
      }
    } else {
      // No cities field, only show assigned rides
      filters.push(eq(rides.driverId, driver.id))
    }
  }

  const result = await db.select().from(rides)
    .where(and(...filters))
    .orderBy(desc(rides.createdAt))
    .limit(limit)
    .offset((page - 1) * limit)
    .all()

  const ridesWithDetails = await Promise.all(
    result.map(async (ride) => {
      let client = null;
      let driver = null;
      if (ride.clientId) {
        client = await db.select().from(clients).where(eq(clients.id, ride.clientId)).get()
      }
      if (ride.driverId) {
        const d = await db.select().from(drivers).where(eq(drivers.id, ride.driverId)).get()
        if (d) {
          const userObj = await db.select().from(users).where(eq(users.id, d.userId)).get()
          driver = { ...d, user: userObj }
        }
      }
      // Transform address fields to nested objects for frontend
      return {
        ...ride,
        origin: {
          street: ride.originStreet,
          number: ride.originNumber,
          complement: ride.originComplement,
          neighborhood: ride.originNeighborhood,
          city: ride.originCity,
          state: ride.originState,
          cep: ride.originCep,
        },
        destination: {
          street: ride.destStreet,
          number: ride.destNumber,
          complement: ride.destComplement,
          neighborhood: ride.destNeighborhood,
          city: ride.destCity,
          state: ride.destState,
          cep: ride.destCep,
        },
        client,
        driver
      }
    })
  )

  return c.json({ rides: ridesWithDetails, page, limit })
})

// GET /api/rides/:id
ridesRoutes.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  
  const ride = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!ride) return c.json({ error: 'Corrida não encontrada' }, 404)

  const events = await db.select().from(rideEvents).where(eq(rideEvents.rideId, id)).orderBy(asc(rideEvents.createdAt)).all()

  return c.json({ ride, events })
})

// POST /api/rides/:id/cancel-driver
ridesRoutes.post('/:id/cancel-driver', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const user = c.get('jwtPayload')

  if (user.role !== 'driver') {
    return c.json({ error: 'Apenas motoristas podem usar esta rota' }, 403)
  }

  const ride = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!ride) return c.json({ error: 'Corrida não encontrada' }, 404)

  const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
  if (!driver || ride.driverId !== driver.id) {
    return c.json({ error: 'Operação não permitida' }, 403)
  }

  if (ride.status !== 'aceita') {
    return c.json({ error: 'Apenas corridas aceitas podem ser canceladas pelo motorista' }, 400)
  }

  // Verifica se faltam pelo menos 60 minutos
  const now = new Date()
  const scheduledStr = ride.scheduledAt || `${ride.scheduledDate}T${ride.scheduledTime}:00-03:00`
  const scheduledTime = new Date(scheduledStr).getTime()
  const diffMs = scheduledTime - now.getTime()
  
  if (diffMs < 60 * 60 * 1000) {
    return c.json({ error: 'O cancelamento só é permitido até 60 minutos antes do horário agendado' }, 400)
  }

  // Volta para disponível
  await db.update(rides)
    .set({
      status: 'disponivel',
      driverId: null,
      vehicleId: null,
      updatedAt: sql`(datetime('now'))`
    })
    .where(eq(rides.id, id))

  // Registra o evento
  await db.insert(rideEvents).values({
    rideId: id,
    event: 'cancelada_motorista',
    description: `Corrida cancelada pelo motorista ${driver.cpf} faltando mais de 60 minutos`,
    userId: user.sub,
  })

  // Notificar admins e motoristas elegíveis
  c.executionCtx.waitUntil(
    (async () => {
      await notifyAdmins(
        db,
        {
          title: 'Atenção: Corrida Cancelada pelo Motorista!',
          body: `O motorista cancelou a corrida ${ride.code}. A corrida voltou a ficar disponível.`,
          icon: '/apple-icon.png',
          tag: `driver-cancel-${id}`,
          requireInteraction: true,
          data: { rideId: id, action: 'driver_cancelled' },
        },
        c.env
      )

      // Re-notificar motoristas elegíveis sobre a corrida disponível novamente
      await notifyEligibleDrivers(
        db,
        {
          rideId: id,
          code: ride.code || '',
          originCity: ride.originCity,
          destCity: ride.destCity,
          scheduledAt: ride.scheduledAt || `${ride.scheduledDate}T${ride.scheduledTime}:00`,
          value: ride.value,
          type: ride.type,
        },
        null, // sem filtro de veículo
        c.env
      )
    })().catch(e => console.error('Error notifying cancellation:', e))
  )

  return c.json({ message: 'Corrida cancelada e retornada para disponível' })
})

const addressSchema = z.object({
  state: z.string().min(2).max(2),
  city: z.string().min(1).max(100),
  neighborhood: z.string().min(1).max(100),
  street: z.string().min(1).max(255),
  number: z.string().min(1).max(20),
  complement: z.string().max(100).optional()
})

const createRideSchema = z.object({
  clientId: z.string().nullable().optional(),
  clientName: z.string().max(150, 'Nome muito longo').nullable().optional(),
  origin: addressSchema,
  destination: addressSchema,
  date: z.string().min(1, 'Data é obrigatória').max(20),
  time: z.string().min(1, 'Horário é obrigatório').max(20),
  payment: z.string().min(1, 'Pagamento é obrigatório'),
  value: z.number().min(0, 'Valor inválido'),
  notes: z.string().max(1000, 'Observação muito longa').optional(),
  type: z.enum(['passageiro', 'carga']),
  
  passengerCount: z.number().optional(),
  hasLuggage: z.boolean().optional(),
  luggageDescription: z.string().max(500, 'Descrição muito longa').nullable().optional(),
  
  cargoWeight: z.number().optional(),
  cargoWidth: z.number().nullable().optional(),
  cargoLength: z.number().nullable().optional(),
  cargoHeight: z.number().nullable().optional(),
  cargoType: z.string().max(50, 'Tipo muito longo').nullable().optional(),
  cargoFragile: z.boolean().optional(),
  
  allowedVehicleTypes: z.array(z.enum(['sedan', 'suv', 'hatch', 'van', 'caminhonete', 'caminhao'])).min(1, 'Selecione pelo menos um tipo de veículo').optional(),
  
  requiresPhoto: z.boolean().optional(),
})

// POST /api/rides — cria corrida (admin only)
ridesRoutes.post('/', adminOnly, zValidator('json', createRideSchema), async (c) => {
  const db = getDb(c.env.DB)
  const body = c.req.valid('json')
  const user = c.get('jwtPayload')

  try {
    const code = `TN-${Date.now().toString().slice(-6)}`

    // Mapeamento de tipo
    const dbType = body.type === 'passageiro' ? 'passageiros' : 'carga';
    
    // Mapeamento de pagamento
    let dbPayment: 'card' | 'transfer' | 'cash' | 'billed' = 'billed';
    if (body.payment === 'cartao') dbPayment = 'card';
    if (body.payment === 'dinheiro') dbPayment = 'cash';
    if (body.payment === 'pix') dbPayment = 'transfer';
    if (body.payment === 'faturado') dbPayment = 'billed';

    // Se um cliente cadastrado foi selecionado, ele é automaticamente recorrente
    let isRecurring = !!body.clientId;

    // Validar que a corrida não está no passado
    // Converter formato brasileiro "YYYY-MM-DD HH:mm" para ISO
    const scheduledAt = new Date(`${body.date}T${body.time}`)
    const now = new Date()

    if (scheduledAt < now) {
      return c.json({ error: 'Não é possível criar corridas para o passado' }, 400)
    }

    // Calcular expires_at (5 minutos após o horário agendado)
    const expiresAt = new Date(scheduledAt)
    expiresAt.setMinutes(expiresAt.getMinutes() + 5)

    const ride = await db.insert(rides).values({
      id: crypto.randomUUID(),
      code,
      clientId: body.clientId,
      clientName: body.clientName,
      originStreet: body.origin.street,
      originNumber: body.origin.number,
      originComplement: body.origin.complement,
      originNeighborhood: body.origin.neighborhood,
      originCity: body.origin.city,
      originState: body.origin.state,
      destStreet: body.destination.street,
      destNumber: body.destination.number,
      destComplement: body.destination.complement,
      destNeighborhood: body.destination.neighborhood,
      destCity: body.destination.city,
      destState: body.destination.state,
      scheduledDate: body.date,
      scheduledTime: body.time,
      scheduledAt: scheduledAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      paymentMethod: dbPayment,
      value: body.value,
      notes: body.notes,
      type: dbType,
      isRecurring,
      
      // Passageiros
      passengerCount: body.passengerCount,
      hasLuggage: body.hasLuggage ?? false,
      luggageDescription: body.luggageDescription,
      
      // Carga - only for carga type
      ...(dbType === 'carga' && {
        cargoWeightKg: body.cargoWeight,
        cargoWidth: body.cargoWidth,
        cargoLength: body.cargoLength,
        cargoHeight: body.cargoHeight,
        cargoType: body.cargoType,
        cargoFragile: body.cargoFragile ?? false,
      }),
      
      // Tipos de veículo permitidos
      allowedVehicleTypes: body.allowedVehicleTypes ? JSON.stringify(body.allowedVehicleTypes) : null,
      
      // Configurações da corrida
      requiresPhoto: body.requiresPhoto ?? false,
    }).returning().get()

    // Registra evento de criação — não-crítico
    try {
      const actorExists = await db.select({ id: users.id }).from(users).where(eq(users.id, user.sub)).get()
      if (actorExists) {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(),
          rideId: ride.id,
          event: 'created',
          description: 'Corrida criada pelo administrador',
          userId: user.sub,
        })
      } else {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(),
          rideId: ride.id,
          event: 'created',
          description: 'Corrida criada pelo administrador',
          userId: null,
        })
      }
    } catch (eventErr) {
      console.error('[rides] Falha ao registrar evento de criação (não-crítico):', eventErr)
    }

    // Notificar motoristas elegíveis — não-crítico
    try {
      const allowedVehicleTypes = body.allowedVehicleTypes || null
      await notifyEligibleDrivers(db, {
        rideId: ride.id,
        code: ride.code,
        originCity: ride.originCity,
        destCity: ride.destCity,
        scheduledAt: ride.scheduledAt || scheduledAt.toISOString(),
        value: ride.value,
        type: ride.type,
      }, allowedVehicleTypes, c.env)
    } catch (pushErr) {
      console.error('[rides] Falha ao notificar motoristas (não-crítico):', pushErr)
    }

    return c.json({ ride }, 201)
  } catch (err: any) {
    console.error('[rides] Erro ao criar corrida:', err)
    return c.json({ error: err.message || 'Erro interno do servidor' }, 500)
  }
})

// PATCH /api/rides/:id/status — atualiza status (admin only)
ridesRoutes.patch('/:id/status', adminOnly, zValidator('json', z.object({
  status: z.enum(['disponivel', 'aceita', 'andamento', 'concluida', 'cancelada', 'editando', 'sem_motoristas', 'nao_iniciada']),
})), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = c.req.valid('json')
  const user = c.get('jwtPayload')

  const existing = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!existing) return c.json({ error: 'Corrida não encontrada' }, 404)
  if (existing.deletedAt) return c.json({ error: 'Corrida não encontrada' }, 404)

  const eventDescriptions: Record<string, string> = {
    aceita: 'Corrida aceita pelo motorista',
    andamento: 'Corrida iniciada',
    concluida: 'Corrida concluída',
    cancelada: 'Corrida cancelada',
    editando: 'Corrida em edição pelo administrador',
    disponivel: 'Corrida disponível',
    sem_motoristas: 'Corrida expirada sem motoristas',
  }

  await db.update(rides).set({ status, updatedAt: new Date().toISOString() }).where(eq(rides.id, id))

  // Registra evento — não-crítico: FK failure no log não deve bloquear a operação principal
  try {
    // Verifica explicitamente se o usuário existe antes de inserir (evita FK error)
    const actorExists = await db.select({ id: users.id }).from(users).where(eq(users.id, user.sub)).get()
    if (actorExists) {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: id,
        event: status,
        description: eventDescriptions[status] ?? `Status alterado para ${status}`,
        userId: user.sub,
      })
    } else {
      // Se usuário não existe, registra sem userId (só se a coluna permitir null)
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: id,
        event: status,
        description: eventDescriptions[status] ?? `Status alterado para ${status}`,
        userId: null,
      })
    }
  } catch (eventErr) {
    console.error('[rides] Falha ao registrar evento de status (não-crítico):', eventErr)
  }

  // Se iniciou a corrida (andamento), notifica os admins
  if (status === 'andamento') {
    c.executionCtx.waitUntil(
      (async () => {
        await notifyAdmins(
          db,
          {
            title: 'Corrida Iniciada!',
            body: `A corrida ${existing.code || id.slice(0, 8)} foi iniciada pelo motorista.`,
            icon: '/apple-icon.png',
            tag: `ride-started-${id}`,
            requireInteraction: false,
            data: { rideId: id, action: 'ride_started' },
          },
          c.env
        )
      })().catch(e => console.error('Error notifying admins about ride start:', e))
    )
  }

  return c.json({ success: true, status })
})

// POST /api/rides/:id/accept — motorista aceita corrida (operacional atômico)
ridesRoutes.post('/:id/accept', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')

  // Verificar se é motorista
  if (user.role !== 'driver') {
    return c.json({ error: 'Apenas motoristas podem aceitar corridas' }, 403)
  }

  // Buscar perfil do motorista
  const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
  if (!driver) return c.json({ error: 'Perfil de motorista não encontrado' }, 404)

  // Verificar se o motorista está apto (não pending/suspended)
  if (driver.status === 'pending') return c.json({ error: 'Sua conta ainda está em análise' }, 403)
  if (driver.status === 'suspended') return c.json({ error: 'Sua conta está suspensa' }, 403)

  // Buscar a corrida
  const ride = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!ride) return c.json({ error: 'Corrida não encontrada' }, 404)
  if (ride.deletedAt) return c.json({ error: 'Corrida não encontrada' }, 404)

  // Verificar se a corrida ainda está disponível
  if (ride.status !== 'disponivel') {
    return c.json({ error: 'Esta corrida não está mais disponível' }, 400)
  }

  // Verificar se a corrida não expirou
  const now = new Date().toISOString()
  if (ride.expiresAt && ride.expiresAt < now) {
    return c.json({ error: 'Esta corrida expirou' }, 400)
  }

  // Verificar se o motorista tem veículo compatível
  if (ride.allowedVehicleTypes) {
    try {
      const allowedTypes = JSON.parse(ride.allowedVehicleTypes) as string[]

      // Buscar veículos do motorista
      const driverVehicles = await db.select().from(vehicles)
        .where(and(
          eq(vehicles.driverId, driver.id),
          eq(vehicles.active, true)
        ))
        .all()

      // Verificar se algum veículo é compatível
      const hasCompatibleVehicle = driverVehicles.some(v =>
        allowedTypes.includes(v.type)
      )

      if (!hasCompatibleVehicle) {
        return c.json({
          error: 'Você não possui um veículo compatível com esta corrida',
          requiredTypes: allowedTypes,
        }, 400)
      }
    } catch (e) {
      console.error('[rides] Erro ao verificar tipos de veículo:', e)
    }
  }

  // Verificar conflito de horário com outras corridas aceitas
  const conflictingRides = await db.select().from(rides)
    .where(and(
      eq(rides.driverId, driver.id),
      eq(rides.status, 'aceita'),
      isNull(rides.deletedAt)
    ))
    .all()

  for (const conflicting of conflictingRides) {
    if (conflicting.scheduledAt && ride.scheduledAt) {
      // Se houver conflito de horário (considerando margem de 30 minutos)
      const conflictTime = new Date(conflicting.scheduledAt)
      const newRideTime = new Date(ride.scheduledAt)
      const diffMinutes = Math.abs(conflictTime.getTime() - newRideTime.getTime()) / (1000 * 60)

      if (diffMinutes < 30) {
        return c.json({ error: 'Você já tem uma corrida agendada neste horário' }, 400)
      }
    }
  }

  // Atualizar a corrida de forma atômica garantindo que ainda está disponível
  const updatedRide = await db.update(rides)
    .set({
      status: 'aceita',
      driverId: driver.id,
      vehicleId: null, // Será definido quando o motorista iniciar a corrida
      updatedAt: new Date().toISOString()
    })
    .where(and(
      eq(rides.id, id),
      eq(rides.status, 'disponivel')
    ))
    .returning()
    .get()

  if (!updatedRide) {
    return c.json({ error: 'Desculpe, esta corrida acabou de ser aceita por outro motorista ou não está mais disponível.' }, 400)
  }

  // Registrar evento
  try {
    await db.insert(rideEvents).values({
      id: crypto.randomUUID(),
      rideId: id,
      event: 'aceita',
      description: `Corrida aceita pelo motorista ${driver.id}`,
      userId: user.sub,
    })
  } catch (eventErr) {
    console.error('[rides] Falha ao registrar evento de aceitação (não-crítico):', eventErr)
  }

  return c.json({ success: true, message: 'Corrida aceita com sucesso' })
})

// PATCH /api/rides/:id/driver-status — motorista atualiza status da própria corrida (andamento/concluida)
ridesRoutes.patch('/:id/driver-status', zValidator('json', z.object({
  status: z.enum(['andamento', 'concluida']),
})), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = c.req.valid('json')
  const user = c.get('jwtPayload')

  // Verificar se é motorista
  if (user.role !== 'driver') {
    return c.json({ error: 'Apenas motoristas podem atualizar o status de corridas' }, 403)
  }

  // Buscar perfil do motorista
  const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
  if (!driver) return c.json({ error: 'Perfil de motorista não encontrado' }, 404)

  // Buscar a corrida
  const ride = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!ride) return c.json({ error: 'Corrida não encontrada' }, 404)
  if (ride.deletedAt) return c.json({ error: 'Corrida não encontrada' }, 404)

  // Verificar se a corrida pertence a este motorista
  if (ride.driverId !== driver.id) {
    return c.json({ error: 'Esta corrida não pertence a você' }, 403)
  }

  // Validações de transição de status
  if (status === 'andamento' && ride.status !== 'aceita') {
    return c.json({ error: 'Só é possível iniciar corridas que foram aceitas' }, 400)
  }

  if (status === 'concluida' && ride.status !== 'andamento') {
    return c.json({ error: 'Só é possível concluir corridas que estão em andamento' }, 400)
  }

  // Se a corrida exige comprovante, verificar se foi enviado
  if (status === 'concluida' && ride.requiresPhoto && !ride.proofKey) {
    return c.json({ error: 'Esta corrida exige comprovante de entrega. Por favor, envie o comprovante antes de concluir.' }, 400)
  }

  await db.update(rides).set({ status, updatedAt: new Date().toISOString() }).where(eq(rides.id, id))

  // Registrar evento
  try {
    const eventDescriptions: Record<string, string> = {
      andamento: 'Corrida iniciada pelo motorista',
      concluida: 'Corrida concluída pelo motorista',
    }

    await db.insert(rideEvents).values({
      id: crypto.randomUUID(),
      rideId: id,
      event: status,
      description: eventDescriptions[status] || `Status alterado para ${status}`,
      userId: user.sub,
    })
  } catch (eventErr) {
    console.error('[rides] Falha ao registrar evento de status (não-crítico):', eventErr)
  }

  return c.json({ success: true, status })
})

// POST /api/rides/:id/proof — motorista envia comprovante da corrida
ridesRoutes.post('/:id/proof', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')

  // Verificar se é motorista
  if (user.role !== 'driver') {
    return c.json({ error: 'Apenas motoristas podem enviar comprovantes' }, 403)
  }

  // Buscar perfil do motorista
  const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
  if (!driver) return c.json({ error: 'Perfil de motorista não encontrado' }, 404)

  // Buscar a corrida
  const ride = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!ride) return c.json({ error: 'Corrida não encontrada' }, 404)
  if (ride.deletedAt) return c.json({ error: 'Corrida não encontrada' }, 404)

  // Verificar se a corrida pertence a este motorista
  if (ride.driverId !== driver.id) {
    return c.json({ error: 'Esta corrida não pertence a você' }, 403)
  }

  // Receber o arquivo
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return c.json({ error: 'Arquivo não enviado' }, 400)
  }

  // Validar tipo de arquivo (apenas imagens e PDF)
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: 'Tipo de arquivo não permitido. Apenas imagens (JPEG, PNG, WebP) e PDF são aceitos.' }, 400)
  }

  // Validar tamanho (máximo 10MB)
  const maxSize = 10 * 1024 * 1024 // 10MB
  if (file.size > maxSize) {
    return c.json({ error: 'Arquivo muito grande. Máximo permitido: 10MB' }, 400)
  }

  const ext = file.name.split('.').pop() ?? 'bin'
  const r2Key = `ride_proof/${id}/${crypto.randomUUID()}.${ext}`

  // Upload para R2
  await c.env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  })

  // Atualizar a corrida com a chave do comprovante
  await db.update(rides).set({ proofKey: r2Key, updatedAt: new Date().toISOString() }).where(eq(rides.id, id))

  // Registrar evento
  try {
    await db.insert(rideEvents).values({
      id: crypto.randomUUID(),
      rideId: id,
      event: 'proof_sent',
      description: 'Comprovante enviado pelo motorista',
      userId: user.sub,
    })
  } catch (eventErr) {
    console.error('[rides] Falha ao registrar evento de comprovante (não-crítico):', eventErr)
  }

  return c.json({ success: true, r2Key })
})

// POST /api/rides/check-expired — worker para verificar corridas expiradas (admin only ou cron)
ridesRoutes.post('/check-expired', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const now = new Date().toISOString()

  // Buscar corridas disponíveis que expiraram
  const expiredRides = await db.select().from(rides)
    .where(and(
      eq(rides.status, 'disponivel'),
      sql`${rides.expiresAt} < ${sql.placeholder('now')}`
    ))
    .all()

  let updatedCount = 0

  for (const ride of expiredRides) {
    await db.update(rides)
      .set({ status: 'sem_motoristas', updatedAt: now })
      .where(eq(rides.id, ride.id))

    // Registrar evento
    try {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: ride.id,
        event: 'sem_motoristas',
        description: 'Corrida expirou sem motoristas disponíveis',
        userId: null,
      })
    } catch (eventErr) {
      console.error('[rides] Falha ao registrar evento de expiração (não-crítico):', eventErr)
    }

    updatedCount++
  }

  return c.json({ success: true, updatedCount, message: `${updatedCount} corridas marcadas como sem motoristas` })
})

// POST /api/rides/clean-old — limpa corridas antigas (admin only)
ridesRoutes.post('/clean-old', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const { days = 7 } = await c.req.json()

  // Calcular data limite
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffDateStr = cutoffDate.toISOString()

  // Marcar corridas antigas como canceladas
  const oldRides = await db.select().from(rides)
    .where(and(
      sql`${rides.scheduledAt} < ${sql.placeholder('cutoffDate')}`,
      eq(rides.status, 'disponivel')
    ))
    .all()

  let cancelledCount = 0
  for (const ride of oldRides) {
    await db.update(rides)
      .set({ status: 'cancelada', updatedAt: new Date().toISOString() })
      .where(eq(rides.id, ride.id))
    cancelledCount++
  }

  // Soft delete corridas muito antigas
  const veryOldRides = await db.select().from(rides)
    .where(and(
      sql`${rides.scheduledAt} < ${sql.placeholder('cutoffDate')}`,
      isNull(rides.deletedAt)
    ))
    .all()

  let deletedCount = 0
  for (const ride of veryOldRides) {
    await db.update(rides)
      .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(rides.id, ride.id))
    deletedCount++
  }

  return c.json({
    success: true,
    cancelledCount,
    deletedCount,
    message: `${cancelledCount} corridas canceladas, ${deletedCount} corridas deletadas`
  })
})

// DELETE /api/rides/:id — soft delete (admin only)
ridesRoutes.delete('/:id', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')
  
  const existing = await db.select().from(rides).where(eq(rides.id, id)).get()
  if (!existing) return c.json({ error: 'Corrida não encontrada' }, 404)

  // Soft delete: marca como deletada e registra evento
  await db.update(rides).set({
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(rides.id, id))

  // Registra evento de deleção — não-crítico
  try {
    const actorExists = await db.select({ id: users.id }).from(users).where(eq(users.id, user.sub)).get()
    if (actorExists) {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: id,
        event: 'deleted',
        description: 'Corrida removida pelo administrador',
        userId: user.sub,
      })
    } else {
      await db.insert(rideEvents).values({
        id: crypto.randomUUID(),
        rideId: id,
        event: 'deleted',
        description: 'Corrida removida pelo administrador',
        userId: null,
      })
    }
  } catch (eventErr) {
    console.error('[rides] Falha ao registrar evento de deleção (não-crítico):', eventErr)
  }

  
  return c.json({ success: true })
})

// PUT /api/rides/:id — edita corrida (admin only)
ridesRoutes.put('/:id', adminOnly, zValidator('json', createRideSchema), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const body = c.req.valid('json')
  const user = c.get('jwtPayload')

  try {
    const existingRide = await db.select().from(rides).where(eq(rides.id, id)).get()
    if (!existingRide) return c.json({ error: 'Corrida não encontrada' }, 404)

    // Segurança: só pode editar corridas que estão no status 'editando' (bloqueadas para edição)
    if (existingRide.status !== 'editando') {
      return c.json({ error: 'Corrida não está em modo de edição. Acesso bloqueado.' }, 409)
    }

    // Mapeamento de tipo
    const dbType = body.type === 'passageiro' ? 'passageiros' : 'carga';
    
    // Mapeamento de pagamento
    let dbPayment: 'card' | 'transfer' | 'cash' | 'billed' = 'billed';
    if (body.payment === 'cartao') dbPayment = 'card';
    if (body.payment === 'dinheiro') dbPayment = 'cash';
    if (body.payment === 'pix') dbPayment = 'transfer';
    if (body.payment === 'faturado') dbPayment = 'billed';

    // Se um cliente cadastrado foi selecionado, ele é automaticamente recorrente
    let isRecurring = !!body.clientId;

    // Validar que a corrida não está no passado
    // Converter formato brasileiro "YYYY-MM-DD HH:mm" para ISO
    const scheduledAt = new Date(`${body.date}T${body.time}`)
    const now = new Date()

    if (scheduledAt < now) {
      return c.json({ error: 'Não é possível criar corridas para o passado' }, 400)
    }

    // Calcular expires_at (5 minutos após o horário agendado)
    const expiresAt = new Date(scheduledAt)
    expiresAt.setMinutes(expiresAt.getMinutes() + 5)

    const ride = await db.update(rides).set({
      clientId: body.clientId,
      clientName: body.clientName,
      originStreet: body.origin.street,
      originNumber: body.origin.number,
      originComplement: body.origin.complement,
      originNeighborhood: body.origin.neighborhood,
      originCity: body.origin.city,
      originState: body.origin.state,
      destStreet: body.destination.street,
      destNumber: body.destination.number,
      destComplement: body.destination.complement,
      destNeighborhood: body.destination.neighborhood,
      destCity: body.destination.city,
      destState: body.destination.state,
      scheduledDate: body.date,
      scheduledTime: body.time,
      scheduledAt: scheduledAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      paymentMethod: dbPayment,
      value: body.value,
      notes: body.notes,
      type: dbType,
      isRecurring,
      
      // Passageiros
      passengerCount: body.passengerCount,
      hasLuggage: body.hasLuggage ?? false,
      luggageDescription: body.luggageDescription,
      
      // Carga - only for carga type
      ...(dbType === 'carga' && {
        cargoWeightKg: body.cargoWeight,
        cargoWidth: body.cargoWidth,
        cargoLength: body.cargoLength,
        cargoHeight: body.cargoHeight,
        cargoType: body.cargoType,
        cargoFragile: body.cargoFragile ?? false,
      }),
      
      // Tipos de veículo permitidos
      allowedVehicleTypes: body.allowedVehicleTypes ? JSON.stringify(body.allowedVehicleTypes) : null,
      
      // Configurações da corrida
      requiresPhoto: body.requiresPhoto ?? false,
      
      status: existingRide.status === 'editando' ? 'disponivel' : existingRide.status,
      updatedAt: new Date().toISOString()
    }).where(eq(rides.id, id)).returning().get()

    // Registra evento de edição — não-crítico
    try {
      const actorExists = await db.select({ id: users.id }).from(users).where(eq(users.id, user.sub)).get()
      if (actorExists) {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(),
          rideId: ride.id,
          event: 'edited',
          description: 'Corrida editada pelo administrador',
          userId: user.sub,
        })
      } else {
        await db.insert(rideEvents).values({
          id: crypto.randomUUID(),
          rideId: ride.id,
          event: 'edited',
          description: 'Corrida editada pelo administrador',
          userId: null,
        })
      }
    } catch (eventErr) {
      console.error('[rides] Falha ao registrar evento de edição (não-crítico):', eventErr)
    }

    return c.json({ ride })
  } catch (err: any) {
    console.error('[rides] Erro ao editar corrida:', err)
    return c.json({ error: err.message || 'Erro interno do servidor' }, 500)
  }
})
