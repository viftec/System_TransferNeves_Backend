import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
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

// GET /api/drivers/admins
driversRoutes.get('/admins', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const result = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    phone: users.phone,
    createdAt: users.createdAt,
    active: users.active,
  }).from(users).where(eq(users.role, 'admin')).orderBy(desc(users.createdAt)).all()
  
  const mapped = result.map(r => ({ ...r, status: r.active ? 'active' : 'inactive' }))
  return c.json({ admins: mapped })
})

// GET /api/drivers/:id
driversRoutes.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')

  const driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)

  if (user.role === 'driver') {
    const ownerUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
    if (ownerUser?.id !== user.sub) return c.json({ error: 'Acesso negado' }, 403)
  }

  const driverVehicles = await db.select().from(vehicles).where(eq(vehicles.driverId, id)).all()
  const driverUser = await db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone }).from(users).where(eq(users.id, driver.userId)).get()
  return c.json({ driver, vehicles: driverVehicles, user: driverUser })
})

const createDriverSchema = z.object({
  user: z.object({
    name: z.string().min(3, 'Nome muito curto').max(120),
    email: z.string().email('E-mail inválido'),
    password: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100).optional(),
    phone: z.string().max(20).optional(),
  }),
  driver: z.object({
    cpf: z.string().min(11, 'CPF inválido').max(14),
    cnh: z.string().min(8, 'CNH inválida').max(20),
    cnhExpiry: z.string().optional(),
    street: z.string().max(255).optional(),
    number: z.string().max(20).optional(),
    complement: z.string().max(100).optional(),
    neighborhood: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(2).optional(),
    cep: z.string().max(10).optional(),
  }),
  vehicle: z.object({
    type: z.enum(['sedan', 'suv', 'hatch', 'utilitario', 'caminhao']),
    model: z.string().min(2).max(100),
    plate: z.string().min(7).max(10),
    year: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
    color: z.string().max(50).optional(),
  }).optional(),
})

// POST /api/drivers — cria motorista + usuário (admin only)
driversRoutes.post('/', adminOnly, zValidator('json', createDriverSchema), async (c) => {
  const db = getDb(c.env.DB)
  const { user: userData, driver: driverData, vehicle: vehicleData } = c.req.valid('json')

  // Verificar email duplicado
  const existingUser = await db.select().from(users).where(eq(users.email, userData.email.toLowerCase())).get()
  if (existingUser) return c.json({ error: 'Este e-mail já está cadastrado' }, 409)

  // Verificar CPF duplicado
  const existingDriver = await db.select().from(drivers).where(eq(drivers.cpf, driverData.cpf)).get()
  if (existingDriver) return c.json({ error: 'Este CPF já está cadastrado' }, 409)

  const passwordHash = await hashPassword(userData.password ?? 'Mudar@123')

  const newUser = await db.insert(users).values({
    id: crypto.randomUUID(),
    email: userData.email.toLowerCase(),
    passwordHash,
    name: userData.name,
    role: 'driver',
    phone: userData.phone,
    emailVerified: true,
    active: true,
  }).returning().get()

  const newDriver = await db.insert(drivers).values({
    id: crypto.randomUUID(),
    userId: newUser.id,
    cpf: driverData.cpf,
    cnh: driverData.cnh,
    cnhExpiry: driverData.cnhExpiry,
    street: driverData.street,
    number: driverData.number,
    complement: driverData.complement,
    neighborhood: driverData.neighborhood,
    city: driverData.city,
    state: driverData.state,
    cep: driverData.cep,
    status: 'approved',
  }).returning().get()

  let newVehicle = null
  if (vehicleData) {
    const existingVehicle = await db.select().from(vehicles).where(eq(vehicles.plate, vehicleData.plate.toUpperCase())).get()
    if (existingVehicle) return c.json({ error: 'Esta placa já está cadastrada' }, 409)

    newVehicle = await db.insert(vehicles).values({
      id: crypto.randomUUID(),
      driverId: newDriver.id,
      type: vehicleData.type,
      model: vehicleData.model,
      plate: vehicleData.plate.toUpperCase(),
      year: vehicleData.year,
      color: vehicleData.color,
    }).returning().get()
  }

  return c.json({ 
    user: { id: newUser.id, email: newUser.email, name: newUser.name, phone: newUser.phone, role: newUser.role, active: newUser.active }, 
    driver: newDriver, 
    vehicle: newVehicle 
  }, 201)
})

const createAdminSchema = z.object({
  name: z.string().min(3, 'Nome muito curto').max(120),
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  phone: z.string().max(20).optional(),
})

// POST /api/drivers/admin — cria administrador (admin only)
driversRoutes.post('/admin', adminOnly, zValidator('json', createAdminSchema), async (c) => {
  const db = getDb(c.env.DB)
  const body = c.req.valid('json')

  const existing = await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).get()
  if (existing) return c.json({ error: 'Este e-mail já está cadastrado' }, 409)

  const passwordHash = await hashPassword(body.password)

  const newUser = await db.insert(users).values({
    id: crypto.randomUUID(),
    email: body.email.toLowerCase(),
    passwordHash,
    name: body.name,
    role: 'admin',
    phone: body.phone,
    emailVerified: true,
    active: true,
  }).returning().get()

  return c.json({ user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role } }, 201)
})

const editAdminSchema = z.object({
  name: z.string().min(3, 'Nome muito curto').max(120),
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100).optional(),
  phone: z.string().max(20).optional(),
})

