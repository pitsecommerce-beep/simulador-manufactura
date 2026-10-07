import { randomUUID } from 'node:crypto';
import type {
  CatalogVariant,
  MemberRole,
  Project,
  ProjectMember,
  SimMetric,
  SimRequest,
  SimRun,
} from '@sim/domain';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.ts';
import { supabaseTokenVerifier, type AuthUser } from '../src/auth.ts';
import {
  LAYOUT_CONFLICT,
  RepoError,
  type StoredLayout,
  type SystemRepo,
  type UserRepo,
} from '../src/repo.ts';
import { SimWorkerError, type SimSettings } from '../src/sim.ts';

export const SUPABASE_URL = 'https://test-project.supabase.co';
export const JWT_SECRET = 'test-secret-with-at-least-32-characters!!';

export async function signToken(
  sub: string,
  opts: { email?: string; role?: string; expiresIn?: string; issuer?: string } = {},
) {
  return new SignJWT({
    role: opts.role ?? 'authenticated',
    email: opts.email ?? `${sub}@test.local`,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(opts.issuer ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export const CATALOG: CatalogVariant[] = [
  variant('irb-1300-7-1-4', 'IRB 1300-7/1.4', 'IRB 1300', 'Articulated (small)', 7, 1400, null),
  variant('irb-460-110-2-4', 'IRB 460-110/2.4', 'IRB 460', 'Palletizing 4-axis', 110, 2400, null),
  variant('irb-360-1-1130', 'IRB 360-1/1130', 'IRB 360', 'Delta', 1, null, 1130),
  variant('irb-5500-25', 'IRB 5500-25', 'IRB 5500', 'Paint', null, 2975, null),
];

function variant(
  slug: string,
  code: string,
  model: string,
  family: string,
  payload: number | null,
  reach: number | null,
  workspace: number | null,
): CatalogVariant {
  return {
    slug,
    variant_code: code,
    robot_slug: model.toLowerCase().replace(' ', '-'),
    model,
    manufacturer: 'ABB',
    family,
    kinematic_type: family === 'Delta' ? 'delta' : 'serial',
    application: family === 'Palletizing 4-axis' ? 'Paletizado' : 'Manipulación',
    axes_count: null,
    axes_note: null,
    reach_mm: reach,
    workspace_diameter_mm: workspace,
    payload_kg: payload,
  };
}

/** Almacén en memoria que imita las reglas de RLS (probadas por separado en packages/db). */
export function memoryStore() {
  const projects: Project[] = [];
  const members: { project_id: string; user_id: string; role: MemberRole }[] = [];
  const profiles = new Map<string, string>(); // email -> user_id
  const layouts = new Map<string, StoredLayout>(); // project_id -> layout actual
  const runs: SimRun[] = [];
  const metrics: (SimMetric & { run_id: string })[] = [];
  const files = new Map<string, Buffer>();

  const canRead = (p: Project, uid: string) =>
    p.owner_id === uid || members.some((m) => m.project_id === p.id && m.user_id === uid);

  const repoFor = (user: AuthUser): UserRepo => ({
    async listProjects() {
      return projects.filter((p) => canRead(p, user.id));
    },
    async getProject(id) {
      return projects.find((p) => p.id === id && canRead(p, user.id)) ?? null;
    },
    async createProject(input) {
      const now = new Date().toISOString();
      const p: Project = {
        id: randomUUID(),
        owner_id: user.id,
        name: input.name,
        description: input.description ?? null,
        created_at: now,
        updated_at: now,
      };
      projects.push(p);
      return p;
    },
    async listMembers(projectId): Promise<ProjectMember[]> {
      return members
        .filter((m) => m.project_id === projectId)
        .map((m) => ({ user_id: m.user_id, role: m.role, email: null, display_name: null }));
    },
    async findUserIdByEmail(email) {
      return profiles.get(email) ?? null;
    },
    async addMember(projectId, userId, role) {
      members.push({ project_id: projectId, user_id: userId, role });
    },
    async removeMember(projectId, userId) {
      const p = projects.find((x) => x.id === projectId);
      const i = members.findIndex((m) => m.project_id === projectId && m.user_id === userId);
      if (!p || i < 0 || (p.owner_id !== user.id && userId !== user.id)) return false;
      members.splice(i, 1);
      return true;
    },
    async getLayout(projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && canRead(p, user.id) ? (layouts.get(projectId) ?? null) : null;
    },
    async saveLayout(projectId, scene, version) {
      const current = layouts.get(projectId);
      if ((current?.version ?? null) !== version) throw new RepoError(LAYOUT_CONFLICT, 409);
      const saved = {
        id: current?.id ?? randomUUID(),
        version: (version ?? 0) + 1,
        scene,
        updated_at: new Date().toISOString(),
      };
      layouts.set(projectId, saved);
      return saved;
    },
    async listRuns(projectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !canRead(p, user.id)) return [];
      return runs.filter((r) => r.project_id === projectId).reverse();
    },
    async getRun(projectId, runId) {
      const p = projects.find((x) => x.id === projectId);
      const run = runs.find((r) => r.id === runId && r.project_id === projectId);
      if (!p || !canRead(p, user.id) || !run) return null;
      return { run, metrics: metrics.filter((m) => m.run_id === runId) };
    },
    async listCatalogComponents() {
      return [
        {
          slug: 'onrobot-2fg7',
          manufacturer: 'OnRobot',
          model: '2FG7',
          category: 'grippers',
          type: 'electric parallel gripper (2 jaws)',
          specs: { weight_kg: 1.1 },
          notes: null,
        },
        {
          slug: 'sick-wll180t-e632',
          manufacturer: 'SICK',
          model: 'WLL180T',
          category: 'sensors',
          type: null,
          specs: {},
          notes: null,
        },
      ];
    },
    async listCatalogVariants() {
      return CATALOG;
    },
    async getCatalogVariant(slug) {
      const v = CATALOG.find((x) => x.slug === slug);
      if (!v) return null;
      return {
        variant: v,
        robot: {
          slug: v.robot_slug,
          model: v.model,
          manufacturer: v.manufacturer,
          family: v.family,
          application: v.application,
          typical_application: null,
          product_page: null,
          data_status: 'ok',
          notes: null,
        },
        specs: null,
        documents: [],
        siblings: [{ slug: v.slug, variant_code: v.variant_code }],
      };
    },
  });

  const systemRepo = (pingOk: boolean): SystemRepo => ({
    ping: async () => pingOk,
    async createRun(n) {
      const run: SimRun = {
        id: randomUUID(),
        project_id: n.projectId,
        name: n.config.name,
        status: 'queued',
        replications: n.config.replications,
        seed: n.config.seed,
        progress: null,
        error: null,
        summary: null,
        input: n.input,
        layout_version: n.layoutVersion,
        engine_version: null,
        events_path: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      };
      runs.push(run);
      return run;
    },
    async updateRun(runId, fields) {
      const r = runs.find((x) => x.id === runId);
      if (r) Object.assign(r, fields);
    },
    async downloadEvents(path) {
      return files.get(path) ?? null;
    },
  });

  return { projects, members, profiles, layouts, runs, metrics, files, repoFor, systemRepo };
}

/** Motor falso: guarda las peticiones; `fail` simula que no responde. */
export function fakeSim(opts: { fail?: boolean } = {}) {
  const requests: SimRequest[] = [];
  const settings: SimSettings = {
    client: {
      async submit(req) {
        if (opts.fail)
          throw new SimWorkerError('No se pudo contactar al motor de simulación (ECONNREFUSED)');
        requests.push(req);
      },
    },
    maxReplications: 20,
    maxHorizonH: 100,
    runTimeoutS: 600,
    playbackWindowS: 900,
    maxEvents: 1000,
  };
  return { settings, requests };
}

export async function testApp(
  opts: { pingOk?: boolean; rateLimit?: number; sim?: SimSettings | null } = {},
) {
  const store = memoryStore();
  const app = await buildApp({
    verifyToken: supabaseTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    userRepo: store.repoFor,
    systemRepo: store.systemRepo(opts.pingOk ?? true),
    sim: opts.sim ?? null,
    corsOrigins: ['http://localhost:5173'],
    rateLimitPerMinute: opts.rateLimit ?? 1000,
    version: 'test',
  });
  return { app, store };
}
