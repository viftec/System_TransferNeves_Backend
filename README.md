# Backend — Cloudflare Worker (Transfer Neves API)

## Stack
- **Runtime**: Cloudflare Workers
- **Framework**: Hono (semelhante ao FastAPI/Express)
- **Banco**: Cloudflare D1 (SQLite serverless) via Drizzle ORM
- **Storage**: Cloudflare R2 (bucket de arquivos)
- **Auth**: JWT com `jose` (compatível com Workers)

---

## Estrutura de arquivos

```
backend/
├── src/
│   ├── index.ts              ← Entrypoint principal (registra todas as rotas)
│   ├── db/
│   │   ├── schema.ts         ← Schema Drizzle (tabelas D1)
│   │   └── index.ts          ← Helper para criar instância do Drizzle
│   ├── lib/
│   │   ├── jwt.ts            ← Sign/Verify JWT com jose
│   │   └── hash.ts           ← Hash de senha com Web Crypto API
│   ├── middleware/
│   │   └── auth.ts           ← Middleware de autenticação + tipo Env
│   └── routes/
│       ├── auth.ts           ← POST /api/auth/login, /api/auth/register
│       ├── rides.ts          ← CRUD /api/rides
│       ├── drivers.ts        ← CRUD /api/drivers
│       ├── clients.ts        ← CRUD /api/clients
│       └── uploads.ts        ← POST /api/uploads (R2)
├── migrations/
│   └── 0001_initial_schema.sql ← Migration SQL para criar todas as tabelas no D1
├── wrangler.toml             ← Configuração do Worker (bindings D1 + R2)
├── drizzle.config.ts         ← Configuração do Drizzle Kit
└── package.json
```

---

## Como rodar

### Desenvolvimento local
```bash
cd backend
npm run dev
# Worker sobe em http://localhost:8787
# Com D1 local simulado automaticamente pelo Wrangler
```

### ⚠️ IMPORTANTE: JWT_SECRET local
O Wrangler não lê secrets localmente. Para dev local, adicione ao `wrangler.toml`:
```toml
[vars]
JWT_SECRET = "minha-chave-secreta-local-dev"
```
Nunca commite isso. Para produção, use:
```bash
wrangler secret put JWT_SECRET
```

---

## Aplicar migrations no D1

### Local (dev)
```bash
wrangler d1 migrations apply DB --local
```

### Produção (Cloudflare)
```bash
wrangler d1 migrations apply DB --remote
```

---

## Pegar o database_id do D1

Execute no terminal:
```bash
wrangler d1 list
```
Copie o ID do banco `transferneves` e cole no `wrangler.toml` no campo `database_id`.

---

## Deploy para Cloudflare

```bash
# Antes do primeiro deploy, certifique-se que o JWT_SECRET está como secret:
wrangler secret put JWT_SECRET

# Deploy
npm run deploy
```

---

## Endpoints disponíveis

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /health | — | Health check |
| POST | /api/auth/login | — | Login (retorna JWT) |
| POST | /api/auth/register | — | Cadastro de usuário |
| GET | /api/rides | JWT | Lista corridas |
| GET | /api/rides/:id | JWT | Detalhe da corrida |
| POST | /api/rides | Admin | Cria corrida |
| PATCH | /api/rides/:id/status | JWT | Atualiza status |
| DELETE | /api/rides/:id | Admin | Remove corrida |
| GET | /api/drivers | Admin | Lista motoristas |
| GET | /api/drivers/:id | JWT | Detalhe do motorista |
| POST | /api/drivers | Admin | Cria motorista |
| PATCH | /api/drivers/:id/status | Admin | Atualiza status |
| GET | /api/clients | Admin | Lista clientes |
| POST | /api/clients | Admin | Cria cliente |
| PUT | /api/clients/:id | Admin | Atualiza cliente |
| DELETE | /api/clients/:id | Admin | Remove cliente |
| POST | /api/uploads | JWT | Upload para R2 |
| GET | /api/uploads/:key | JWT | Serve arquivo do R2 |
