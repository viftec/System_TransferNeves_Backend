import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getDb } from '../db'
import { rides, rideEvents, clients, drivers, vehicles } from '../db/schema'
import { eq, desc, asc, and, like } from 'drizzle-orm'
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

  let query = db.select().from(rides)
  
  if (user.role === 'driver') {
    // Motorista só vê as próprias corridas
    const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
    if (!driver) return c.json({ rides: [] })
    
    query = query.where(eq(rides.driverId, driver.id)) as any
  }

  const result = await query.orderBy(desc(rides.createdAt)).limit(limit).offset((page - 1) * limit).all()

  // Para cada corrida, buscar informações do cliente se tiver clientId
  const ridesWithClients = await Promise.all(
    result.map(async (ride) => {
      if (ride.clientId) {
        const client = await db.select().from(clients).where(eq(clients.id, ride.clientId)).get()
        return { ...ride, client }
      }
      return ride
    })
  )

  return c.json({ rides: ridesWithClients, page, limit })
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

const createRideSchema = z.object({
  clientId: z.string().nullable().optional(),
  clientName: z.string().max(150, 'Nome muito longo').nullable().optional(),
  origin: z.string().min(1, 'Origem é obrigatória').max(255, 'Origem muito longa'),
  destination: z.string().min(1, 'Destino é obrigatório').max(255, 'Destino muito longo'),
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
})

// POST /api/rides — cria corrida (admin only)
ridesRoutes.post('/', adminOnly, zValidator('json', createRideSchema), async (c) => {
  const db = getDb(c.env.DB)
  const body = c.req.valid('json')
  const user = c.get('jwtPayload')

  const code = `TN-${Date.now().toString().slice(-6)}`

  // Mapeamento de tipo
  const dbType = body.type === 'passageiro' ? 'passageiros' : 'carga';
  
  // Mapeamento de pagamento
  let dbPayment: 'card' | 'transfer' | 'cash' | 'billed' = 'billed';
  if (body.payment === 'cartao') dbPayment = 'card';
  if (body.payment === 'dinheiro') dbPayment = 'cash';
  if (body.payment === 'pix') dbPayment = 'transfer';
  
  // Extrair cidade (simplificado: usar a string toda em 'Street' e pegar o último trecho para City)
  const originParts = body.origin.split(',').map(s => s.trim());
  const originCity = originParts.length > 2 ? originParts[2] : originParts[originParts.length - 1] || 'Não informada';
  
  const destParts = body.destination.split(',').map(s => s.trim());
  const destCity = destParts.length > 2 ? destParts[2] : destParts[destParts.length - 1] || 'Não informada';

  // Determinar se é cliente recorrente
  let isRecurring = false;
  if (body.clientId) {
    const client = await db.select().from(clients).where(eq(clients.id, body.clientId)).get();
    if (client && client.isRecurring === true) {
      isRecurring = true;
    }
  }

  const ride = await db.insert(rides).values({
    id: crypto.randomUUID(),
    code,
    clientId: body.clientId,
    clientName: body.clientName,
    originStreet: body.origin,
    originCity: originCity,
    destStreet: body.destination,
    destCity: destCity,
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
    
    // Carga
    cargoWeightKg: body.cargoWeight,
    cargoWidth: body.cargoWidth,
    cargoLength: body.cargoLength,
    cargoHeight: body.cargoHeight,
    cargoType: body.cargoType,
    cargoFragile: body.cargoFragile ?? false,
  }).returning().get()

  // Registra evento de criação
  await db.insert(rideEvents).values({
    id: crypto.randomUUID(),
    rideId: ride.id,
    event: 'created',
    description: 'Corrida criada pelo administrador',
    userId: user.sub,
  })

  return c.json({ ride }, 201)
})

// PATCH /api/rides/:id/status — atualiza status
ridesRoutes.patch('/:id/status', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = await c.req.json()
  const user = c.get('jwtPayload')

  const eventDescriptions: Record<string, string> = {
    aceita: 'Corrida aceita pelo motorista',
    andamento: 'Corrida iniciada',
    concluida: 'Corrida concluída',
    cancelada: 'Corrida cancelada',
  }

  await db.update(rides).set({ status, updatedAt: new Date().toISOString() }).where(eq(rides.id, id))

  await db.insert(rideEvents).values({
    id: crypto.randomUUID(),
    rideId: id,
    event: status,
    description: eventDescriptions[status] ?? `Status alterado para ${status}`,
    userId: user.sub,
  })

  return c.json({ success: true, status })
})

// DELETE /api/rides/:id — admin only
ridesRoutes.delete('/:id', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  await db.delete(rides).where(eq(rides.id, id))
  return c.json({ success: true })
})
