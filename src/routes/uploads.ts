import { Hono } from 'hono'
import { uploads } from '../db/schema'
import { getDb } from '../db'
import { authMiddleware, type Env } from '../middleware/auth'

export const uploadsRoutes = new Hono<{ Bindings: Env }>()

uploadsRoutes.use('/*', authMiddleware)

// POST /api/uploads — faz upload para R2 e registra metadados no D1
uploadsRoutes.post('/', async (c) => {
  const user = c.get('jwtPayload')
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  const entityType = formData.get('entityType') as string
  const entityId = formData.get('entityId') as string

  if (!file || !entityType || !entityId) {
    return c.json({ error: 'Campos obrigatórios: file, entityType, entityId' }, 400)
  }

  const ext = file.name.split('.').pop() ?? 'bin'
  const r2Key = `${entityType}/${entityId}/${crypto.randomUUID()}.${ext}`

  // Upload para R2
  await c.env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  })

  // Salva referência no D1
  const db = getDb(c.env.DB)
  const upload = await db.insert(uploads).values({
    id: crypto.randomUUID(),
    r2Key,
    entityType,
    entityId,
    contentType: file.type,
    sizeBytes: file.size,
    uploadedBy: user.sub,
  }).returning().get()

  return c.json({ upload, r2Key }, 201)
})

// GET /api/uploads/:key — gera URL pré-assinada ou retorna o objeto
uploadsRoutes.get('/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const obj = await c.env.FILES.get(key)

  if (!obj) return c.json({ error: 'Arquivo não encontrado' }, 404)

  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  return new Response(obj.body, { headers })
})
