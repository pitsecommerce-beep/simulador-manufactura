import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fakeSim, signToken, testApp } from './fakes.ts';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const fixed = (value: number) => ({ dist: { type: 'fixed', value }, origin: 'user', note: null });
const base = { elevation: 0, rotation_deg: 0, served_by: null };

/** Banda → mesa (estación manual) → pallet, con flujo válido. */
const scene = (process = true) => ({
  schema: 2,
  objects: [
    {
      ...base,
      id: 'b',
      name: 'Banda',
      kind: 'conveyor',
      position: [0, 0],
      color: '#475569',
      params: { length_mm: 2000, width_mm: 500, height_mm: 800 },
    },
    {
      ...base,
      id: 'm',
      name: 'Mesa',
      kind: 'table',
      position: [2000, 0],
      color: '#94a3b8',
      params: { length_mm: 1200, width_mm: 800, height_mm: 750 },
    },
    {
      ...base,
      id: 'p',
      name: 'Pallet',
      kind: 'pallet',
      position: [4000, 0],
      color: '#c08a4a',
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    },
  ],
  process: process
    ? {
        product: { name: 'Caja', bom: [] },
        nodes: [
          { role: 'source', object_id: 'b', item: 'Caja', interarrival: fixed(10), batch: 1 },
          {
            role: 'station',
            object_id: 'm',
            operation: 'process',
            cycle: fixed(8),
            capacity: 1,
            scrap: null,
            failures: null,
          },
          { role: 'sink', object_id: 'p', units_per_pallet: 40, pallet_change: null },
        ],
        routes: [
          { id: 'r1', from: 'b', to: 'm', item: null, share: null },
          { id: 'r2', from: 'm', to: 'p', item: null, share: null },
        ],
      }
    : { product: { name: 'Caja', bom: [] }, nodes: [], routes: [] },
});
const config = {
  name: 'Turno base',
  horizon_h: 8,
  warmup_h: 1,
  replications: 5,
  seed: 42,
  demand_per_hour: null,
};

async function setup(opts: { sim?: ReturnType<typeof fakeSim> | null; saveScene?: unknown } = {}) {
  const sim = opts.sim === undefined ? fakeSim() : opts.sim;
  const { app, store } = await testApp({ sim: sim?.settings ?? null });
  const owner = randomUUID();
  const viewer = randomUUID();
  const ownerAuth = auth(await signToken(owner));
  const { project } = (
    await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: ownerAuth,
      payload: { name: 'P' },
    })
  ).json();
  store.members.push({ project_id: project.id, user_id: viewer, role: 'viewer' });
  if (opts.saveScene !== null) {
    await app.inject({
      method: 'PUT',
      url: `/v1/projects/${project.id}/layout`,
      headers: ownerAuth,
      payload: { scene: opts.saveScene ?? scene(), version: null },
    });
  }
  const url = `/v1/projects/${project.id}/runs`;
  return {
    app,
    store,
    sim,
    url,
    projectId: project.id,
    ownerAuth,
    viewerAuth: auth(await signToken(viewer)),
  };
}

