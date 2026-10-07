import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getDb } from '../db'
import { drivers, vehicles, users, pushSubscriptions } from '../db/schema'
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

  // Fetch all vehicles in one query and group by driverId
  const allVehicles = await db.select().from(vehicles).all()
  const vehiclesByDriver: Record<string, typeof allVehicles> = {}
  for (const v of allVehicles) {
    if (!vehiclesByDriver[v.driverId]) vehiclesByDriver[v.driverId] = []
    vehiclesByDriver[v.driverId].push(v)
  }

  const mapped = result.map(r => ({
    ...r,
    vehicles: vehiclesByDriver[r.driver.id] ?? [],
  }))

  return c.json({ drivers: mapped })
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

  // Transform address fields to nested object for frontend
  const driverWithAddress = {
    ...driver,
    address: {
      street: driver.street,
      number: driver.number,
      complement: driver.complement,
      neighborhood: driver.neighborhood,
      city: driver.city,
      state: driver.state,
      cep: driver.cep,
    }
  }

  return c.json({ driver: driverWithAddress, vehicles: driverVehicles, user: driverUser })
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
    cities: z.array(z.string()).optional(),
  }),
  vehicles: z.array(z.object({
    type: z.enum(['sedan', 'suv', 'hatch', 'van', 'caminhonete', 'caminhao']),
    model: z.string().min(2).max(100),
    plate: z.string().min(7).max(10),
    year: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
    color: z.string().max(50).optional(),
  })).min(1, 'É obrigatório cadastrar pelo menos 1 veículo').max(5, 'Máximo de 5 veículos permitidos').optional(),
})

// POST /api/drivers — cria motorista + usuário (admin only)
driversRoutes.post('/', adminOnly, zValidator('json', createDriverSchema), async (c) => {
  const db = getDb(c.env.DB)
  const { user: userData, driver: driverData, vehicles: vehiclesData } = c.req.valid('json')

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
    cities: driverData.cities ? JSON.stringify(driverData.cities) : null,
    status: 'approved',
  }).returning().get()

  let insertedVehicles = []
  if (vehiclesData && vehiclesData.length > 0) {
    for (const vData of vehiclesData) {
      const existingVehicle = await db.select().from(vehicles).where(eq(vehicles.plate, vData.plate.toUpperCase())).get()
      if (existingVehicle) return c.json({ error: `A placa ${vData.plate} já está cadastrada` }, 409)

      const newVehicle = await db.insert(vehicles).values({
        id: crypto.randomUUID(),
        driverId: newDriver.id,
        type: vData.type,
        model: vData.model,
        plate: vData.plate.toUpperCase(),
        year: vData.year,
        color: vData.color,
      }).returning().get()
      insertedVehicles.push(newVehicle)
    }
  }

  return c.json({ 
    user: { id: newUser.id, email: newUser.email, name: newUser.name, phone: newUser.phone, role: newUser.role, active: newUser.active }, 
    driver: newDriver, 
    vehicles: insertedVehicles 
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
    street: z.string().max(255).optional(),
    number: z.string().max(20).optional(),
    complement: z.string().max(100).optional(),
    neighborhood: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(2).optional(),
    cep: z.string().max(10).optional(),
    cities: z.array(z.string()).optional(),
  }),
  vehicles: z.array(z.object({
    type: z.string(),
    model: z.string(),
    plate: z.string(),
    year: z.number().optional(),
    color: z.string().optional(),
  })).min(1).max(5).optional()
})

