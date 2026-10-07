import {
  RunConfig,
  Uuid,
  compileProcess,
  modelAssumptions,
  parseStoredScene,
  projectAccess,
  type SimRun,
} from '@sim/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { httpError } from '../errors.ts';
import { SimWorkerError } from '../sim.ts';

const IdParams = z.object({ id: Uuid });
const RunParams = z.object({ id: Uuid, runId: Uuid });

const ORPHANED = 'La corrida no terminó a tiempo (el motor pudo reiniciarse). Vuelve a lanzarla.';

// Corridas del motor de línea. Lectura con el JWT del usuario (RLS); la creación y el
// cambio de estado usan la clave secreta tras comprobar los permisos aquí.
export async function runRoutes(app: FastifyInstance) {
  async function projectFor(req: FastifyRequest, id: string) {
    const user = app.requireUser(req);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    // RLS: un proyecto ajeno es indistinguible de uno inexistente.
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    return { user, repo, project };
  }

  /** Marca como fallidas las corridas en curso que superaron el tiempo máximo. */
  async function expire(runs: SimRun[]): Promise<SimRun[]> {
    const sim = app.deps.sim;
    if (!sim) return runs;
    const limit = Date.now() - sim.runTimeoutS * 1000;
    return Promise.all(
      runs.map(async (r) => {
        if ((r.status !== 'queued' && r.status !== 'running') || Date.parse(r.created_at) > limit)
          return r;
        const finished_at = new Date().toISOString();
        await app.deps.systemRepo.updateRun(r.id, {
          status: 'failed',
          error: ORPHANED,
          finished_at,
        });
        return { ...r, status: 'failed' as const, error: ORPHANED, finished_at };
      }),
    );
  }

  app.post('/projects/:id/runs', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { user, repo, project } = await projectFor(req, id);
    const access = projectAccess(project, await repo.listMembers(id), user.id);
    if (access !== 'owner' && access !== 'editor')
      throw httpError(403, 'Solo el propietario y los editores pueden simular');
    const sim = app.deps.sim;
    if (!sim) throw httpError(503, 'El motor de simulación no está configurado (SIM_WORKER_URL).');

    const config = RunConfig.parse(req.body);
    if (config.replications > sim.maxReplications)
      throw httpError(400, `El máximo es ${sim.maxReplications} réplicas por corrida.`);
    if (config.horizon_h > sim.maxHorizonH)
      throw httpError(400, `El horizonte máximo es ${sim.maxHorizonH} h.`);

    const layout = await repo.getLayout(id);
    if (!layout) throw httpError(400, 'Guarda el layout antes de simular.');
    const scene = parseStoredScene(layout.scene);
    const { model, issues } = compileProcess(scene);
    if (!model) {
      return reply.status(400).send({
        error: 'process',
        message: 'El modelo de proceso tiene errores. Corrígelos en el modo Flujo.',
        issues: issues.filter((i) => i.level === 'error'),
      });
    }

    const input = { config, scene, model };
    const run = await app.deps.systemRepo.createRun({
      projectId: id,
      layoutId: layout.id,
      layoutVersion: layout.version,
      userId: user.id,
      config,
      input,
    });
    try {
      await sim.client.submit({
        run_id: run.id,
        project_id: id,
        model,
        config,
        playback_window_s: sim.playbackWindowS,
        max_events: sim.maxEvents,
        assumptions: modelAssumptions(model),
      });
    } catch (err) {
      const message = err instanceof SimWorkerError ? err.message : 'Error al enviar la corrida';
      await app.deps.systemRepo.updateRun(run.id, {
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
      });
      throw httpError(502, message);
    }
    return reply.status(202).send({ run });
  });

  app.get('/projects/:id/runs', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { repo } = await projectFor(req, id);
    return { runs: await expire(await repo.listRuns(id)) };
  });

  app.get('/projects/:id/runs/:runId', async (req) => {
    const { id, runId } = RunParams.parse(req.params);
    const { repo } = await projectFor(req, id);
    const found = await repo.getRun(id, runId);
    if (!found) throw httpError(404, 'Corrida no encontrada');
    const [run] = await expire([found.run]);
    return { run, metrics: found.metrics };
  });

  // Registro de eventos para el reproductor. Se entrega comprimido tal como está guardado.
  app.get('/projects/:id/runs/:runId/events', async (req, reply) => {
    const { id, runId } = RunParams.parse(req.params);
    const { repo } = await projectFor(req, id);
    const found = await repo.getRun(id, runId);
    if (!found?.run.events_path) throw httpError(404, 'La corrida no tiene registro de eventos');
    const data = await app.deps.systemRepo.downloadEvents(found.run.events_path);
    if (!data) throw httpError(404, 'La corrida no tiene registro de eventos');
    return reply
      .header('content-type', 'application/json')
      .header('content-encoding', 'gzip')
      .header('cache-control', 'private, max-age=3600')
      .send(data);
  });
}
