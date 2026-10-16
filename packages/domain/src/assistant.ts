import { z } from 'zod';
import type { CatalogVariantDetail } from './catalog.ts';
import type { ProcessIssue, ProcessModel, ProcessNode, Timed } from './process.ts';
import { buildRobotModel, type RobotModel } from './robot-model.ts';
import { Scene, type SceneObject } from './scene.ts';
import type { SceneWarning } from './validate.ts';

// Asistente de IA (fase 9, parte C). Contrato entre web y api, y reglas que la api aplica
// a cada propuesta antes de registrarla.

export const MAX_ASSISTANT_MESSAGE = 4000;

export const AssistantRequest = z.object({
  conversation_id: z.uuid().nullable().default(null),
  message: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE),
  /** Escena del editor, aunque no esté guardada. */
  current_scene: Scene,
});
export type AssistantRequest = z.infer<typeof AssistantRequest>;

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'discarded'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const ProposalUpdate = z.object({ status: z.enum(PROPOSAL_STATUSES) });

/** Producción estimada por una corrida rápida del asistente. */
export interface ProposalEstimate {
  run_id: string;
  replications: number;
  horizon_h: number;
  /** Media y rango entre réplicas (p5 a p95, o mínimo a máximo si no hay percentiles). */
  throughput_per_hour: { mean: number; low: number | null; high: number | null } | null;
  bottleneck: string | null;
}

export interface AiProposal {
  id: string;
  created_at: string;
  summary: string;
  scene: Scene;
  warnings: SceneWarning[];
  process_issues: ProcessIssue[];
  assumptions: string[];
  robots: {
    slug: string;
    variant_code: string;
    model: string;
    family: string | null;
    kinematic_type: string | null;
  }[];
  components: { slug: string; model: string; manufacturer: string | null; category: string }[];
  estimate: ProposalEstimate | null;
  status: ProposalStatus;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Propuestas registradas en esta respuesta del asistente. */
  proposal_ids?: string[];
  /** Respuesta de sistema (límite de uso, error del proveedor), no del modelo. */
  notice?: boolean;
}

export interface AssistantConversation {
  id: string;
  project_id: string;
  title: string | null;
  model: string | null;
  transcript: TranscriptEntry[];
  proposals: AiProposal[];
  tokens_in: number;
  tokens_out: number;
  updated_at: string;
}

export interface AssistantReply {
  conversation: AssistantConversation;
  /** Propuestas nuevas de esta respuesta. */
  proposals: AiProposal[];
  /** Límite alcanzado durante la respuesta (la respuesta puede quedar incompleta). */
  limit: AssistantLimit | null;
}

export interface AssistantLimit {
  kind: 'requests' | 'tokens' | 'global_tokens';
  message: string;
  resets_at: string;
}

export interface AssistantStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  limits: { requests_per_day: number; tokens_per_day: number } | null;
}

/** Tiempos de ciclo publicados en la ficha de una variante (s), con su condición. */
export function publishedCycleOptions(detail: CatalogVariantDetail | undefined | null) {
  const out: { value_s: number; note: string; uncertain?: boolean }[] = [];
  for (const c of detail?.specs?.published_cycle_times ?? []) {
    const cond = c.condition ?? 'condición no indicada';
    if (c.value_s != null) out.push({ value_s: c.value_s, note: cond });
    const row = c.table?.[detail!.variant.variant_code];
    row?.forEach((v, i) => {
      if (v != null)
        out.push({
          value_s: v,
          note: `${cond} (columna ${i + 1})`,
          uncertain: !!c.mapping_uncertain,
        });
    });
  }
  return out;
}

/** Modelo paramétrico del robot a partir de su ficha. */
export function robotModelFromDetail(detail: CatalogVariantDetail): RobotModel {
  const s = detail.specs;
  return buildRobotModel({
    kinematic_type: detail.variant.kinematic_type,
    axes_count: s?.axes_count ?? null,
    reach_mm: s?.reach_mm ?? null,
    workspace_diameter_mm: s?.workspace_diameter_mm ?? null,
    payload_kg: s?.payload_kg ?? null,
    axis_limits: s?.axis_limits ?? null,
  });
}

