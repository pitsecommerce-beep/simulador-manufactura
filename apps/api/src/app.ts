import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { httpError } from './errors.ts';
import { AuthError, bearerToken, type AuthUser, type TokenVerifier } from './auth.ts';
import type { SystemRepo, UserRepo } from './repo.ts';
import { RepoError } from './repo.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { healthRoutes } from './routes/health.ts';
import { meRoutes } from './routes/me.ts';
import { projectRoutes } from './routes/projects.ts';

export interface AppDeps {
  verifyToken: TokenVerifier;
  userRepo: (user: AuthUser) => UserRepo;
  systemRepo: SystemRepo;
  corsOrigins: string[];
  rateLimitPerMinute: number;
  version: string;
  logLevel?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
  interface FastifyInstance {
    deps: AppDeps;
    /** Devuelve el usuario autenticado o lanza 401. */
    requireUser(req: FastifyRequest): AuthUser;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logLevel ? { level: deps.logLevel } : false,
    bodyLimit: 1024 * 1024,
    trustProxy: true, // Railway pone un proxy delante
  });

  app.decorate('deps', deps);
  app.decorateRequest('user', null);

  await app.register(helmet);
  await app.register(cors, {
    origin: deps.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute,
    timeWindow: '1 minute',
    hook: 'preHandler', // después de autenticar, para limitar por usuario
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  // Autenticación: si hay Bearer se verifica; las rutas deciden si es obligatorio.
  app.addHook('onRequest', async (req) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return;
    try {
      req.user = await deps.verifyToken(token);
    } catch (err) {
      if (err instanceof AuthError) throw httpError(401, err.message);
      throw err;
    }
  });

  app.decorate('requireUser', (req: FastifyRequest) => {
    if (!req.user) throw httpError(401, 'Inicia sesión para continuar');
    return req.user;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation',
        message: 'Datos inválidos',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof RepoError) {
      if (err.status >= 500) req.log.error(err);
      return reply.status(err.status).send({ error: 'repo', message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.status(500).send({ error: 'internal', message: 'Error interno' });
    }
    return reply.status(status).send({ error: 'request', message: (err as Error).message });
  });

  await app.register(healthRoutes);
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(projectRoutes, { prefix: '/v1' });
  await app.register(catalogRoutes, { prefix: '/v1' });
  return app;
}
