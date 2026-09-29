import { z } from 'zod';

export const MEMBER_ROLES = ['viewer', 'editor'] as const;
export const MemberRole = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRole>;

export const ProjectCreate = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  description: z.string().trim().max(5000).optional(),
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;

export const ShareProject = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Correo no válido')),
  role: MemberRole,
});
export type ShareProject = z.infer<typeof ShareProject>;

export const Uuid = z.uuid();

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  user_id: string;
  role: MemberRole;
  email: string | null;
  display_name: string | null;
}

export type ProjectAccess = 'owner' | MemberRole;

export function projectAccess(
  project: Pick<Project, 'owner_id'>,
  members: Pick<ProjectMember, 'user_id' | 'role'>[],
  userId: string,
): ProjectAccess | null {
  if (project.owner_id === userId) return 'owner';
  return members.find((m) => m.user_id === userId)?.role ?? null;
}
