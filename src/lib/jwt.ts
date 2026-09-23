import { SignJWT, jwtVerify } from 'jose'

export interface JWTPayload {
  sub: string        // user id
  email: string
  role: 'admin' | 'driver'
  iat?: number
  exp?: number
}

export async function signToken(
  payload: Omit<JWTPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn = '7d'
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret)
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey)
}

export async function verifyToken(token: string, secret: string): Promise<JWTPayload> {
  const secretKey = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, secretKey)
  return payload as unknown as JWTPayload
}

// Extrai token do header Authorization: Bearer <token>
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}
