import { randomUUID } from 'node:crypto';
import {
  CatalogQuery,
  componentWeightKg,
  compileProcess,
  enforceAssistantOrigins,
  filterVariants,
  modelAssumptions,
  ProcessModel,
  publishedCycleOptions,
  robotModelFromDetail,
  Scene,
  SceneObject,
  validateProcess,
  validateScene,
  type AiProposal,
  type CatalogComponent,
  type CatalogVariant,
  type CatalogVariantDetail,
  type ProposalEstimate,
  type RobotModel,
} from '@sim/domain';
import { z } from 'zod';
import type { AuthUser } from '../auth.ts';
import type { SystemRepo, UserRepo } from '../repo.ts';
import type { SimSettings } from '../sim.ts';
import type { AiSettings, ToolSpec } from './provider.ts';

// Herramientas del asistente. Todas leen con el JWT del usuario (RLS); la corrida rápida se
// crea con la clave secreta tras comprobar los permisos en la ruta, igual que /runs.

export interface ToolContext {
  user: AuthUser;
  repo: UserRepo;
  systemRepo: SystemRepo;
  projectId: string;
  sim: SimSettings | null;
  ai: AiSettings;
  /** Propuestas de la conversación (las nuevas se agregan aquí). */
  proposals: AiProposal[];
}

export interface ToolOutcome {
  ok: boolean;
  /** Se envía al modelo como JSON. */
  result: unknown;
  /** Resumen para el registro de llamadas. */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const SceneInput = z.object({
  schema: z.literal(2),
  objects: z.array(SceneObject).min(1),
  process: ProcessModel,
});

/** JSON Schema de la escena a partir del esquema Zod que la valida (una sola fuente). */
function sceneJsonSchema(extra: Record<string, z.ZodType>) {
  const schema = z.toJSONSchema(z.object({ ...extra, scene: SceneInput }), {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

const COMPONENT_CATEGORIES = ['grippers', 'sensors', 'safety', 'conveyors', 'fences'] as const;

const SCENE_FORMAT = `Formato de la escena (schema 2): milímetros y grados, eje Z hacia arriba. \
Cada objeto tiene id único, name, kind, position [x, y] del centro en planta, elevation (altura de \
la base sobre el piso), rotation_deg, color (#rrggbb), served_by (id del robot que lo atiende, para \
validar alcance y carga) y params según kind: robot {variant_slug} (slug del catálogo); pallet \
{preset, length_mm, width_mm, height_mm}; box {length_mm, width_mm, height_mm, mass_kg}; table y \
conveyor {length_mm, width_mm, height_mm}; gripper {component_slug, mounted_on (id del robot)}; \
sensor {component_slug}; fence {length_mm, height_mm, thickness_mm, component_slug}; safety_zone \
{length_mm, width_mm}. Las medidas de mesas, bandas, cajas y vallas son supuestos de diseño, no \
datos de ficha. process: product {name, bom}, nodes (un rol por objeto: source en banda, mesa, \
pallet o caja; station en robot, banda o mesa; buffer en banda o mesa; sink en banda, mesa o \
pallet) y routes {id, from, to, item, share}. Los tiempos son {dist, origin, note} con dist fixed \
{value}, exponential {mean}, normal {mean, sd}, lognormal {mean, sd}, uniform {min, max} o \
triangular {min, mode, max}, en segundos; origin es "assistant" salvo un ciclo tomado tal cual de \
get_variant (published_cycle_times), que es "catalog".`;

export function toolSpecs(hasSim: boolean): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'search_catalog',
      description:
        'Busca variantes de robot en el catálogo. Devuelve slug, código, familia, aplicación, carga ' +
        'útil y alcance de la ficha (null = no publicado). Los filtros numéricos excluyen variantes ' +
        'sin ese dato publicado.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Texto en modelo, código o familia (ej. "IRB 460")' },
          family: { type: 'string', description: 'Familia exacta (ej. "Palletizing 4-axis")' },
          application: { type: 'string', description: 'Aplicación exacta' },
          payload_min_kg: { type: 'number' },
          payload_max_kg: { type: 'number' },
          reach_min_mm: { type: 'number' },
          reach_max_mm: { type: 'number' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'get_variant',
      description:
        'Ficha completa de una variante: specs con su procedencia, rangos de eje, tiempos de ciclo ' +
        'publicados y documentos. Un dato null no está publicado: dilo así, no lo estimes.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_components',
      description:
        'Componentes del catálogo (grippers, sensores, seguridad, bandas, vallas) con su ficha tal ' +
        'cual. Úsalos por su slug.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { category: { type: 'string', enum: [...COMPONENT_CATEGORIES] } },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'propose_scene',
      description:
        'Registra una propuesta de layout y modelo de proceso para que el usuario la vea en su ' +
        'cuadrícula. Valida el esquema, que cada variant_slug y component_slug exista en el ' +
        'catálogo, alcance, carga, colisiones (cajas delimitadoras) y el flujo. Si hay errores no ' +
        'se registra: corrígelos y vuelve a llamar. Devuelve proposal_id y advertencias. ' +
        SCENE_FORMAT,
      strict: false,
      input_schema: sceneJsonSchema({
        summary: z.string().describe('Resumen de una o dos frases de la propuesta'),
        assumptions: z
          .array(z.string())
          .describe('Supuestos usados (medidas, tiempos y datos no publicados)'),
      }),
    },
    {
      name: 'validate_scene',
      description:
        'Mismas validaciones que propose_scene sobre una escena, sin registrarla como propuesta. ' +
        SCENE_FORMAT,
      strict: false,
      input_schema: sceneJsonSchema({}),
    },
  ];
  if (hasSim)
    tools.push({
      name: 'run_simulation',
      description:
        'Corrida rápida de una propuesta ya registrada (pocas réplicas, horizonte corto) para ' +
        'estimar la producción. Espera como máximo 60 s; si tarda más devuelve "sin estimación". ' +
        'Requiere que el proyecto tenga un layout guardado.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string' },
          demand_per_hour: {
            type: 'number',
            description: 'Demanda del cliente (u/h), si se conoce',
          },
        },
        required: ['proposal_id'],
        additionalProperties: false,
      },
    });
  return tools;
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

