import {
  ProjectCreate,
  SaveLayout,
  ShareProject,
  Uuid,
  emptyScene,
  parseStoredScene,
  projectAccess,
} from '@sim/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../errors.ts';

const IdParams = z.object({ id: Uuid });
const MemberParams = z.object({ id: Uuid, userId: Uuid });

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async (req) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    return { projects: await repo.listProjects() };
  });

  app.post('/projects', async (req, reply) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    const input = ProjectCreate.parse(req.body);
    const project = await repo.createProject(input);
    return reply.status(201).send({ project });
  });

  app.get('/projects/:id', async (req) => {
    const user = app.requireUser(req);
    const { id } = IdParams.parse(req.params);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    // RLS hace que un proyecto ajeno sea indistinguible de uno inexistente.
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    const members = await repo.listMembers(id);
    return { project, members, access: projectAccess(project, members, user.id) };
  });

  app.post('/projects/:id/members', async (req, reply) => {
    const user = app.requireUser(req);
    const { id } = IdParams.parse(req.params);
    const { email, role } = ShareProject.parse(req.body);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    if (project.owner_id !== user.id)
      throw httpError(403, 'Solo el propietario puede compartir el proyecto');
    const target = await repo.findUserIdByEmail(email);
    if (!target) throw httpError(404, 'No hay ningún usuario del equipo con ese correo');
    if (target === user.id) throw httpError(400, 'Ya eres el propietario del proyecto');
    await repo.addMember(id, target, role);
    return reply.status(201).send({ user_id: target, role });
  });

  app.delete('/projects/:id/members/:userId', async (req, reply) => {
    const repo = app.deps.userRepo(app.requireUser(req));
    const { id, userId } = MemberParams.parse(req.params);
    const removed = await repo.removeMember(id, userId);
    if (!removed) throw httpError(404, 'Miembro no encontrado o sin permiso');
    return reply.status(204).send();
  });

  app.get('/projects/:id/layout', async (req) => {
    const user = app.requireUser(req);
    const { id } = IdParams.parse(req.params);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    const layout = await repo.getLayout(id);
    if (!layout) return { version: null, scene: emptyScene(), updated_at: null };
    return {
      version: layout.version,
      scene: parseStoredScene(layout.scene),
      updated_at: layout.updated_at,
    };
  });

  app.put('/projects/:id/layout', async (req) => {
    const user = app.requireUser(req);
    const { id } = IdParams.parse(req.params);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    const access = projectAccess(project, await repo.listMembers(id), user.id);
    if (access !== 'owner' && access !== 'editor')
      throw httpError(403, 'Solo el propietario y los editores pueden guardar el layout');
    const { scene, version } = SaveLayout.parse(req.body);
    const saved = await repo.saveLayout(id, scene, version);
    return {
      version: saved.version,
      scene: parseStoredScene(saved.scene),
      updated_at: saved.updated_at,
    };
  });
}
