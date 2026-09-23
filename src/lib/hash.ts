// Hash seguro usando Web Crypto API (compatível com Cloudflare Workers)
// Algoritmo: PBKDF2 (SHA-256) com 100 mil iterações e salt aleatório.

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder()
  const saltBuffer = crypto.getRandomValues(new Uint8Array(16))
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  )
  
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )

  const saltHex = Array.from(new Uint8Array(saltBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

  return `${saltHex}:${hashHex}`
}

export async function verifyPassword(password: string, hashStr: string): Promise<boolean> {
  if (!hashStr.includes(':')) {
    // Formato antigo não suportado
    return false
  }
  
  const [saltHex, originalHashHex] = hashStr.split(':')
  if (!saltHex || !originalHashHex) return false

  // Converter hex string back to Uint8Array
  const match = saltHex.match(/.{1,2}/g)
  if (!match) return false
  const saltArray = new Uint8Array(match.map(byte => parseInt(byte, 16)))
  
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  )
  
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltArray,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )
  
  const computedHashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  
  return computedHashHex === originalHashHex
}
