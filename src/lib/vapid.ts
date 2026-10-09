/**
 * VAPID signing usando apenas Web Crypto API (compatível com Cloudflare Workers).
 * Não depende de node:crypto nem da lib web-push.
 *
 * Para gerar as chaves VAPID execute:
 *   npx web-push generate-vapid-keys
 *
 * Depois adicione como secrets no wrangler:
 *   wrangler secret put VAPID_PUBLIC_KEY
 *   wrangler secret put VAPID_PRIVATE_KEY
 *   wrangler secret put VAPID_SUBJECT   (ex: mailto:admin@transferneves.com.br)
 *
 * Localmente, coloque em .dev.vars:
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *   VAPID_SUBJECT=mailto:admin@transferneves.com.br
 */

function base64UrlDecode(base64url: string, fieldName: string = 'unknown'): Uint8Array<ArrayBuffer> {
  // Validar entrada
  if (!base64url || typeof base64url !== 'string') {
    throw new Error(`base64UrlDecode: entrada inválida para campo ${fieldName}`)
  }

  const length = base64url.length

  // Validar comprimento mínimo
  if (length === 0) {
    throw new Error(`base64UrlDecode: campo ${fieldName} está vazio`)
  }

  // Validar caracteres permitidos em Base64URL (a-z, A-Z, 0-9, -, _)
  if (!/^[a-zA-Z0-9\-_]+$/.test(base64url)) {
    // Identificar caracteres inválidos para diagnóstico
    const invalidChars = base64url.replace(/[a-zA-Z0-9\-_]/g, '').substring(0, 10)
    throw new Error(`base64UrlDecode: campo ${fieldName} contém caracteres inválidos (apenas a-z, A-Z, 0-9, -, _ são permitidos). Comprimento: ${length}. Caracteres inválidos encontrados: "${invalidChars}"`)
  }

  // Rejeitar comprimentos impossíveis (congruente a 1 módulo 4 após padding)
  if (length % 4 === 1) {
    throw new Error(`base64UrlDecode: campo ${fieldName} tem comprimento impossível (${length}). Base64URL não pode ter comprimento congruente a 1 módulo 4`)
  }

  // Converter - para + e _ para /
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')

  // Adicionar padding necessário
  const paddingNeeded = (4 - (base64.length % 4)) % 4
  const padded = base64.padEnd(base64.length + paddingNeeded, '=')

  try {
    const binary = atob(padded)
    const arr = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
    return arr as Uint8Array<ArrayBuffer>
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    throw new Error(`base64UrlDecode falhou para campo ${fieldName}: ${errMessage}. Comprimento original: ${length}, após padding: ${padded.length}`)
  }
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLength) as Uint8Array<ArrayBuffer>
  let offset = 0
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length }
  return result
}