// PUT /api/drivers/:id — edita motorista (admin only)
driversRoutes.put('/:id', adminOnly, zValidator('json', editDriverSchema), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const { user: userData, driver: driverData, vehicles: vehiclesData } = c.req.valid('json')

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
    street: driverData.street || null,
    number: driverData.number || null,
    complement: driverData.complement || null,
    neighborhood: driverData.neighborhood || null,
    city: driverData.city || null,
    state: driverData.state || null,
    cep: driverData.cep || null,
    cities: driverData.cities ? JSON.stringify(driverData.cities) : null,
  }).where(eq(drivers.id, id))

  // Update vehicles: delete all old ones and reinsert the new list
  if (vehiclesData && vehiclesData.length > 0) {
    await db.delete(vehicles).where(eq(vehicles.driverId, id))
    for (const vData of vehiclesData) {
      const plate = vData.plate.toUpperCase()
      // Check if plate is used by another driver
      const plateTaken = await db.select().from(vehicles).where(eq(vehicles.plate, plate)).get()
      if (plateTaken && plateTaken.driverId !== id) return c.json({ error: `A placa ${plate} já está cadastrada por outro motorista` }, 409)
      await db.insert(vehicles).values({
        id: crypto.randomUUID(),
        driverId: id,
        type: vData.type as 'sedan' | 'suv' | 'hatch' | 'van' | 'caminhonete' | 'caminhao',
        model: vData.model,
        plate,
        year: vData.year || null,
        color: vData.color || null,
      })
    }
  }

  return c.json({ success: true })
})

// PATCH /api/drivers/:id/status (admin only - para aprovar/suspender)
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

// PATCH /api/drivers/:id/availability (driver only - para motorista mudar online/offline)
driversRoutes.patch('/:id/availability', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')
  const { status } = await c.req.json()

  // Verificar se é o próprio motorista
  let driver;
  if (id === 'me') {
    driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
  } else {
    driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
    if (driver) {
      const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
      if (driverUser?.id !== user.sub) return c.json({ error: 'Acesso negado' }, 403)
    }
  }

  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)

  // Apenas permitir online/offline
  const allowed = ['online', 'offline']
  if (!allowed.includes(status)) return c.json({ error: 'Status inválido para esta operação' }, 400)

  // Não permitir mudar status se estiver pending ou suspended
  if (driver.status === 'pending') return c.json({ error: 'Sua conta ainda está em análise' }, 403)
  if (driver.status === 'suspended') return c.json({ error: 'Sua conta está suspensa' }, 403)

  await db.update(drivers).set({ status, updatedAt: new Date().toISOString() }).where(eq(drivers.id, driver.id))
  return c.json({ success: true, status })
})

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
})

// POST /api/drivers/:id/push-subscription (driver only - registrar push subscription)
driversRoutes.post('/:id/push-subscription', zValidator('json', pushSubscriptionSchema), async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')
  const { endpoint, keys } = c.req.valid('json')

  // Verificar se é o próprio motorista
  const driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)

  const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
  if (driverUser?.id !== user.sub) return c.json({ error: 'Acesso negado' }, 403)

  // Verificar se já existe subscription, se sim, atualiza
  const existing = await db.select().from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .get()

  if (existing) {
    await db.update(pushSubscriptions)
      .set({
        userId: driverUser.id,
        driverId: id,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        active: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(pushSubscriptions.id, existing.id))
  } else {
    await db.insert(pushSubscriptions).values({
      id: crypto.randomUUID(),
      userId: driverUser.id,
      driverId: id,
      endpoint,
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
      active: true,
    })
  }

  return c.json({ success: true })
})

// DELETE /api/drivers/:id/push-subscription (driver only - remover push subscription)
driversRoutes.delete('/:id/push-subscription', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id') as string
  const user = c.get('jwtPayload')

  // Verificar se é o próprio motorista
  const driver = await db.select().from(drivers).where(eq(drivers.id, id)).get()
  if (!driver) return c.json({ error: 'Motorista não encontrado' }, 404)

  const driverUser = await db.select().from(users).where(eq(users.id, driver.userId)).get()
  if (driverUser?.id !== user.sub) return c.json({ error: 'Acesso negado' }, 403)

  await db.update(pushSubscriptions)
    .set({ active: false, updatedAt: new Date().toISOString() })
    .where(eq(pushSubscriptions.driverId, id))

  return c.json({ success: true })
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
