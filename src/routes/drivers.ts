import { Hono } from 'hono'
import { getDb } from '../db'
import { drivers, vehicles, users } from '../db/schema'
import { eq, desc } from 'drizzle-orm'
import { authMiddleware, adminOnly, type Env } from '../middleware/auth'
import { hashPassword } from '../lib/hash'

export const driversRoutes = new Hono<{ Bindings: Env }>()

driversRoutes.use('/*', authMiddleware)

// GET /api/drivers
driversRoutes.get('/', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const result = await db.select({
    driver: drivers,
    user: { id: users.id, email: users.email, name: users.name, phone: users.phone },
  }).from(drivers).leftJoin(users, eq(drivers.userId, users.id)).orderBy(desc(drivers.createdAt)).all()
  return c.json({ drivers: result })
})

// GET /api/drivers/:id
driversRoutes.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')

  // Driver só pode ver o próprio perfil
  const driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)
  
  if (user.role === 'driver') {
    const ownerUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
    if (ownerUser?.id !== user.sub) return c.json({ error: 'Acesso negado' }, 403)
  }

  const driverVehicles = await db.select().from(vehicles).where(eq(vehicles.driverId, id)).all()
  return c.json({ driver, vehicles: driverVehicles })
})

// POST /api/drivers — cria motorista + usuário em uma operação (admin only)
driversRoutes.post('/', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const { user: userData, driver: driverData, vehicle: vehicleData } = await c.req.json()

  const passwordHash = await hashPassword(userData.password ?? '123456')

  // Cria o usuário
  const newUser = await db.insert(users).values({
    id: crypto.randomUUID(),
    email: userData.email.toLowerCase(),
    passwordHash,
    name: userData.name,
    role: 'driver',
    phone: userData.phone,
  }).returning().get()

  // Cria o perfil de motorista
  const newDriver = await db.insert(drivers).values({
    id: crypto.randomUUID(),
    userId: newUser.id,
    ...driverData,
  }).returning().get()

  // Cria veículo se fornecido
  let newVehicle = null
  if (vehicleData) {
    newVehicle = await db.insert(vehicles).values({
      id: crypto.randomUUID(),
      driverId: newDriver.id,
      ...vehicleData,
    }).returning().get()
  }

  return c.json({ user: newUser, driver: newDriver, vehicle: newVehicle }, 201)
})

// PATCH /api/drivers/:id/status
driversRoutes.patch('/:id/status', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = await c.req.json()
  await db.update(drivers).set({ status, updatedAt: new Date().toISOString() }).where(eq(drivers.id, id))
  return c.json({ success: true, status })
})
