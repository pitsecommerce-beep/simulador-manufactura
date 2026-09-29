import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MemberRole, Project, ProjectMember } from '@sim/domain';
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
}

export interface SystemRepo {
  /** Comprueba conectividad con Supabase usando la clave secreta. */
  ping(): Promise<boolean>;
}

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

export function supabaseUserRepo(url: string, publishableKey: string, user: AuthUser): UserRepo {
  const sb: SupabaseClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });

  return {
    async listProjects() {
      const { data, error } = await sb.from('projects').select('*').order('updated_at', { ascending: false });
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
      const { data, error } = await sb.from('profiles').select('user_id').ilike('email', email).maybeSingle();
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
  };
}

export function supabaseSystemRepo(url: string, secretKey: string): SystemRepo {
  const sb = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async ping() {
      const { error } = await sb.from('object_types').select('id', { head: true, count: 'exact' });
      return !error;
    },
  };
}
