import { Hono } from 'hono'
import { getDb } from '../db'
import { clients, rides } from '../db/schema'
import { eq, desc, like, or, sql, isNull, and } from 'drizzle-orm'
import { authMiddleware, adminOnly, type Env } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const clientSchema = z.object({
  name: z.string().min(1).max(100),
  fantasyName: z.string().max(100).nullable().optional(),
  type: z.enum(['pf', 'pj']),
  cpfCnpj: z.string().min(1).max(20),
  phone: z.string().min(1).max(20),
  whatsapp: z.string().max(20).nullable().optional(),
  email: z.string().email().max(150).nullable().optional().or(z.literal('')),
  secondaryPhone: z.string().max(20).nullable().optional(),
  street: z.string().max(150).nullable().optional(),
  number: z.string().max(20).nullable().optional(),
  complement: z.string().max(100).nullable().optional(),
  neighborhood: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(2).nullable().optional(),
  cep: z.string().max(20).nullable().optional(),
  isRecurring: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: z.string().max(1000).nullable().optional(),
})

export const clientsRoutes = new Hono<{ Bindings: Env }>()

clientsRoutes.use('/*', authMiddleware, adminOnly)

// GET /api/clients?q=&page=1&limit=20
// Supports search (name / fantasy name) + pagination for infinite-scroll widgets.
// Limits are capped at 50 to protect the backend from expensive queries.
clientsRoutes.get('/', async (c) => {
  const db = getDb(c.env.DB)

  const q      = (c.req.query('q') ?? '').trim()
  const page   = Math.max(1, parseInt(c.req.query('page')  ?? '1',  10) || 1)
  const limit  = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20))
  const offset = (page - 1) * limit

  const baseQuery = db.select().from(clients)

  let result: typeof clients.$inferSelect[]
  let total: number

  if (q) {
    const pattern = `%${q}%`
    const filtered = baseQuery.where(
      and(
        isNull(clients.deletedAt),
        or(
          like(clients.name, pattern),
          like(clients.fantasyName, pattern),
          like(clients.cpfCnpj, pattern),
        )
      )
    )
    result = await filtered
      .orderBy(desc(clients.createdAt))
      .limit(limit)
      .offset(offset)
      .all()

    const countRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(clients)
      .where(or(like(clients.name, pattern), like(clients.fantasyName, pattern), like(clients.cpfCnpj, pattern)))
      .get()
    total = countRow?.count ?? 0
  } else {
    result = await baseQuery
      .where(isNull(clients.deletedAt))
      .orderBy(desc(clients.createdAt))
      .limit(limit)
      .offset(offset)
      .all()

    const countRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(clients)
      .where(isNull(clients.deletedAt))
      .get()
    total = countRow?.count ?? 0
  }

  return c.json({
    clients: result,
    pagination: {
      page,
      limit,
      total,
      hasMore: offset + result.length < total,
    },
  })
})

// GET /api/clients/:id
clientsRoutes.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const client = await db.select().from(clients).where(eq(clients.id, id)).get()
  if (!client) return c.json({ error: 'Cliente não encontrado' }, 404)
  return c.json({ client })
})

// POST /api/clients
clientsRoutes.post('/', zValidator('json', clientSchema), async (c) => {
  const db = getDb(c.env.DB)
  const body = c.req.valid('json')
  const client = await db.insert(clients).values({ id: crypto.randomUUID(), ...body }).returning().get()
  return c.json({ client }, 201)
})

// PUT /api/clients/:id
clientsRoutes.put('/:id', zValidator('json', clientSchema.partial()), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = c.req.valid('json')
  await db.update(clients).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(clients.id, id))
  const updated = await db.select().from(clients).where(eq(clients.id, id)).get()
  return c.json({ client: updated })
})

// DELETE /api/clients/:id — soft delete
clientsRoutes.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')

  // Verificar se há corridas vinculadas a este cliente
  const linkedRide = await db
    .select({ id: rides.id })
    .from(rides)
    .where(and(eq(rides.clientId, id), isNull(rides.deletedAt)))
    .limit(1)
    .get()

  if (linkedRide) {
    return c.json({
      error: 'Não é possível excluir este cliente pois ele possui corridas vinculadas. Desative-o em vez de excluir.',
    }, 409)
  }

  // Soft delete
  await db.update(clients).set({
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(clients.id, id))

  return c.json({ success: true })
})
