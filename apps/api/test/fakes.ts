import { randomUUID } from 'node:crypto';
import type { MemberRole, Project, ProjectMember } from '@sim/domain';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.ts';
import { supabaseTokenVerifier, type AuthUser } from '../src/auth.ts';
import type { UserRepo } from '../src/repo.ts';

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

/** Almacén en memoria que imita las reglas de RLS (probadas por separado en packages/db). */
export function memoryStore() {
  const projects: Project[] = [];
  const members: { project_id: string; user_id: string; role: MemberRole }[] = [];
  const profiles = new Map<string, string>(); // email -> user_id

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
  });

  return { projects, members, profiles, repoFor };
}

export async function testApp(opts: { pingOk?: boolean; rateLimit?: number } = {}) {
  const store = memoryStore();
  const app = await buildApp({
    verifyToken: supabaseTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    userRepo: store.repoFor,
    systemRepo: { ping: async () => opts.pingOk ?? true },
    corsOrigins: ['http://localhost:5173'],
    rateLimitPerMinute: opts.rateLimit ?? 1000,
    version: 'test',
  });
  return { app, store };
}
