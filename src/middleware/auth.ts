import { Context, Next } from 'hono'
import { verifyToken, extractBearerToken, JWTPayload } from '../lib/jwt'

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  JWT_SECRET: string
  BREVO_API_KEY: string
  ENVIRONMENT?: string
}

declare module 'hono' {
  interface ContextVariableMap {
    jwtPayload: JWTPayload
  }
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const token = extractBearerToken(c.req.header('Authorization') ?? null)

  if (!token) {
    return c.json({ error: 'Token não fornecido' }, 401)
  }

  const secret = c.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'Configuração de servidor inválida' }, 500)
  }

  try {
    const payload = await verifyToken(token, secret)
    
    // Verifica se o usuário ainda existe no banco
    const { getDb } = await import('../db')
    const { users } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    
    const db = getDb(c.env.DB)
    const user = await db.select().from(users).where(eq(users.id, payload.sub)).get()
    
    if (!user || !user.active) {
      return c.json({ error: 'Sessão inválida ou usuário inativo' }, 401)
    }

    c.set('jwtPayload', payload)
    await next()
  } catch {
    return c.json({ error: 'Token inválido ou expirado' }, 401)
  }
}

export async function adminOnly(c: Context<{ Bindings: Env }>, next: Next) {
  const payload = c.get('jwtPayload')
  if (payload?.role !== 'admin') {
    return c.json({ error: 'Acesso restrito a administradores' }, 403)
  }
  return await next()
}