/** Catálogo cargado una vez por mensaje. */
class CatalogCache {
  private variants: Promise<CatalogVariant[]> | null = null;
  private components: Promise<CatalogComponent[]> | null = null;
  private details = new Map<string, Promise<CatalogVariantDetail | null>>();
  private repo: UserRepo;
  constructor(repo: UserRepo) {
    this.repo = repo;
  }
  listVariants() {
    return (this.variants ??= this.repo.listCatalogVariants());
  }
  listComponents() {
    return (this.components ??= this.repo.listCatalogComponents());
  }
  detail(slug: string) {
    let d = this.details.get(slug);
    if (!d) {
      d = this.repo.getCatalogVariant(slug);
      this.details.set(slug, d);
    }
    return d;
  }
}

const ok = (result: unknown, detail: string | null = null): ToolOutcome => ({
  ok: true,
  result,
  detail,
});
const fail = (errors: string[]): ToolOutcome => ({
  ok: false,
  result: { ok: false, errors },
  detail: errors[0] ?? null,
});

type Checked =
  | { ok: false; errors: string[] }
  | {
      ok: true;
      scene: Scene;
      notes: string[];
      warnings: AiProposal['warnings'];
      process_issues: AiProposal['process_issues'];
      robots: AiProposal['robots'];
      components: AiProposal['components'];
    };

