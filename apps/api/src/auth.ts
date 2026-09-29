import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

export interface AuthUser {
  id: string;
  email: string | null;
  token: string;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export class AuthError extends Error {}

/**
 * Verifica JWT de Supabase Auth. Soporta llaves asimétricas (JWKS, proyectos nuevos)
 * y el secreto HS256 heredado si se configura SUPABASE_JWT_SECRET.
 */
export function supabaseTokenVerifier(opts: { supabaseUrl: string; jwtSecret?: string }): TokenVerifier {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;

  return async (token) => {
    let payload: JWTPayload;
    try {
      const { alg } = decodeProtectedHeader(token);
      const verifyOpts = { issuer, audience: 'authenticated' };
      if (alg === 'HS256') {
        if (!secret) throw new AuthError('Token HS256 sin SUPABASE_JWT_SECRET configurado');
        ({ payload } = await jwtVerify(token, secret, { ...verifyOpts, algorithms: ['HS256'] }));
      } else {
        ({ payload } = await jwtVerify(token, jwks, verifyOpts));
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Token inválido o vencido');
    }
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') {
      throw new AuthError('Se requiere una sesión de usuario');
    }
    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      token,
    };
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1] ?? null;
}
