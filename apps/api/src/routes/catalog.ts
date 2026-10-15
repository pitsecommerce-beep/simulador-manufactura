import { CatalogQuery, catalogFacets, filterVariants } from '@sim/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../errors.ts';

const ComponentQuery = z.object({ category: z.string().trim().max(60).optional() });
const SlugParams = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*$/)
    .max(120),
});

// Catálogo de solo lectura. Se lee con el JWT del usuario: RLS exige sesión iniciada.
// Son pocas decenas de variantes, así que se filtra en memoria con la lógica de @sim/domain.
export async function catalogRoutes(app: FastifyInstance) {
  app.get('/catalog/variants', async (req) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    const query = CatalogQuery.parse(req.query);
    const all = await repo.listCatalogVariants();
    return { variants: filterVariants(all, query), total: all.length };
  });

  app.get('/catalog/facets', async (req) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    return catalogFacets(await repo.listCatalogVariants());
  });

  app.get('/catalog/components', async (req) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    const { category } = ComponentQuery.parse(req.query);
    const all = await repo.listCatalogComponents();
    return { components: category ? all.filter((c) => c.category === category) : all };
  });

  app.get('/catalog/variants/:slug', async (req) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    const { slug } = SlugParams.parse(req.params);
    const detail = await repo.getCatalogVariant(slug);
    if (!detail) throw httpError(404, 'Variante no encontrada');
    return detail;
  });
}