/** Validaciones comunes de propose_scene y validate_scene. */
async function checkScene(raw: unknown, catalog: CatalogCache): Promise<Checked> {
  const parsed = Scene.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 30)
        .map((i) => `scene.${i.path.join('.')}: ${i.message}`),
    };
  }
  const errors: string[] = [];
  if (parsed.data.objects.length === 0) errors.push('La escena no tiene objetos.');

  const [variants, components] = await Promise.all([
    catalog.listVariants(),
    catalog.listComponents(),
  ]);
  const variantBySlug = new Map(variants.map((v) => [v.slug, v]));
  const componentBySlug = new Map(components.map((c) => [c.slug, c]));
  const robotSlugs = new Set<string>();
  const componentSlugs = new Set<string>();
  for (const o of parsed.data.objects) {
    if (o.kind === 'robot') {
      if (!variantBySlug.has(o.params.variant_slug))
        errors.push(
          `${o.name}: la variante "${o.params.variant_slug}" no existe en el catálogo. Búscala con search_catalog.`,
        );
      else robotSlugs.add(o.params.variant_slug);
    }
    const slug =
      o.kind === 'gripper' || o.kind === 'sensor' || o.kind === 'fence'
        ? o.params.component_slug
        : null;
    if (slug) {
      if (!componentBySlug.has(slug))
        errors.push(
          `${o.name}: el componente "${slug}" no existe en el catálogo. Consulta list_components o usa null.`,
        );
      else componentSlugs.add(slug);
    }
  }
  if (errors.length) return { ok: false, errors };

  const details = new Map<string, CatalogVariantDetail>();
  for (const slug of robotSlugs) {
    const d = await catalog.detail(slug);
    if (d) details.set(slug, d);
  }
  const models = new Map<string, RobotModel>(
    [...details].map(([slug, d]) => [slug, robotModelFromDetail(d)]),
  );
  const cyclesFor = (objectId: string) => {
    const o = parsed.data.objects.find((x) => x.id === objectId);
    return o?.kind === 'robot'
      ? publishedCycleOptions(details.get(o.params.variant_slug))
      : undefined;
  };
  const { scene, notes } = enforceAssistantOrigins(parsed.data, cyclesFor);

  const process_issues = validateProcess(scene.process, {
    objects: scene.objects.map((o) => ({ id: o.id, kind: o.kind, name: o.name })),
    publishedCycles: (id) => cyclesFor(id)?.map((c) => c.value_s),
  });
  if (scene.process.nodes.length === 0)
    process_issues.push({
      level: 'warning',
      code: 'no_source',
      objects: [],
      message: 'La propuesta no tiene modelo de proceso: no se puede simular.',
    });
  const flowErrors = process_issues.filter((i) => i.level === 'error');
  if (flowErrors.length) return { ok: false, errors: flowErrors.map((i) => `Flujo: ${i.message}`) };

  const warnings = validateScene(
    scene,
    (slug) => models.get(slug),
    (slug) => {
      const c = componentBySlug.get(slug);
      return c
        ? { name: `${c.manufacturer ?? ''} ${c.model}`.trim(), weight_kg: componentWeightKg(c) }
        : null;
    },
  );
  return {
    ok: true,
    scene,
    notes,
    warnings,
    process_issues,
    robots: [...robotSlugs].map((slug) => {
      const v = variantBySlug.get(slug)!;
      return {
        slug,
        variant_code: v.variant_code,
        model: v.model,
        family: v.family,
        kinematic_type: v.kinematic_type,
      };
    }),
    components: [...componentSlugs].map((slug) => {
      const c = componentBySlug.get(slug)!;
      return { slug, model: c.model, manufacturer: c.manufacturer, category: c.category };
    }),
  };
}

const validationReport = (c: Extract<Checked, { ok: true }>) => ({
  warnings: c.warnings.map(
    (w) => `${w.level === 'warning' ? 'Advertencia' : 'Info'}: ${w.message}`,
  ),
  process: c.process_issues.map(
    (i) => `${i.level === 'warning' ? 'Advertencia' : 'Info'}: ${i.message}`,
  ),
  origin_notes: c.notes,
});

const SearchInput = z.object({
  q: z.string().max(100).optional(),
  family: z.string().max(100).optional(),
  application: z.string().max(300).optional(),
  payload_min_kg: z.number().nonnegative().optional(),
  payload_max_kg: z.number().nonnegative().optional(),
  reach_min_mm: z.number().nonnegative().optional(),
  reach_max_mm: z.number().nonnegative().optional(),
});
const SlugInput = z.object({ slug: z.string().min(1).max(120) });
const ComponentsInput = z.object({ category: z.string().max(60).optional() });
const ProposeInput = z.object({
  summary: z.string().trim().min(1).max(1000),
  assumptions: z.array(z.string().max(500)).max(50).default([]),
  scene: z.unknown(),
});
const ValidateInput = z.object({ scene: z.unknown() });
const RunInput = z.object({
  proposal_id: z.string().min(1).max(64),
  demand_per_hour: z.number().positive().max(1e7).optional(),
});

