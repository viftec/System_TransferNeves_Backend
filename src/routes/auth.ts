import { Hono } from 'hono'
import { getDb } from '../db'
import { users, drivers, vehicles as vehiclesTable, pushSubscriptions } from '../db/schema'
import { hashPassword, verifyPassword } from '../lib/hash'
import { signToken } from '../lib/jwt'
import { eq } from 'drizzle-orm'
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/brevo'
import type { Env } from '../middleware/auth'
import { authMiddleware } from '../middleware/auth'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'

export const authRoutes = new Hono<{ Bindings: Env }>()

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  try {
    const { email, password } = await c.req.json()

    if (!email || !password) {
      return c.json({ error: 'Email e senha são obrigatórios' }, 400)
    }

    const db = getDb(c.env.DB)
    const secret = c.env.JWT_SECRET

    // Busca o usuário no D1
    const user = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()

    if (!user) {
      return c.json({ error: 'Credenciais inválidas' }, 401)
    }

    if (!user.active || !user.emailVerified) {
      return c.json({ error: 'Sua conta ainda não foi verificada. Verifique seu e-mail para ativar sua conta.' }, 403)
    }

    // Verifica senha
    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      return c.json({ error: 'Credenciais inválidas' }, 401)
    }

    // Gera JWT (expira em 2 horas conforme solicitado)
    const token = await signToken(
      { sub: user.id, email: user.email, role: user.role as 'admin' | 'driver' },
      secret,
      '2h'
    )

    // Se for motorista, busca o perfil completo
    let driverProfile = null
    if (user.role === 'driver') {
      driverProfile = await db.select().from(drivers).where(eq(drivers.userId, user.id)).get()
    }

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        company: user.company,
        driverId: driverProfile?.id ?? null,
        driverStatus: driverProfile?.status ?? null,
      }
    })
  } catch (error) {
    console.error('Login error:', error)
    return c.json({ error: 'Erro ao processar login' }, 500)
  }
})

// POST /api/auth/register (cria usuário — apenas via admin ou seed)
authRoutes.post('/register', async (c) => {
  try {
    const { email, password, name, role, phone } = await c.req.json()

    if (!email || !password || !name || !role) {
      return c.json({ error: 'Campos obrigatórios: email, password, name, role' }, 400)
    }

    if (name.length > 120) {
      return c.json({ error: 'Nome muito longo (máximo 120 caracteres)' }, 400)
    }

    if (email.length > 150) {
      return c.json({ error: 'E-mail muito longo (máximo 150 caracteres)' }, 400)
    }

    if (phone && phone.length > 20) {
      return c.json({ error: 'Telefone muito longo (máximo 20 caracteres)' }, 400)
    }

    if (password.length > 100) {
      return c.json({ error: 'Senha muito longa (máximo 100 caracteres)' }, 400)
    }

    const db = getDb(c.env.DB)
    const passwordHash = await hashPassword(password)

    const newUser = await db.insert(users).values({
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      passwordHash,
      name,
      role,
      phone,
    }).returning().get()

    return c.json({ user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role } }, 201)
  } catch (error: any) {
    if (error?.message?.includes('UNIQUE constraint')) {
      return c.json({ error: 'Este email já está cadastrado' }, 409)
    }
    return c.json({ error: 'Erro ao criar usuário' }, 500)
  }
})