/**
 * Aplica las reglas de origen a una escena propuesta por el asistente:
 * - todo tiempo o tasa que el modelo marque como `user` pasa a `assistant`;
 * - `catalog` solo se acepta en el ciclo de un robot si coincide con un tiempo publicado en
 *   su ficha; si no, pasa a `assistant`.
 * Devuelve la escena corregida y una nota por cada cambio.
 */
export function enforceAssistantOrigins(
  scene: Scene,
  publishedCycles: (objectId: string) => { value_s: number; note: string }[] | undefined,
): { scene: Scene; notes: string[] } {
  const notes: string[] = [];
  const names = new Map(scene.objects.map((o) => [o.id, o.name]));
  const fix = (t: Timed | null, objectId: string, what: string): Timed | null => {
    if (!t) return t;
    if (t.origin === 'catalog') {
      const published = what === 'ciclo' ? publishedCycles(objectId) : undefined;
      const d = t.dist;
      const match = d.type === 'fixed' ? published?.find((p) => p.value_s === d.value) : undefined;
      if (match) return { ...t, note: t.note ?? match.note };
      notes.push(
        `${names.get(objectId) ?? objectId}: el ${what} no coincide con un tiempo publicado en la ficha; queda como supuesto del asistente.`,
      );
      return { ...t, origin: 'assistant' };
    }
    return t.origin === 'assistant' ? t : { ...t, origin: 'assistant' };
  };
  const nodes = scene.process.nodes.map((n): ProcessNode => {
    switch (n.role) {
      case 'source':
        return { ...n, interarrival: fix(n.interarrival, n.object_id, 'tiempo entre llegadas') };
      case 'station':
        return {
          ...n,
          cycle: fix(n.cycle, n.object_id, 'ciclo'),
          scrap: n.scrap ? { ...n.scrap, origin: 'assistant' } : null,
          failures: n.failures ? { ...n.failures, origin: 'assistant' } : null,
        };
      case 'buffer':
        return { ...n, transfer: fix(n.transfer, n.object_id, 'tiempo de recorrido') };
      case 'sink':
        return { ...n, pallet_change: fix(n.pallet_change, n.object_id, 'cambio de pallet') };
    }
  });
  return { scene: { ...scene, process: { ...scene.process, nodes } }, notes };
}

/**
 * Fusiona una propuesta con la escena actual: agrega sus objetos, nodos y rutas. Los ids que
 * ya existen se renombran (también en referencias como `served_by` y `mounted_on`). El
 * producto de la escena actual se conserva salvo que no tenga proceso.
 */
export function mergeScenes(base: Scene, proposal: Scene): Scene {
  const used = new Set(base.objects.map((o) => o.id));
  const usedRoutes = new Set(base.process.routes.map((r) => r.id));
  const rename = new Map<string, string>();
  const fresh = (id: string, taken: Set<string>) => {
    let next = id;
    for (let i = 2; taken.has(next); i++) next = `${id}-${i}`.slice(-64);
    taken.add(next);
    return next;
  };
  for (const o of proposal.objects) rename.set(o.id, fresh(o.id, used));
  const ref = (id: string | null) => (id == null ? null : (rename.get(id) ?? id));

  const objects = proposal.objects.map((o): SceneObject => {
    const moved = { ...o, id: rename.get(o.id)!, served_by: ref(o.served_by) } as SceneObject;
    if (moved.kind === 'gripper')
      return { ...moved, params: { ...moved.params, mounted_on: ref(moved.params.mounted_on) } };
    return moved;
  });
  const process: ProcessModel = {
    product: base.process.nodes.length ? base.process.product : proposal.process.product,
    nodes: [
      ...base.process.nodes,
      ...proposal.process.nodes.map((n) => ({ ...n, object_id: ref(n.object_id)! })),
    ],
    routes: [
      ...base.process.routes,
      ...proposal.process.routes.map((r) => ({
        ...r,
        id: fresh(r.id, usedRoutes),
        from: ref(r.from)!,
        to: ref(r.to)!,
      })),
    ],
  };
  return { schema: 2, objects: [...base.objects, ...objects], process };
}
