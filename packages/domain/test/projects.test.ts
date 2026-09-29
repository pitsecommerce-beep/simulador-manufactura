import { describe, expect, it } from 'vitest';
import { ProjectCreate, ShareProject, projectAccess } from '../src/index.ts';

describe('ProjectCreate', () => {
  it('recorta espacios y exige nombre', () => {
    expect(ProjectCreate.parse({ name: '  Línea 1 ' })).toEqual({ name: 'Línea 1' });
    expect(ProjectCreate.safeParse({ name: '   ' }).success).toBe(false);
    expect(ProjectCreate.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('ShareProject', () => {
  it('normaliza el correo y valida el rol', () => {
    expect(ShareProject.parse({ email: ' Ana@Ejemplo.MX ', role: 'editor' })).toEqual({
      email: 'ana@ejemplo.mx',
      role: 'editor',
    });
    expect(ShareProject.safeParse({ email: 'no-es-correo', role: 'editor' }).success).toBe(false);
    expect(ShareProject.safeParse({ email: 'a@b.mx', role: 'owner' }).success).toBe(false);
  });
});

describe('projectAccess', () => {
  const project = { owner_id: 'u1' };
  const members = [
    { user_id: 'u2', role: 'editor' as const },
    { user_id: 'u3', role: 'viewer' as const },
  ];
  it('distingue propietario, editor, lector y extraño', () => {
    expect(projectAccess(project, members, 'u1')).toBe('owner');
    expect(projectAccess(project, members, 'u2')).toBe('editor');
    expect(projectAccess(project, members, 'u3')).toBe('viewer');
    expect(projectAccess(project, members, 'u4')).toBeNull();
  });
});
