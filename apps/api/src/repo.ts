import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CatalogComponent,
  CatalogVariant,
  CatalogVariantDetail,
  MemberRole,
  Project,
  ProjectMember,
  RunConfig,
  Scene,
  SimMetric,
  SimModel,
  SimRun,
} from '@sim/domain';
import type { AuthUser } from './auth.ts';

/**
 * Acceso a datos en nombre de un usuario. La implementación real usa el JWT del usuario,
 * así que Postgres aplica RLS: la API no puede ver más de lo que el usuario puede ver.
 */
export interface UserRepo {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: { name: string; description?: string | undefined }): Promise<Project>;
  listMembers(projectId: string): Promise<ProjectMember[]>;
  findUserIdByEmail(email: string): Promise<string | null>;
  addMember(projectId: string, userId: string, role: MemberRole): Promise<void>;
  removeMember(projectId: string, userId: string): Promise<boolean>;
  listCatalogVariants(): Promise<CatalogVariant[]>;
  getCatalogVariant(slug: string): Promise<CatalogVariantDetail | null>;
  listCatalogComponents(): Promise<CatalogComponent[]>;
  /** Layout actual del proyecto (escena sin validar) o null si aún no existe. */
  getLayout(projectId: string): Promise<StoredLayout | null>;
  /**
   * Guarda la escena en el layout actual si su versión sigue siendo `version` (o lo crea si
   * `version` es null). Lanza RepoError 409 si otro usuario guardó antes.
   */
  saveLayout(projectId: string, scene: Scene, version: number | null): Promise<StoredLayout>;
  /** Corridas del proyecto (sin la foto de entrada completa), más recientes primero. */
  listRuns(projectId: string): Promise<SimRun[]>;
  /** Corrida con sus métricas, o null si no existe o el usuario no la puede ver. */
  getRun(projectId: string, runId: string): Promise<{ run: SimRun; metrics: SimMetric[] } | null>;
}

export interface StoredLayout {
  id: string;
  version: number;
  scene: unknown;
  updated_at: string;
}

export const LAYOUT_CONFLICT = 'Otro usuario guardó el layout. Recarga para ver sus cambios.';

export interface NewRun {
  projectId: string;
  layoutId: string;
  layoutVersion: number;
  userId: string;
  config: RunConfig;
  input: { config: RunConfig; scene: Scene; model: SimModel };
}

/** Operaciones con la clave secreta. Las rutas comprueban antes los permisos del usuario. */
export interface SystemRepo {
  /** Comprueba conectividad con Supabase usando la clave secreta. */
  ping(): Promise<boolean>;
  /** Crea el escenario y la corrida en estado `queued`. Devuelve la corrida. */
  createRun(input: NewRun): Promise<SimRun>;
  updateRun(
    runId: string,
    fields: Partial<Pick<SimRun, 'status' | 'error' | 'finished_at'>>,
  ): Promise<void>;
  /** Registro de eventos comprimido (gzip) de Storage, o null si no existe. */
  downloadEvents(path: string): Promise<Buffer | null>;
}

const RUN_COLUMNS =
  'id, project_id, name, status, replications, seed, progress, error, summary, layout_version, engine_version, events_path, created_at, started_at, finished_at';

export class RepoError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function fail(error: { message: string; code?: string } | null): never {
  if (error?.code === '42501' || /row-level security/.test(error?.message ?? '')) {
    throw new RepoError('No tienes permiso para esta acción', 403);
  }
  if (error?.code === '23505') throw new RepoError('El registro ya existe', 409);
  throw new RepoError(error?.message ?? 'Error de base de datos', 500);
}

// PostgREST devuelve una relación 1:1 como objeto, pero lo tratamos con tolerancia.
const one = <T>(x: T | T[] | null | undefined): T | null =>
  Array.isArray(x) ? (x[0] ?? null) : (x ?? null);

type Row = Record<string, unknown>;
const VARIANT_SELECT =
  'slug, variant_code, robots!inner(slug, model, manufacturer, family, kinematic_type, application), ' +
  'robot_specs(axes_count, axes_note, reach_mm, workspace_diameter_mm, payload_kg)';

