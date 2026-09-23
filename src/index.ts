import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { ridesRoutes } from './routes/rides'
import { driversRoutes } from './routes/drivers'
import { clientsRoutes } from './routes/clients'
import { uploadsRoutes } from './routes/uploads'

const app = new Hono<{ Bindings: Env }>()

// CORS — permite frontend local e Cloudflare Pages
app.use('/*', cors({
  origin: [
    'http://localhost:3000',
    'http://10.0.70.125:3000',
    'https://transferneves.pages.dev',  // ajuste para seu domínio no Pages
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Health check
app.get('/health', (c) => c.json({
  ok: true,
  env: c.env.ENVIRONMENT ?? 'production',
  timestamp: new Date().toISOString(),
}))

// Rotas
app.route('/api/auth', authRoutes)
app.route('/api/rides', ridesRoutes)
app.route('/api/drivers', driversRoutes)
app.route('/api/clients', clientsRoutes)
app.route('/api/uploads', uploadsRoutes)

// 404 padrão
app.notFound((c) => c.json({ error: 'Rota não encontrada' }, 404))

// Erro global
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'Erro interno do servidor' }, 500)
})

export default app