// POST /api/auth/forgot-password
authRoutes.post('/forgot-password', async (c) => {
  try {
    const { email } = await c.req.json()
    if (!email) return c.json({ error: 'E-mail obrigatório' }, 400)

    const db = getDb(c.env.DB)
    const user = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
    
    // Always return success to prevent email enumeration (security best practice)
    if (!user) return c.json({ message: 'Se o e-mail existir, um link de recuperação será enviado.' }, 200)

    const apiKey = c.env.BREVO_API_KEY
    if (!apiKey) {
      console.error('Brevo API key not configured')
      return c.json({ error: 'Erro de configuração no servidor.' }, 500)
    }

    const resetToken = crypto.randomUUID()
    const now = new Date().toISOString()

    await db.update(users)
      .set({ resetToken, resetTokenCreatedAt: now })
      .where(eq(users.id, user.id))

    const frontendUrl = c.env.ENVIRONMENT === 'development'
      ? 'http://localhost:3000'
      : 'https://transferneves.viftec.com'

    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`
    await sendPasswordResetEmail(apiKey, user.email, user.name, resetUrl)

    return c.json({ message: 'Se o e-mail existir, um link de recuperação será enviado.' }, 200)
  } catch (error) {
    console.error('Forgot password error:', error)
    return c.json({ error: 'Erro ao processar recuperação de senha' }, 500)
  }
})

// GET /api/auth/reset-password
authRoutes.get('/reset-password', async (c) => {
  try {
    const token = c.req.query('token')
    if (!token) return c.json({ error: 'Token não fornecido' }, 400)

    const db = getDb(c.env.DB)
    const user = await db.select().from(users).where(eq(users.resetToken, token)).get()

    if (!user || !user.resetTokenCreatedAt) {
      return c.json({ error: 'Link expirado ou já utilizado.' }, 400)
    }

    const createdAt = new Date(user.resetTokenCreatedAt.replace(' ', 'T') + 'Z')
    const now = new Date()
    const diffHours = (now.getTime() - createdAt.getTime()) / (1000 * 3600)

    if (diffHours > 2) {
      // Clean up expired token
      await db.update(users).set({ resetToken: null, resetTokenCreatedAt: null }).where(eq(users.id, user.id))
      return c.json({ error: 'Link expirado ou já utilizado.' }, 400)
    }

    return c.json({ valid: true }, 200)
  } catch (error) {
    console.error('Reset token verify error:', error)
    return c.json({ error: 'Erro ao validar link' }, 500)
  }
})

// POST /api/auth/reset-password
authRoutes.post('/reset-password', async (c) => {
  try {
    const { token, newPassword } = await c.req.json()
    if (!token || !newPassword) return c.json({ error: 'Token e nova senha são obrigatórios' }, 400)

    // Security validation for strong password
    const hasMinLen = newPassword.length >= 6
    const hasUpper = /[A-Z]/.test(newPassword)
    const hasLower = /[a-z]/.test(newPassword)
    const hasNum = /[0-9]/.test(newPassword)
    const hasSpecial = /[\W_]/.test(newPassword)
    if (!hasMinLen || !hasUpper || !hasLower || !hasNum || !hasSpecial) {
      return c.json({ error: 'Senha não atende aos requisitos mínimos.' }, 400)
    }

    const db = getDb(c.env.DB)
    const user = await db.select().from(users).where(eq(users.resetToken, token)).get()

    if (!user || !user.resetTokenCreatedAt) {
      return c.json({ error: 'Link expirado ou já utilizado.' }, 400)
    }

    const createdAt = new Date(user.resetTokenCreatedAt.replace(' ', 'T') + 'Z')
    const now = new Date()
    const diffHours = (now.getTime() - createdAt.getTime()) / (1000 * 3600)

    if (diffHours > 2) {
      return c.json({ error: 'Link expirado ou já utilizado.' }, 400)
    }

    const passwordHash = await hashPassword(newPassword)

    await db.update(users)
      .set({ passwordHash, resetToken: null, resetTokenCreatedAt: null })
      .where(eq(users.id, user.id))

    return c.json({ message: 'Senha atualizada com sucesso' }, 200)
  } catch (error) {
    console.error('Reset password error:', error)
    return c.json({ error: 'Erro ao atualizar a senha' }, 500)
  }
})

// GET /api/auth/check-email
authRoutes.get('/check-email', async (c) => {
  try {
    const email = c.req.query('email')
    if (!email) return c.json({ error: 'E-mail não fornecido' }, 400)
    
    const db = getDb(c.env.DB)
    const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
    
    if (!existing) {
      return c.json({ exists: false, verified: false }, 200)
    }
    return c.json({ exists: true, verified: existing.emailVerified }, 200)
  } catch (error) {
    console.error('Check email error:', error)
    return c.json({ error: 'Erro ao verificar e-mail' }, 500)
  }
})

// POST /api/auth/register-driver
authRoutes.post('/register-driver', async (c) => {
  try {
    const { name, email, phone, password, cpf, cnh, cnhExpiry, street, number, complement, neighborhood, city, state, cep, cities, vehicles } = await c.req.json()

    if (!name || !email || !phone || !password || !cpf || !cnh || !street || !city) {
      return c.json({ error: 'Todos os campos são obrigatórios' }, 400)
    }

    if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
      return c.json({ error: 'É necessário cadastrar pelo menos 1 veículo' }, 400)
    }

    // Validate CPF format
    const cleanCPF = cpf.replace(/\D/g, '')
    if (cleanCPF.length !== 11) {
      return c.json({ error: 'CPF inválido' }, 400)
    }

    // Security validation for strong password
    const hasMinLen = password.length >= 6
    const hasUpper = /[A-Z]/.test(password)
    const hasLower = /[a-z]/.test(password)
    const hasNum = /[0-9]/.test(password)
    const hasSpecial = /[\W_]/.test(password)
    if (!hasMinLen || !hasUpper || !hasLower || !hasNum || !hasSpecial) {
      return c.json({ error: 'Senha não atende aos requisitos mínimos.' }, 400)
    }

    const db = getDb(c.env.DB)
    const apiKey = c.env.BREVO_API_KEY
    if (!apiKey) {
      console.error('Brevo API key not configured')
      return c.json({ error: 'Erro de configuração do servidor' }, 500)
    }

    // Check existing email
    const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
    if (existing) {
      if (existing.emailVerified) {
        return c.json({ error: 'Este e-mail já está cadastrado' }, 409)
      } else {
        // Se existe mas não foi verificado, apagamos os registros antigos para recriar
        const existingDriver = await db.select().from(drivers).where(eq(drivers.userId, existing.id)).get()
        if (existingDriver) {
          await db.delete(vehiclesTable).where(eq(vehiclesTable.driverId, existingDriver.id))
          await db.delete(drivers).where(eq(drivers.userId, existing.id))
        }
        await db.delete(users).where(eq(users.id, existing.id))
      }
    }

    const passwordHash = await hashPassword(password)
    const verificationToken = crypto.randomUUID()
    
    const userId = crypto.randomUUID()
    const driverId = crypto.randomUUID()

    // Create User (pending verification)
    await db.insert(users).values({
      id: userId,
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: 'driver',
      phone,
      active: true, // we use emailVerified to block login
      emailVerified: false,
      verificationToken,
    })

    // Create Driver profile
    await db.insert(drivers).values({
      id: driverId,
      userId,
      cnh,
      cnhExpiry: cnhExpiry || null,
      street,
      number: number || null,
      complement: complement || null,
      neighborhood: neighborhood || null,
      city,
      state,
      cep: cep || null,
      cities: cities && cities.length > 0 ? JSON.stringify(cities) : null,
      status: 'pending',
      cpf: cleanCPF,
    })

    // Create Vehicles
    for (const vData of vehicles) {
      if (!vData.type || !vData.model || !vData.plate || !vData.color) {
        return c.json({ error: 'Dados do veículo incompletos' }, 400)
      }
      await db.insert(vehiclesTable).values({
        id: crypto.randomUUID(),
        driverId,
        plate: vData.plate.toUpperCase(),
        color: vData.color,
        model: vData.model,
        type: vData.type,
        year: vData.year ? Number(vData.year) : null,
      })
    }

    // Enviar E-mail via Brevo
    const frontendUrl = c.env.ENVIRONMENT === 'development'
      ? 'http://localhost:3000'
      : 'https://transferneves.viftec.com'
      
    const verificationUrl = `${frontendUrl}/verify?token=${verificationToken}`

    await sendVerificationEmail(apiKey, email, name, verificationUrl)

    return c.json({ message: 'Cadastro realizado. Verifique seu e-mail para ativar a conta.' }, 201)
  } catch (error: any) {
    console.error('Register Driver Error:', error)
    const msg: string = error?.message ?? error?.cause?.message ?? ''
    if (msg.includes('vehicles.plate')) return c.json({ error: 'Esta placa já está cadastrada no sistema.' }, 409)
    if (msg.includes('drivers.cpf')) return c.json({ error: 'Este CPF já está cadastrado no sistema.' }, 409)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'Dado duplicado. Verifique e-mail, CPF ou placa.' }, 409)
    return c.json({ error: 'Erro ao realizar cadastro do motorista' }, 500)
  }
})

// GET /api/auth/verify
authRoutes.get('/verify', async (c) => {
  try {
    const token = c.req.query('token')

    if (!token) {
      return c.json({ error: 'Token não fornecido' }, 400)
    }

    const db = getDb(c.env.DB)
    
    // Find user by token
    const user = await db.select().from(users).where(eq(users.verificationToken, token)).get()

    if (!user) {
      return c.json({ error: 'Token inválido' }, 400)
    }

    if (user.emailVerified) {
      return c.json({ message: 'E-mail já verificado' }, 200)
    }

    // Check expiration (5 days)
    const createdAt = new Date(user.createdAt.replace(' ', 'T') + 'Z')
    const now = new Date()
    const diffDays = (now.getTime() - createdAt.getTime()) / (1000 * 3600 * 24)
    
    if (diffDays > 5) {
      // Clean up expired unverified user
      const existingDriver = await db.select().from(drivers).where(eq(drivers.userId, user.id)).get()
      if (existingDriver) {
        await db.delete(vehiclesTable).where(eq(vehiclesTable.driverId, existingDriver.id))
        await db.delete(drivers).where(eq(drivers.userId, user.id))
      }
      await db.delete(users).where(eq(users.id, user.id))
      
      return c.json({ error: 'Token expirado. Por favor, faça o cadastro novamente.' }, 400)
    }

    // Verify email (we keep the token so if they click again it says "already verified" instead of invalid)
    await db.update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id))
      
    return c.json({ message: 'E-mail verificado com sucesso' }, 200)
  } catch (error) {
    console.error('Verify Error:', error)
    return c.json({ error: 'Erro ao verificar e-mail' }, 500)
  }
})

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
})

// POST /api/auth/push-subscription (Registrar push genérico para admin/usuário)
authRoutes.post('/push-subscription', authMiddleware, zValidator('json', pushSubscriptionSchema), async (c) => {
  const db = getDb(c.env.DB)
  const user = c.get('jwtPayload')
  const { endpoint, keys } = c.req.valid('json')

  // Verificar se já existe subscription
  const existing = await db.select().from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .get()

  if (existing) {
    await db.update(pushSubscriptions)
      .set({
        userId: user.sub,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        active: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(pushSubscriptions.id, existing.id))
  } else {
    // Se for motorista, tenta achar o driverId
    let driverId = null
    if (user.role === 'driver') {
      const driver = await db.select().from(drivers).where(eq(drivers.userId, user.sub)).get()
      if (driver) driverId = driver.id
    }

    await db.insert(pushSubscriptions).values({
      id: crypto.randomUUID(),
      userId: user.sub,
      driverId,
      endpoint,
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
      active: true,
    })
  }

  return c.json({ success: true })
})

// DELETE /api/auth/push-subscription
authRoutes.delete('/push-subscription', authMiddleware, async (c) => {
  const db = getDb(c.env.DB)
  const user = c.get('jwtPayload')

  await db.update(pushSubscriptions)
    .set({ active: false, updatedAt: new Date().toISOString() })
    .where(eq(pushSubscriptions.userId, user.sub))

  return c.json({ success: true })
})

