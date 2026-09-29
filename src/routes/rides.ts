import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getDb } from '../db'
import { rides, rideEvents, clients, drivers, vehicles, users } from '../db/schema'
import { eq, desc, asc, and, like, isNull, or, sql } from 'drizzle-orm'
import { authMiddleware, adminOnly, type Env } from '../middleware/auth'

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
          // Show rides assigned to driver OR rides in cities driver serves
          // TODO: Implement multi-city filtering - temporarily using only assigned rides
          // due to TypeScript issues with Drizzle ORM's OR operator
          filters.push(eq(rides.driverId, driver.id))
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
      return { ...ride, client, driver }
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

    return c.json({ ride }, 201)
  } catch (err: any) {
    console.error('[rides] Erro ao criar corrida:', err)
    return c.json({ error: err.message || 'Erro interno do servidor' }, 500)
  }
})

// PATCH /api/rides/:id/status — atualiza status
ridesRoutes.patch('/:id/status', adminOnly, zValidator('json', z.object({
  status: z.enum(['disponivel', 'aceita', 'andamento', 'concluida', 'cancelada', 'editando']),
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

  return c.json({ success: true, status })
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
