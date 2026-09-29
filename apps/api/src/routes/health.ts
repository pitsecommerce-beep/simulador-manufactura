import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  // Liveness para el healthcheck de Railway: responde 200 aunque Supabase no esté disponible.
  app.get('/health', async () => {
    const db = await app.deps.systemRepo.ping().catch(() => false);
    return {
      status: 'ok',
      service: 'api',
      version: app.deps.version,
      supabase: db ? 'ok' : 'error',
    };
  });

  // Readiness: 503 si no hay conexión con Supabase.
  app.get('/health/ready', async (_req, reply) => {
    const db = await app.deps.systemRepo.ping().catch(() => false);
    return reply.status(db ? 200 : 503).send({ ready: db });
  });
}
