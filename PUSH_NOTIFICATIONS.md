# Configuração de Notificações Push

## Visão Geral

O sistema de notificações push foi implementado para notificar motoristas quando novas corridas disponíveis surgirem em sua região.

## Backend

### 1. Configurar VAPID Keys

Para que as notificações Web Push funcionem, você precisa configurar chaves VAPID:

```bash
# Gerar chaves VAPID
npx web-push generate-vapid-keys
```

Isso vai gerar:
- Public Key
- Private Key

### 2. Adicionar como secrets no Wrangler

```bash
# Local
wrangler secret put VAPID_PUBLIC_KEY --local
wrangler secret put VAPID_PRIVATE_KEY --local

# Produção
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
```

### 3. Atualizar lib/push.ts

No arquivo `src/lib/push.ts`, adicione a chamada real ao web-push:

```typescript
import webpush from 'web-push'

// Configurar VAPID
webpush.setVapidDetails(
  'mailto:contato@transferneves.com.br',
  c.env.VAPID_PUBLIC_KEY,
  c.env.VAPID_PRIVATE_KEY
)

// Enviar notificação
await webpush.sendNotification(subscription, payload)
```

## Frontend

### 1. Configurar Application Server Key

No frontend, você precisa da public key VAPID. Adicione ao `.env.local`:

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=sua_chave_publica_aqui
```

### 2. Usar o componente DriverStatusControl

No componente do motorista, adicione:

```tsx
import { DriverStatusControl } from '@/components/driver/driver-status-control'

<DriverStatusControl
  driverId={driverId}
  token={token}
  applicationServerKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!}
/>
```

### 3. Service Worker

O service worker já está configurado em `public/sw.js`. Ele:
- Recebe notificações push
- Mostra notificação nativa
- Permite clicar para ver a corrida

## Fluxo Completo

1. **Motorista vai online**
   - Motorista clica em "Go Online"
   - Status muda para `online` no banco
   - Backend sabe que pode receber notificações

2. **Motorista habilita notificações**
   - Motorista clica em "Habilitar Notificações"
   - Frontend pede permissão ao navegador
   - Gera push subscription
   - Envia subscription para o backend
   - Backend salva na tabela `push_subscriptions`

3. **Admin cria nova corrida**
   - Admin cria corrida com origem em Boituva
   - Backend salva corrida com status `disponivel`
   - Backend busca motoristas online em Boituva
   - Backend filtra por tipo de veículo (se especificado)
   - Backend envia Web Push para cada motorista elegível

4. **Motorista recebe notificação**
   - Service Worker recebe push
   - Mostra notificação: "🚗 Nova corrida disponível - Boituva → Sorocaba"
   - Motorista clica na notificação
   - Abre a página da corrida

5. **Motorista aceita corrida**
   - Motorista clica em "Aceitar"
   - Backend verifica se ainda está disponível (atômico)
   - Backend verifica se tem veículo compatível
   - Backend verifica conflito de horário
   - Backend muda status para `aceita`
   - Outros motoristas não podem mais aceitar

## Notas Importantes

- O cron job roda a cada 1 minuto (configurado em `wrangler.toml`)
- Corridas expiram 5 minutos após o horário agendado
- Corridas não podem ser criadas para o passado
- Motoristas só podem aceitar corridas se tiverem veículo compatível
- Motoristas ficam reservados para o horário da corrida (conflito de 30 min)
- Notificações são não-críticas (se falhar, não quebra o fluxo)

## Testes

Para testar notificações em desenvolvimento:

1. Use um navegador que suporte Service Workers (Chrome, Firefox, Edge)
2. Execute o frontend em HTTPS ou localhost
3. Verifique o console para logs do Service Worker
4. Use ferramentas como "Push Notifications" no Chrome DevTools