const inputError = (err: z.ZodError) =>
  fail(err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`));

export function toolExecutor(ctx: ToolContext) {
  const catalog = new CatalogCache(ctx.repo);

  const handlers: Record<string, (input: unknown) => Promise<ToolOutcome>> = {
    async search_catalog(input) {
      const p = SearchInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const query = CatalogQuery.parse({
        q: p.data.q,
        family: p.data.family,
        application: p.data.application,
        payload_min: p.data.payload_min_kg,
        payload_max: p.data.payload_max_kg,
        reach_min: p.data.reach_min_mm,
        reach_max: p.data.reach_max_mm,
      });
      const all = await catalog.listVariants();
      const found = filterVariants(all, query);
      return ok({ total: found.length, variants: found.slice(0, 40) });
    },

    async get_variant(input) {
      const p = SlugInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const d = await catalog.detail(p.data.slug);
      if (!d) return fail([`La variante "${p.data.slug}" no existe en el catálogo.`]);
      return ok({
        variant: d.variant,
        robot: d.robot,
        specs: d.specs,
        published_cycles_s: publishedCycleOptions(d),
        documents: d.documents.map((x) => ({
          title: x.title,
          kind: x.kind,
          doc_id: x.doc_id,
          revision: x.revision,
          url: x.url,
        })),
        siblings: d.siblings,
      });
    },

    async list_components(input) {
      const p = ComponentsInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const all = await catalog.listComponents();
      return ok({
        components: p.data.category ? all.filter((c) => c.category === p.data.category) : all,
      });
    },

    async validate_scene(input) {
      const p = ValidateInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const c = await checkScene(p.data.scene, catalog);
      if (!c.ok) return fail(c.errors);
      return ok({ ok: true, ...validationReport(c) }, 'escena válida');
    },

    async propose_scene(input) {
      const p = ProposeInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const c = await checkScene(p.data.scene, catalog);
      if (!c.ok) return fail(c.errors);
      const proposal: AiProposal = {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        summary: p.data.summary,
        scene: c.scene,
        warnings: c.warnings,
        process_issues: c.process_issues,
        assumptions: [...p.data.assumptions, ...c.notes],
        robots: c.robots,
        components: c.components,
        estimate: null,
        status: 'pending',
      };
      ctx.proposals.push(proposal);
      return ok({ ok: true, proposal_id: proposal.id, ...validationReport(c) }, proposal.id);
    },

    async run_simulation(input) {
      const p = RunInput.safeParse(input);
      if (!p.success) return inputError(p.error);
      const sim = ctx.sim;
      if (!sim) return fail(['El motor de simulación no está configurado.']);
      const proposal = ctx.proposals.find((x) => x.id === p.data.proposal_id);
      if (!proposal) return fail([`No hay ninguna propuesta con id ${p.data.proposal_id}.`]);
      const layout = await ctx.repo.getLayout(ctx.projectId);
      if (!layout)
        return ok({
          estimate: null,
          reason: 'sin estimación: el proyecto no tiene layout guardado',
        });
      const { model } = compileProcess(proposal.scene);
      if (!model) return fail(['La propuesta no tiene un modelo de proceso simulable.']);

      const q = ctx.ai.quickRun;
      const horizon_h = Math.min(q.horizonH, sim.maxHorizonH);
      const config = {
        name: 'Asistente: estimación rápida',
        horizon_h,
        warmup_h: horizon_h / 8,
        replications: Math.min(q.replications, sim.maxReplications),
        seed: 1,
        demand_per_hour: p.data.demand_per_hour ?? null,
      };
      const run = await ctx.systemRepo.createRun({
        projectId: ctx.projectId,
        layoutId: layout.id,
        layoutVersion: layout.version,
        userId: ctx.user.id,
        config,
        input: { config, scene: proposal.scene, model },
      });
      try {
        await sim.client.submit({
          run_id: run.id,
          project_id: ctx.projectId,
          model,
          config,
          playback_window_s: sim.playbackWindowS,
          max_events: sim.maxEvents,
          assumptions: modelAssumptions(model),
        });
      } catch (err) {
        await ctx.systemRepo.updateRun(run.id, {
          status: 'failed',
          error: (err as Error).message,
          finished_at: new Date().toISOString(),
        });
        return ok({ estimate: null, reason: `sin estimación: ${(err as Error).message}` });
      }

      const deadline = Date.now() + q.timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, q.pollMs));
        const found = await ctx.repo.getRun(ctx.projectId, run.id);
        if (!found) break;
        if (found.run.status === 'failed' || found.run.status === 'cancelled')
          return ok({ estimate: null, reason: `sin estimación: ${found.run.error ?? 'falló'}` });
        if (found.run.status !== 'succeeded') continue;
        const th = found.metrics.find(
          (m) => m.metric === 'throughput_per_hour' && m.scope === 'line' && m.replication == null,
        );
        const estimate: ProposalEstimate = {
          run_id: run.id,
          replications: config.replications,
          horizon_h,
          throughput_per_hour:
            th?.mean != null
              ? { mean: th.mean, low: th.p5 ?? th.min, high: th.p95 ?? th.max }
              : null,
          bottleneck: found.run.summary?.bottleneck?.name ?? null,
        };
        proposal.estimate = estimate;
        return ok({ estimate, assumptions: found.run.summary?.assumptions ?? [] }, run.id);
      }
      return ok({
        estimate: null,
        reason: `sin estimación: la corrida no terminó en ${Math.round(q.timeoutMs / 1000)} s (sigue en el panel de simulación)`,
      });
    },
  };

  return async (name: string, input: unknown): Promise<ToolOutcome> => {
    const h = handlers[name];
    if (!h) return fail([`Herramienta desconocida: ${name}`]);
    return h(input);
  };
}
