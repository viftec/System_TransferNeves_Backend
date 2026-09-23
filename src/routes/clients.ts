import { Hono } from 'hono'
import { getDb } from '../db'
import { clients } from '../db/schema'
import { eq, desc, like, or, sql } from 'drizzle-orm'
import { authMiddleware, adminOnly, type Env } from '../middleware/auth'

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
      or(
        like(clients.name, pattern),
        like(clients.fantasyName, pattern),
        like(clients.cpfCnpj, pattern),
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
      .orderBy(desc(clients.createdAt))
      .limit(limit)
      .offset(offset)
      .all()

    const countRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(clients)
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
clientsRoutes.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await c.req.json()
  const client = await db.insert(clients).values({ id: crypto.randomUUID(), ...body }).returning().get()
  return c.json({ client }, 201)
})

// PUT /api/clients/:id
clientsRoutes.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await c.req.json()
  await db.update(clients).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(clients.id, id))
  const updated = await db.select().from(clients).where(eq(clients.id, id)).get()
  return c.json({ client: updated })
})

// DELETE /api/clients/:id
clientsRoutes.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  await db.delete(clients).where(eq(clients.id, id))
  return c.json({ success: true })
})