// PUT /api/drivers/admin/:id — edita administrador (admin only)
driversRoutes.put('/admin/:id', adminOnly, zValidator('json', editAdminSchema), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const body = c.req.valid('json')

  const admin = await db.select().from(users).where(eq(users.id, id)).get()
  if (!admin || admin.role !== 'admin') return c.json({ error: 'Administrador não encontrado' }, 404)

  if (body.email.toLowerCase() !== admin.email) {
    const existing = await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).get()
    if (existing) return c.json({ error: 'Este e-mail já está cadastrado' }, 409)
  }

  const updateData: any = {
    name: body.name,
    email: body.email.toLowerCase(),
    phone: body.phone || null,
  }

  if (body.password) {
    updateData.passwordHash = await hashPassword(body.password)
  }

  await db.update(users).set(updateData).where(eq(users.id, id))
  return c.json({ success: true })
})

const editDriverSchema = z.object({
  user: z.object({
    name: z.string().min(3).max(120),
    email: z.string().email(),
    password: z.string().min(6).max(100).optional(),
    phone: z.string().max(20).optional(),
  }),
  driver: z.object({
    cpf: z.string().min(11).max(14),
    cnh: z.string().min(8).max(20),
    cnhExpiry: z.string().optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(2).optional(),
  }),
  vehicle: z.object({
    type: z.string(),
    model: z.string(),
    plate: z.string(),
    year: z.number().optional(),
    color: z.string().optional(),
  }).optional()
})

// PUT /api/drivers/:id — edita motorista (admin only)
driversRoutes.put('/:id', adminOnly, zValidator('json', editDriverSchema), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { user: userData, driver: driverData, vehicle: vehicleData } = c.req.valid('json')

  const driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)
  const existingUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
  if (!existingUser) return c.json({ error: 'Usuário do motorista não encontrado' }, 404)

  if (userData.email.toLowerCase() !== existingUser.email) {
    const emailTaken = await db.select().from(users).where(eq(users.email, userData.email.toLowerCase())).get()
    if (emailTaken) return c.json({ error: 'Este e-mail já está em uso' }, 409)
  }

  if (driverData.cpf !== driver.cpf) {
    const cpfTaken = await db.select().from(drivers).where(eq(drivers.cpf, driverData.cpf)).get()
    if (cpfTaken) return c.json({ error: 'Este CPF já está em uso' }, 409)
  }

  const userUpdateData: any = {
    name: userData.name,
    email: userData.email.toLowerCase(),
    phone: userData.phone || null,
  }
  if (userData.password) {
    userUpdateData.passwordHash = await hashPassword(userData.password)
  }

  await db.update(users).set(userUpdateData).where(eq(users.id, driver.userId))

  await db.update(drivers).set({
    cpf: driverData.cpf,
    cnh: driverData.cnh,
    cnhExpiry: driverData.cnhExpiry || null,
    city: driverData.city || null,
    state: driverData.state || null,
  }).where(eq(drivers.id, id))

  if (vehicleData) {
    const existingVehicle = await db.select().from(vehicles).where(eq(vehicles.driverId, id)).get()
    if (existingVehicle) {
      if (vehicleData.plate.toUpperCase() !== existingVehicle.plate) {
        const plateTaken = await db.select().from(vehicles).where(eq(vehicles.plate, vehicleData.plate.toUpperCase())).get()
        if (plateTaken) return c.json({ error: 'Esta placa já está cadastrada' }, 409)
      }
      await db.update(vehicles).set({
        type: vehicleData.type as "sedan" | "suv" | "hatch" | "utilitario" | "caminhao",
        model: vehicleData.model,
        plate: vehicleData.plate.toUpperCase(),
        year: vehicleData.year || null,
        color: vehicleData.color || null,
      }).where(eq(vehicles.id, existingVehicle.id))
    } else {
      const plateTaken = await db.select().from(vehicles).where(eq(vehicles.plate, vehicleData.plate.toUpperCase())).get()
      if (plateTaken) return c.json({ error: 'Esta placa já está cadastrada' }, 409)
      await db.insert(vehicles).values({
        id: crypto.randomUUID(),
        driverId: id,
        type: vehicleData.type as "sedan" | "suv" | "hatch" | "utilitario" | "caminhao",
        model: vehicleData.model,
        plate: vehicleData.plate.toUpperCase(),
        year: vehicleData.year || null,
        color: vehicleData.color || null,
      })
    }
  }

  return c.json({ success: true })
})

// PATCH /api/drivers/:id/status
driversRoutes.patch('/:id/status', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = await c.req.json()

  const allowed = ['pending', 'approved', 'online', 'offline', 'suspended']
  if (!allowed.includes(status)) return c.json({ error: 'Status inválido' }, 400)

  const existing = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!existing) return c.json({ error: 'Motorista não encontrado' }, 404)

  await db.update(drivers).set({ status, updatedAt: new Date().toISOString() }).where(eq(drivers.id, id))
  return c.json({ success: true, status })
})

// PATCH /api/drivers/admin/:id/status
driversRoutes.patch('/admin/:id/status', adminOnly, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { status } = await c.req.json()

  if (status !== 'active' && status !== 'inactive') {
    return c.json({ error: 'Status inválido' }, 400)
  }

  const existing = await db.select().from(users).where(eq(users.id, id)).get()
  if (!existing || existing.role !== 'admin') return c.json({ error: 'Administrador não encontrado' }, 404)

  const active = status === 'active'
  await db.update(users).set({ active, updatedAt: new Date().toISOString() }).where(eq(users.id, id))
  return c.json({ success: true, status })
})