async function createVapidJwt(subject: string, audience: string, privateKeyBase64: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })))
  const signingInput = `${header}.${claims}`

  // Validar e normalizar a chave privada VAPID.
  if (typeof privateKeyBase64 !== 'string' || !privateKeyBase64) {
    throw new Error('VAPID_PRIVATE_KEY ausente ou inválida')
  }

  // Remover apenas espaços externos e aspas que envolvem toda a chave.
  const cleanedKey = privateKeyBase64.trim().replace(/^(['"])(.*)\1$/, '$2')

  // Não remover espaços internos silenciosamente.
  if (/\s/.test(cleanedKey)) {
    throw new Error('VAPID_PRIVATE_KEY contém espaços ou quebras de linha internas')
  }

  // Rejeitar PEM explicitamente.
  if (cleanedKey.includes('-----BEGIN')) {
    throw new Error(
      'VAPID_PRIVATE_KEY está em formato PEM. É esperado Base64URL.'
    )
  }

  // Aceitar somente caracteres Base64URL.
  if (!/^[a-zA-Z0-9_-]+$/.test(cleanedKey)) {
    throw new Error(
      'VAPID_PRIVATE_KEY contém caracteres inválidos. É esperado Base64URL.'
    )
  }

  // Uma chave escalar P-256 de 32 bytes corresponde a 43 caracteres Base64URL.
  // O suporte a PKCS#8 deve ser validado separadamente, se realmente necessário.
  if (cleanedKey.length !== 43) {
    throw new Error(
      `VAPID_PRIVATE_KEY tem comprimento inválido: ${cleanedKey.length} caracteres (esperado 43 para chave P-256 gerada por web-push)`
    )
  }

  const rawKey = base64UrlDecode(cleanedKey, 'VAPID_PRIVATE_KEY')

  // Se for 32 bytes, é escalar bruto - precisa converter para PKCS#8
  // Se for ~110-120 bytes, já é PKCS#8 - pode importar diretamente
  if (rawKey.length === 32) {
    // Escalar privado P-256 de 32 bytes para PKCS#8.
    // O PKCS#8 contém uma estrutura ECPrivateKey válida,
    // não apenas o escalar precedido de um cabeçalho genérico.
    const pkcs8Header = new Uint8Array([
      0x30, 0x41, // SEQUENCE, 65 bytes de conteúdo
      0x02, 0x01, 0x00, // Versão PKCS#8: 0
      0x30, 0x13, // AlgorithmIdentifier
      0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
      0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07,
      0x04, 0x27, // OCTET STRING com 39 bytes
      0x30, 0x25, // ECPrivateKey SEQUENCE com 37 bytes de conteúdo
      0x02, 0x01, 0x01, // Versão ECPrivateKey: 1
      0x04, 0x20, // OCTET STRING com o escalar de 32 bytes
    ])

    const pkcs8Key = concat(pkcs8Header, rawKey)

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8Key.buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(signingInput)
    )

    return `${signingInput}.${base64UrlEncode(signature)}`
  } else if (rawKey.length >= 110 && rawKey.length <= 120) {
    // Já é PKCS#8 - importar diretamente
    console.log(`[vapid] Importando chave PKCS#8 com ${rawKey.length} bytes`)
    const privateKey = await crypto.subtle.importKey(
      'pkcs8', rawKey.buffer as ArrayBuffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    )
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput)
    )
    return `${signingInput}.${base64UrlEncode(signature)}`
  } else {
    throw new Error(`VAPID_PRIVATE_KEY decodificada tem comprimento inválido: ${rawKey.length} bytes (esperado 32 para escalar ou 110-120 para PKCS#8)`)
  }
}

async function encryptPushPayload(
  p256dh: string, auth: string, plaintext: string
): Promise<{ body: Uint8Array<ArrayBuffer>; serverPublicKey: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer> }> {
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>

  const serverKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey)) as Uint8Array<ArrayBuffer>

  const clientPubRaw = base64UrlDecode(p256dh, 'subscription.p256dh')

  // Validar comprimento esperado para chave pública ECDH P-256 (65 bytes para formato não comprimido)
  if (clientPubRaw.length !== 65) {
    throw new Error(`subscription.p256dh tem comprimento inválido: ${clientPubRaw.length} bytes (esperado 65 bytes para chave pública P-256 não comprimida)`)
  }

  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPubRaw.buffer as ArrayBuffer, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, serverKP.privateKey, 256)
  const authSecret = base64UrlDecode(auth, 'subscription.auth')

  // Validar comprimento esperado para auth (16 bytes)
  if (authSecret.length !== 16) {
    throw new Error(`subscription.auth tem comprimento inválido: ${authSecret.length} bytes (esperado 16 bytes)`)
  }

  // PRK via HKDF(auth, sharedSecret, info)
  const prkImport = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveBits'])
  const prkInfo = concat(new TextEncoder().encode('WebPush: info\x00') as Uint8Array<ArrayBuffer>, clientPubRaw, serverPubRaw)
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret.buffer as ArrayBuffer, info: prkInfo.buffer as ArrayBuffer }, prkImport, 256)) as Uint8Array<ArrayBuffer>

  const ikmKey = await crypto.subtle.importKey('raw', ikm.buffer as ArrayBuffer, { name: 'HKDF' }, false, ['deriveBits'])
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, info: new TextEncoder().encode('Content-Encoding: aes128gcm\x00').buffer as ArrayBuffer },
    ikmKey, 128
  )) as Uint8Array<ArrayBuffer>
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, info: new TextEncoder().encode('Content-Encoding: nonce\x00').buffer as ArrayBuffer },
    ikmKey, 96
  )) as Uint8Array<ArrayBuffer>

  const aesKey = await crypto.subtle.importKey('raw', cek.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt'])
  const textBytes = new TextEncoder().encode(plaintext) as Uint8Array<ArrayBuffer>
  const record = concat(textBytes, new Uint8Array([0x02]) as Uint8Array<ArrayBuffer>) // padding delimiter
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer }, aesKey, record.buffer as ArrayBuffer)) as Uint8Array<ArrayBuffer>

  // RFC 8188 header: salt(16) + recordSize(4) + keyIdLen(1) + keyId(65) + ciphertext
  const recordSizeBytes = new Uint8Array(4) as Uint8Array<ArrayBuffer>
  new DataView(recordSizeBytes.buffer).setUint32(0, 4096, false)
  const body = concat(salt, recordSizeBytes, new Uint8Array([serverPubRaw.length]) as Uint8Array<ArrayBuffer>, serverPubRaw, ciphertext)

  return { body, serverPublicKey: serverPubRaw, salt }
}

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export interface WebPushSubscription {
  endpoint: string
  p256dhKey: string
  authKey: string
}

