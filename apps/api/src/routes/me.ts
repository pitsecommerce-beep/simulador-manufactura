import type { FastifyInstance } from 'fastify';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const user = app.requireUser(req);
    return { id: user.id, email: user.email };
  });
}