describe('corridas de simulación', () => {
  it('crea la corrida con la foto de la escena y envía el modelo compilado al motor', async () => {
    const { app, sim, url, ownerAuth, store } = await setup();
    const res = await app.inject({ method: 'POST', url, headers: ownerAuth, payload: config });
    expect(res.statusCode).toBe(202);
    const { run } = res.json();
    expect(run).toMatchObject({
      status: 'queued',
      name: 'Turno base',
      replications: 5,
      seed: 42,
      layout_version: 1,
    });
    expect(store.runs[0]!.input!.scene.objects).toHaveLength(3);
    const req = sim!.requests[0]!;
    expect(req.run_id).toBe(run.id);
    expect(req.model.nodes.map((n) => [n.object_id, n.role, n.name])).toEqual([
      ['b', 'source', 'Banda'],
      ['m', 'station', 'Mesa'],
      ['p', 'sink', 'Pallet'],
    ]);
    expect(req.playback_window_s).toBe(900);
    expect(req.assumptions.join(' ')).toMatch(/Mesa: ciclo 8 s \(supuesto del usuario\)/);
  });

  it('valida permisos: lector 403, extraño 404, sin sesión 401', async () => {
    const { app, url, viewerAuth } = await setup();
    expect(
      (await app.inject({ method: 'POST', url, headers: viewerAuth, payload: config })).statusCode,
    ).toBe(403);
    // El lector sí puede ver las corridas.
    expect((await app.inject({ method: 'GET', url, headers: viewerAuth })).statusCode).toBe(200);
    const stranger = auth(await signToken(randomUUID()));
    expect((await app.inject({ method: 'GET', url, headers: stranger })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('503 si el motor no está configurado', async () => {
    const { app, url, ownerAuth } = await setup({ sim: null });
    const res = await app.inject({ method: 'POST', url, headers: ownerAuth, payload: config });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/SIM_WORKER_URL/);
  });

  it('rechaza configuraciones fuera de límites y modelos inválidos', async () => {
    const { app, url, ownerAuth } = await setup();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url, headers: ownerAuth, payload });
    expect((await post({ ...config, replications: 21 })).json().message).toMatch(/20 réplicas/);
    expect((await post({ ...config, horizon_h: 101 })).json().message).toMatch(/100 h/);
    expect((await post({ ...config, warmup_h: 8 })).statusCode).toBe(400);
    const noProcess = await setup({ saveScene: scene(false) });
    const bad = await noProcess.app.inject({
      method: 'POST',
      url: noProcess.url,
      headers: noProcess.ownerAuth,
      payload: config,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('process');
    expect(bad.json().issues.length).toBeGreaterThan(0);
    const noLayout = await setup({ saveScene: null });
    const nl = await noLayout.app.inject({
      method: 'POST',
      url: noLayout.url,
      headers: noLayout.ownerAuth,
      payload: config,
    });
    expect(nl.json().message).toMatch(/Guarda el layout/);
  });

  it('si el motor no responde, la corrida queda fallida y se informa 502', async () => {
    const { app, url, ownerAuth, store } = await setup({ sim: fakeSim({ fail: true }) });
    const res = await app.inject({ method: 'POST', url, headers: ownerAuth, payload: config });
    expect(res.statusCode).toBe(502);
    expect(store.runs[0]).toMatchObject({ status: 'failed' });
    expect(store.runs[0]!.error).toMatch(/No se pudo contactar/);
  });

  it('lista, devuelve métricas y marca como fallidas las corridas huérfanas', async () => {
    const { app, url, ownerAuth, store } = await setup();
    const { run } = (
      await app.inject({ method: 'POST', url, headers: ownerAuth, payload: config })
    ).json();
    store.metrics.push({
      run_id: run.id,
      metric: 'throughput_per_hour',
      scope: 'line',
      label: 'Línea',
      unit: 'u/h',
      replication: null,
      value: 360,
      min: 350,
      mean: 360,
      max: 370,
      p5: 351,
      p95: 369,
      ci_low: 355,
      ci_high: 365,
    });
    const got = (
      await app.inject({ method: 'GET', url: `${url}/${run.id}`, headers: ownerAuth })
    ).json();
    expect(got.metrics[0].mean).toBe(360);
    // Una corrida en curso desde hace más de SIM_RUN_TIMEOUT_S queda como fallida.
    store.runs[0]!.created_at = new Date(Date.now() - 3600_000).toISOString();
    const list = (await app.inject({ method: 'GET', url, headers: ownerAuth })).json();
    expect(list.runs[0]).toMatchObject({ status: 'failed' });
    expect(list.runs[0].error).toMatch(/no terminó a tiempo/);
    expect(store.runs[0]!.status).toBe('failed');
    expect(
      (await app.inject({ method: 'GET', url: `${url}/${randomUUID()}`, headers: ownerAuth }))
        .statusCode,
    ).toBe(404);
  });

  it('entrega el registro de eventos comprimido', async () => {
    const { app, url, ownerAuth, store } = await setup();
    const { run } = (
      await app.inject({ method: 'POST', url, headers: ownerAuth, payload: config })
    ).json();
    expect(
      (await app.inject({ method: 'GET', url: `${url}/${run.id}/events`, headers: ownerAuth }))
        .statusCode,
    ).toBe(404);
    const log = {
      start_s: 3600,
      end_s: 4500,
      replication: 0,
      truncated: false,
      events: [[3600, 'st', 'm', 'busy']],
    };
    store.files.set(`runs/${run.id}/events.json.gz`, gzipSync(JSON.stringify(log)));
    Object.assign(store.runs[0]!, {
      status: 'succeeded',
      events_path: `runs/${run.id}/events.json.gz`,
    });
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${run.id}/events`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // El navegador descomprime solo por content-encoding; aquí se hace a mano.
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(log);
  });
});