export interface PushPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  sound?: boolean  // se true, SW toca alarme
  requireInteraction?: boolean
  data?: Record<string, unknown>
  actions?: Array<{ action: string; title: string }>
}

export type PushSendResult =
  | { success: true }
  | { success: false; error: 'config_error'; message: string }
  | { success: false; error: 'subscription_invalid'; message: string }
  | { success: false; error: 'http_permanent'; status: number; message: string }
  | { success: false; error: 'http_temporary'; status: number; message: string }
  | { success: false; error: 'rate_limited'; message: string }

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: PushPayload,
  vapid: VapidConfig
): Promise<PushSendResult> {
  try {
    const url = new URL(subscription.endpoint)
    const audience = `${url.protocol}//${url.host}`
    const jwt = await createVapidJwt(vapid.subject, audience, vapid.privateKey)
    const { body } = await encryptPushPayload(subscription.p256dhKey, subscription.authKey, JSON.stringify(payload))

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Authorization': `vapid t=${jwt},k=${vapid.publicKey}`,
        'TTL': '86400',
        'Urgency': 'high',
      },
      body: body.buffer as ArrayBuffer,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[vapid] Push falhou ${res.status}: ${text}`)

      // Tratar diferentes códigos de status
      if (res.status === 404 || res.status === 410) {
        // Endpoint expirado ou removido - assinatura inválida permanentemente
        return { success: false, error: 'http_permanent', status: res.status, message: text || 'Endpoint expirado' }
      }
      if (res.status === 429) {
        // Rate limitado - erro temporário
        return { success: false, error: 'rate_limited', message: text || 'Rate limit exceeded' }
      }
      if (res.status >= 500) {
        // Erro do servidor - erro temporário
        return { success: false, error: 'http_temporary', status: res.status, message: text || 'Server error' }
      }
      if (res.status >= 400) {
        // Outros erros 4xx - podem ser permanentes ou temporários
        return { success: false, error: 'http_temporary', status: res.status, message: text || 'Client error' }
      }
    }
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[vapid] Erro ao enviar push:', err)

    // Tentar identificar o tipo de erro pela mensagem
    if (message.includes('VAPID_PRIVATE_KEY') || message.includes('VAPID') || message.includes('chave')) {
      // Erro de configuração global - não desativar assinaturas
      return { success: false, error: 'config_error', message: 'Erro de configuração VAPID' }
    }
    if (message.includes('subscription.p256dh') || message.includes('subscription.auth')) {
      // Erro específico da assinatura - assinatura inválida
      return { success: false, error: 'subscription_invalid', message: 'Chaves da assinatura inválidas' }
    }
    // Outros erros - tratar como temporário por segurança
    return { success: false, error: 'http_temporary', status: 0, message: message }
  }
}