function toVariant(row: Row): CatalogVariant {
  const r = one(row.robots as Row | Row[])!;
  const s = one(row.robot_specs as Row | Row[]);
  return {
    slug: row.slug as string,
    variant_code: row.variant_code as string,
    robot_slug: r.slug as string,
    model: r.model as string,
    manufacturer: r.manufacturer as string,
    family: (r.family as string | null) ?? null,
    kinematic_type: (r.kinematic_type as CatalogVariant['kinematic_type']) ?? null,
    application: (r.application as string | null) ?? null,
    axes_count: (s?.axes_count as number | null) ?? null,
    axes_note: (s?.axes_note as string | null) ?? null,
    reach_mm: (s?.reach_mm as number | null) ?? null,
    workspace_diameter_mm: (s?.workspace_diameter_mm as number | null) ?? null,
    payload_kg: (s?.payload_kg as number | null) ?? null,
  };
}

export function supabaseUserRepo(url: string, publishableKey: string, user: AuthUser): UserRepo {
  const sb: SupabaseClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });

  return {
    async listProjects() {
      const { data, error } = await sb
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) fail(error);
      return data as Project[];
    },
    async getProject(id) {
      const { data, error } = await sb.from('projects').select('*').eq('id', id).maybeSingle();
      if (error) fail(error);
      return (data as Project | null) ?? null;
    },
    async createProject(input) {
      const { data, error } = await sb
        .from('projects')
        .insert({ name: input.name, description: input.description ?? null, owner_id: user.id })
        .select('*')
        .single();
      if (error) fail(error);
      return data as Project;
    },
    async listMembers(projectId) {
      const { data, error } = await sb
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', projectId);
      if (error) fail(error);
      const ids = (data ?? []).map((m) => m.user_id as string);
      if (ids.length === 0) return [];
      const { data: profiles, error: pErr } = await sb
        .from('profiles')
        .select('user_id, email, display_name')
        .in('user_id', ids);
      if (pErr) fail(pErr);
      const byId = new Map((profiles ?? []).map((p) => [p.user_id as string, p]));
      return (data ?? []).map((m) => ({
        user_id: m.user_id as string,
        role: m.role as MemberRole,
        email: (byId.get(m.user_id)?.email as string | undefined) ?? null,
        display_name: (byId.get(m.user_id)?.display_name as string | undefined) ?? null,
      }));
    },
    async findUserIdByEmail(email) {
      const { data, error } = await sb
        .from('profiles')
        .select('user_id')
        .ilike('email', email)
        .maybeSingle();
      if (error) fail(error);
      return (data?.user_id as string | undefined) ?? null;
    },
    async addMember(projectId, userId, role) {
      const { error } = await sb
        .from('project_members')
        .upsert({ project_id: projectId, user_id: userId, role, invited_by: user.id });
      if (error) fail(error);
    },
    async removeMember(projectId, userId) {
      const { data, error } = await sb
        .from('project_members')
        .delete()
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .select('user_id');
      if (error) fail(error);
      return (data ?? []).length > 0;
    },
    async listCatalogVariants() {
      const { data, error } = await sb.from('robot_variants').select(VARIANT_SELECT);
      if (error) fail(error);
      return (data as unknown as Row[])
        .map(toVariant)
        .sort((a, b) => a.model.localeCompare(b.model, 'es') || a.slug.localeCompare(b.slug));
    },
    async getCatalogVariant(slug) {
      const { data, error } = await sb
        .from('robot_variants')
        .select(
          'slug, variant_code, robot_id, robots!inner(*), robot_specs(axes_count, axes_note, reach_mm, ' +
            'workspace_diameter_mm, payload_kg, payload_note, armload_kg, weight_kg, repeatability_mm, ' +
            'repeatability, mounting_allowed, ip_rating, controller, axis_limits, published_cycle_times, ' +
            'max_tcp_speed_m_s, extra, notes, provenance)',
        )
        .eq('slug', slug)
        .maybeSingle();
      if (error) fail(error);
      if (!data) return null;
      const row = data as unknown as Row;
      const robot = one(row.robots as Row | Row[])!;
      const [docs, siblings] = await Promise.all([
        sb
          .from('robot_documents')
          .select(
            'path, kind, doc_id, revision, doc_date, title, url, library_page, accessed_at, license_terms',
          )
          .eq('robot_id', row.robot_id as string)
          .order('kind'),
        sb
          .from('robot_variants')
          .select('slug, variant_code')
          .eq('robot_id', row.robot_id as string)
          .order('variant_code'),
      ]);
      if (docs.error) fail(docs.error);
      if (siblings.error) fail(siblings.error);
      return {
        variant: toVariant(row),
        robot: {
          slug: robot.slug as string,
          model: robot.model as string,
          manufacturer: robot.manufacturer as string,
          family: (robot.family as string | null) ?? null,
          application: (robot.application as string | null) ?? null,
          typical_application: (robot.typical_application as string | null) ?? null,
          product_page: (robot.product_page as string | null) ?? null,
          data_status: (robot.data_status as 'ok' | 'partial' | null) ?? null,
          notes: (robot.notes as string[] | null) ?? null,
        },
        specs: one(row.robot_specs as Row | Row[]) as CatalogVariantDetail['specs'],
        documents: (docs.data ?? []) as CatalogVariantDetail['documents'],
        siblings: (siblings.data ?? []) as CatalogVariantDetail['siblings'],
      };
    },
    async listCatalogComponents() {
      const { data, error } = await sb
        .from('components')
        .select('slug, manufacturer, model, category, type, notes, component_specs(specs)')
        .order('category')
        .order('model');
      if (error) fail(error);
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        slug: r.slug as string,
        manufacturer: (r.manufacturer as string | null) ?? null,
        model: r.model as string,
        category: r.category as string,
        type: (r.type as string | null) ?? null,
        notes: (r.notes as string[] | null) ?? null,
        specs: (one(r.component_specs as Row | Row[])?.specs as Record<string, unknown>) ?? {},
      }));
    },
    async getLayout(projectId) {
      const { data, error } = await sb
        .from('layouts')
        .select('id, version, scene, updated_at')
        .eq('project_id', projectId)
        .eq('is_current', true)
        .maybeSingle();
      if (error) fail(error);
      return (data as StoredLayout | null) ?? null;
    },
    async saveLayout(projectId, scene, version) {
      if (version == null) {
        const { data, error } = await sb
          .from('layouts')
          .insert({ project_id: projectId, version: 1, scene, is_current: true, name: 'Principal' })
          .select('id, version, scene, updated_at')
          .single();
        if (error?.code === '23505') throw new RepoError(LAYOUT_CONFLICT, 409);
        if (error) fail(error);
        return data as StoredLayout;
      }
      const { data, error } = await sb
        .from('layouts')
        .update({ scene, version: version + 1 })
        .eq('project_id', projectId)
        .eq('is_current', true)
        .eq('version', version)
        .select('id, version, scene, updated_at');
      if (error) fail(error);
      const row = (data as StoredLayout[] | null)?.[0];
      if (!row) throw new RepoError(LAYOUT_CONFLICT, 409);
      return row;
    },
    async listRuns(projectId) {
      const { data, error } = await sb
        .from('simulation_runs')
        .select(`${RUN_COLUMNS}, config:input->config`)
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) fail(error);
      return ((data ?? []) as unknown as (SimRun & { config: RunConfig | null })[]).map(
        ({ config, ...r }) => ({ ...r, input: config ? ({ config } as SimRun['input']) : null }),
      );
    },
    async getRun(projectId, runId) {
      const { data, error } = await sb
        .from('simulation_runs')
        .select(`${RUN_COLUMNS}, input`)
        .eq('project_id', projectId)
        .eq('id', runId)
        .maybeSingle();
      if (error) fail(error);
      if (!data) return null;
      const { data: metrics, error: mErr } = await sb
        .from('simulation_metrics')
        .select(
          'metric, scope, label, unit, replication, value, min, mean, max, p5, p95, ci_low, ci_high',
        )
        .eq('run_id', runId)
        .order('metric');
      if (mErr) fail(mErr);
      return { run: data as unknown as SimRun, metrics: (metrics ?? []) as SimMetric[] };
    },
  };
}

export function supabaseSystemRepo(url: string, secretKey: string): SystemRepo {
  const sb = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async ping() {
      const { error } = await sb.from('object_types').select('id', { head: true, count: 'exact' });
      return !error;
    },
    async createRun(n) {
      const { data: scenario, error: sErr } = await sb
        .from('scenarios')
        .insert({
          project_id: n.projectId,
          layout_id: n.layoutId,
          name: n.config.name,
          config: n.config,
        })
        .select('id')
        .single();
      if (sErr) fail(sErr);
      const { data, error } = await sb
        .from('simulation_runs')
        .insert({
          project_id: n.projectId,
          scenario_id: scenario.id,
          name: n.config.name,
          status: 'queued',
          replications: n.config.replications,
          seed: n.config.seed,
          input: n.input,
          layout_version: n.layoutVersion,
          created_by: n.userId,
        })
        .select(RUN_COLUMNS)
        .single();
      if (error) fail(error);
      return { ...(data as unknown as SimRun), input: n.input };
    },
    async updateRun(runId, fields) {
      const { error } = await sb.from('simulation_runs').update(fields).eq('id', runId);
      if (error) fail(error);
    },
    async downloadEvents(path) {
      const { data, error } = await sb.storage.from('sim-artifacts').download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
  };
}
