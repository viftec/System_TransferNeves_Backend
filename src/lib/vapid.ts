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

function base64UrlDecode(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length }
  return result
}

async function createVapidJwt(subject: string, audience: string, privateKeyBase64: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })))
  const signingInput = `${header}.${claims}`
  const rawKey = base64UrlDecode(privateKeyBase64)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

async function encryptPushPayload(
  p256dh: string, auth: string, plaintext: string
): Promise<{ body: Uint8Array; serverPublicKey: Uint8Array; salt: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16))

  const serverKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey))

  const clientPubKey = await crypto.subtle.importKey(
    'raw', base64UrlDecode(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, serverKP.privateKey, 256)
  const authSecret = base64UrlDecode(auth)

  // PRK via HKDF(auth, sharedSecret, info)
  const prkImport = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveBits'])
  const clientPubRaw = base64UrlDecode(p256dh)
  const prkInfo = concat(new TextEncoder().encode('WebPush: info\x00'), clientPubRaw, serverPubRaw)
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: prkInfo }, prkImport, 256))

  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits'])
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\x00') },
    ikmKey, 128
  ))
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\x00') },
    ikmKey, 96
  ))

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const textBytes = new TextEncoder().encode(plaintext)
  const record = concat(textBytes, new Uint8Array([0x02])) // padding delimiter
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record))

  // RFC 8188 header: salt(16) + recordSize(4) + keyIdLen(1) + keyId(65) + ciphertext
  const recordSizeBytes = new Uint8Array(4)
  new DataView(recordSizeBytes.buffer).setUint32(0, 4096, false)
  const body = concat(salt, recordSizeBytes, new Uint8Array([serverPubRaw.length]), serverPubRaw, ciphertext)

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

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: PushPayload,
  vapid: VapidConfig
): Promise<boolean> {
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
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[vapid] Push falhou ${res.status}: ${text}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[vapid] Erro ao enviar push:', err)
    return false
  }
}
