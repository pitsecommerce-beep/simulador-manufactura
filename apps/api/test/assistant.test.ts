import { randomUUID } from 'node:crypto';
import type { AiProposal, AssistantReply, SimMetric } from '@sim/domain';
import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../src/ai/provider.ts';
import type { SimSettings } from '../src/sim.ts';
import { aiSettings, fakeProvider, signToken, testApp, type ScriptedTurn } from './fakes.ts';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const fixed = (value: number, origin = 'user') => ({
  dist: { type: 'fixed', value },
  origin,
  note: null,
});
const base = { elevation: 0, rotation_deg: 0, served_by: null };

/** Robot IRB 1300 (alcance 1400 mm) que toma de una banda y deja en un pallet. */
const cell = (slug = 'irb-1300-7-1-4') => ({
  schema: 2,
  objects: [
    {
      ...base,
      id: 'r',
      name: 'Robot',
      kind: 'robot',
      position: [0, 0],
      color: '#f97316',
      params: { variant_slug: slug },
    },
    {
      ...base,
      id: 'b',
      name: 'Banda',
      kind: 'conveyor',
      position: [0, 900],
      color: '#475569',
      served_by: 'r',
      params: { length_mm: 1200, width_mm: 400, height_mm: 800 },
    },
    {
      ...base,
      id: 'p',
      name: 'Pallet',
      kind: 'pallet',
      position: [0, -1000],
      color: '#c08a4a',
      served_by: 'r',
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    },
  ],
  process: {
    product: { name: 'Caja', bom: [] },
    nodes: [
      { role: 'source', object_id: 'b', item: 'Caja', interarrival: fixed(10), batch: 1 },
      {
        role: 'station',
        object_id: 'r',
        operation: 'process',
        cycle: fixed(6),
        capacity: 1,
        scrap: null,
        failures: null,
      },
      { role: 'sink', object_id: 'p', units_per_pallet: 40, pallet_change: null },
    ],
    routes: [
      { id: 'r1', from: 'b', to: 'r', item: null, share: null },
      { id: 'r2', from: 'r', to: 'p', item: null, share: null },
    ],
  },
});
const empty = {
  schema: 2,
  objects: [],
  process: { product: { name: 'Producto', bom: [] }, nodes: [], routes: [] },
};
const propose = (scene: unknown = cell()) => ({
  name: 'propose_scene',
  input: { summary: 'Celda de paletizado', assumptions: ['Banda de 1.2 m'], scene },
});

async function setup(
  script: ScriptedTurn[],
  opts: { ai?: Partial<Parameters<typeof aiSettings>[1]>; sim?: SimSettings | null } = {},
) {
  const fake = fakeProvider(script);
  const { app, store } = await testApp({
    ai: aiSettings(fake.provider, opts.ai),
    sim: opts.sim ?? null,
  });
  const owner = randomUUID();
  const editor = randomUUID();
  const viewer = randomUUID();
  const ownerAuth = auth(await signToken(owner));
  const { project } = (
    await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: ownerAuth,
      payload: { name: 'Línea' },
    })
  ).json();
  store.members.push(
    { project_id: project.id, user_id: editor, role: 'editor' },
    { project_id: project.id, user_id: viewer, role: 'viewer' },
  );
  const ask = (
    message: string,
    headers = ownerAuth,
    conversation_id: string | null = null,
    current_scene: unknown = empty,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/assistant`,
      headers,
      payload: { conversation_id, message, current_scene },
    });
  return {
    app,
    store,
    fake,
    projectId: project.id as string,
    owner,
    ownerAuth,
    editorAuth: auth(await signToken(editor)),
    viewerAuth: auth(await signToken(viewer)),
    strangerAuth: auth(await signToken(randomUUID())),
    ask,
  };
}

describe('asistente: configuración y permisos', () => {
  it('sin AI_MODEL responde "no configurado"', async () => {
    const { app } = await testApp();
    const token = auth(await signToken(randomUUID()));
    const status = await app.inject({ method: 'GET', url: '/v1/assistant/status', headers: token });
    expect(status.json()).toMatchObject({ configured: false, model: null });
    const { project } = (
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: token,
        payload: { name: 'X' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/assistant`,
      headers: token,
      payload: { conversation_id: null, message: 'hola', current_scene: empty },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/no está configurado.*AI_MODEL/);
  });

  it('informa modelo y límites cuando está configurado', async () => {
    const { app, ownerAuth } = await setup([]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/assistant/status',
      headers: ownerAuth,
    });
    expect(res.json()).toEqual({
      configured: true,
      provider: 'fake',
      model: 'fake-model',
      limits: { requests_per_day: 30, tokens_per_day: 1_000_000 },
    });
  });

  it('el lector recibe 403 y un extraño 404, sin llamar al modelo ni contar uso', async () => {
    const { ask, viewerAuth, strangerAuth, fake, store } = await setup([{ text: 'hola' }]);
    expect((await ask('hola', viewerAuth)).statusCode).toBe(403);
    expect((await ask('hola', strangerAuth)).statusCode).toBe(404);
    expect(fake.requests).toHaveLength(0);
    expect(store.usage.size).toBe(0);
  });
});

describe('asistente: propuestas', () => {
  it('busca en el catálogo, corrige un slug inexistente y registra la propuesta', async () => {
    const { ask, fake, store } = await setup([
      { text: 'Busco robots.', calls: [{ name: 'search_catalog', input: { q: 'IRB 1300' } }] },
      { calls: [propose(cell('irb-9999-no-existe'))] },
      { calls: [propose()] },
      { text: 'Propuse una celda con un IRB 1300. Supuse una banda de 1.2 m.' },
    ]);
    const res = await ask('Diseña una celda de paletizado', undefined, null, cell());
    expect(res.statusCode).toBe(200);
    const body = res.json() as AssistantReply;

    const results = fake.toolResults();
    expect(results[0]).toMatchObject({ is_error: false, content: { total: 1 } });
    expect((results[0]!.content as { variants: { slug: string }[] }).variants[0]!.slug).toBe(
      'irb-1300-7-1-4',
    );
    expect(results[1]).toMatchObject({ is_error: true });
    expect(JSON.stringify(results[1]!.content)).toMatch(/irb-9999-no-existe.*no existe/);
    expect(results[2]).toMatchObject({ is_error: false, content: { ok: true } });

    expect(body.proposals).toHaveLength(1);
    const p = body.proposals[0]!;
    expect(results[2]!.content).toMatchObject({ proposal_id: p.id });
    expect(p).toMatchObject({
      summary: 'Celda de paletizado',
      status: 'pending',
      estimate: null,
      robots: [{ slug: 'irb-1300-7-1-4', variant_code: 'IRB 1300-7/1.4' }],
    });
    // Alcance validado contra la ficha: nada fuera de alcance ni encimado.
    expect(p.warnings.filter((w) => w.level === 'warning')).toEqual([]);
    // Los tiempos que propone el asistente quedan como supuestos del asistente.
    const origins = p.scene.process.nodes.flatMap((n) =>
      n.role === 'source'
        ? [n.interarrival?.origin]
        : n.role === 'station'
          ? [n.cycle?.origin]
          : [],
    );
    expect(origins).toEqual(['assistant', 'assistant']);

    expect(body.conversation.transcript).toEqual([
      expect.objectContaining({ role: 'user', text: 'Diseña una celda de paletizado' }),
      expect.objectContaining({
        role: 'assistant',
        text: 'Busco robots.\n\nPropuse una celda con un IRB 1300. Supuse una banda de 1.2 m.',
        proposal_ids: [p.id],
      }),
    ]);
    // La escena del editor viaja como contexto en el mensaje del usuario.
    const first = fake.requests[0]!.history[0] as { text: string };
    expect(first.text).toMatch(/<escena_actual>\n\{"schema":2/);
    expect(fake.requests[0]!.tools.map((t) => [t.name, t.strict])).toEqual([
      ['search_catalog', true],
      ['get_variant', true],
      ['list_components', true],
      ['propose_scene', false],
      ['validate_scene', false],
    ]);

    // Conversación guardada con uso y registro de herramientas; nada se escribió en layouts.
    expect(store.conversations).toHaveLength(1);
    const conv = store.conversations[0]!;
    expect(conv.tool_calls.map((t) => [t.name, t.ok])).toEqual([
      ['search_catalog', true],
      ['propose_scene', false],
      ['propose_scene', true],
    ]);
    expect(conv.messages).toHaveLength(8);
    expect(conv).toMatchObject({ tokens_in: 400, tokens_out: 80, model: 'fake-model' });
    expect([...store.usage.values()]).toEqual([{ requests: 1, tokens: 480 }]);
    expect(store.layoutWrites).toEqual([]);
    expect(store.layouts.size).toBe(0);
  });

  it('rechaza escenas inválidas, flujos con errores y componentes inexistentes', async () => {
    const bad = cell();
    const pallet = bad.objects[2]!;
    const noHeight = {
      ...bad,
      objects: [
        bad.objects[0],
        bad.objects[1],
        { ...pallet, params: { preset: 'gma', length_mm: 1219, width_mm: 1016 } },
      ],
    };
    const toSource = {
      ...bad,
      process: {
        ...bad.process,
        routes: [...bad.process.routes, { id: 'r3', from: 'p', to: 'b', item: null, share: null }],
      },
    };
    const withGripper = {
      ...bad,
      objects: [
        ...bad.objects,
        {
          ...base,
          id: 'g',
          name: 'Gripper',
          kind: 'gripper',
          position: [0, 0],
          color: '#64748b',
          params: { component_slug: 'gripper-inventado', mounted_on: 'r' },
        },
      ],
    };
    const { ask, fake } = await setup([
      { calls: [propose(noHeight)] },
      { calls: [propose(toSource)] },
      { calls: [propose(withGripper), { name: 'validate_scene', input: { scene: cell() } }] },
      { text: 'No pude.' },
    ]);
    const res = await ask('Propón algo');
    expect(res.json().proposals).toEqual([]);
    const [r1, r2, r3, r4] = fake.toolResults();
    expect(JSON.stringify(r1!.content)).toMatch(/scene\.objects\.2\.params\.height_mm/);
    expect(JSON.stringify(r2!.content)).toMatch(/Flujo: .*fuente no puede recibir/);
    expect(JSON.stringify(r3!.content)).toMatch(/gripper-inventado.*no existe/);
    expect([r1, r2, r3].every((r) => r!.is_error)).toBe(true);
    expect(r4).toMatchObject({ is_error: false, content: { ok: true } });
  });

  it('advierte alcance y colisión, y marca como supuesto un ciclo "de ficha" no publicado', async () => {
    const far = cell('irb-360-1-1130');
    far.objects[0] = { ...far.objects[0]!, elevation: 1500 };
    // Pallet fuera del radio de trabajo (565 mm) y banda encima del pallet.
    far.objects[2] = { ...far.objects[2]!, position: [0, -3000] };
    far.objects[1] = { ...far.objects[1]!, position: [0, -2800] };
    far.process.nodes[1] = { ...far.process.nodes[1]!, cycle: fixed(0.5, 'catalog') } as never;
    const { ask } = await setup([{ calls: [propose(far)] }, { text: 'Listo.' }]);
    const p = (await ask('Usa un delta')).json().proposals[0] as AiProposal;
    const kinds = p.warnings.filter((w) => w.level === 'warning').map((w) => w.kind);
    expect(kinds).toEqual(expect.arrayContaining(['reach', 'collision']));
    const st = p.scene.process.nodes[1]!;
    expect(st.role === 'station' && st.cycle?.origin).toBe('assistant');
    expect(p.assumptions.join(' ')).toMatch(/no coincide con un tiempo publicado/);
  });

  it('acepta un ciclo de ficha publicado y conserva su condición', async () => {
    const delta = cell('irb-360-1-1130');
    delta.objects[0] = { ...delta.objects[0]!, elevation: 1500 };
    delta.objects[1] = { ...delta.objects[1]!, position: [0, 300] };
    delta.objects[2] = {
      ...delta.objects[2]!,
      position: [0, -300],
      params: { preset: 'custom', length_mm: 300, width_mm: 200, height_mm: 144 },
    } as never;
    delta.process.nodes[1] = { ...delta.process.nodes[1]!, cycle: fixed(0.36, 'catalog') } as never;
    const { ask } = await setup([{ calls: [propose(delta)] }, { text: 'Listo.' }]);
    const p = (await ask('Usa un delta')).json().proposals[0] as AiProposal;
    const st = p.scene.process.nodes[1]!;
    expect(st.role === 'station' && st.cycle).toMatchObject({
      origin: 'catalog',
      note: 'ciclo 25-305-25 mm, 0.1 kg',
    });
  });
});

describe('asistente: conversaciones', () => {
  it('continúa la conversación reenviando el historial sin cambios', async () => {
    const { ask, fake, store, editorAuth, app, projectId, ownerAuth, viewerAuth } = await setup([
      { calls: [propose()] },
      { text: 'Primera propuesta.' },
      { text: 'Claro, agrego otra banda en la siguiente.' },
    ]);
    const first = (await ask('Primera')).json() as AssistantReply;
    const stored = [...store.conversations[0]!.messages];
    const second = await ask('Agrega otra banda', undefined, first.conversation.id, cell());
    expect(second.statusCode).toBe(200);
    // El modelo recibe exactamente los mensajes guardados, más el nuevo turno del usuario.
    const history = fake.requests[2]!.history;
    expect(history.slice(0, stored.length).map((m) => JSON.stringify(m))).toEqual(stored);
    expect(store.conversations[0]!.messages.slice(0, stored.length)).toEqual(stored);
    expect(history).toHaveLength(stored.length + 1);
    expect(second.json().conversation.transcript).toHaveLength(4);

    // Otro editor no puede continuarla; los miembros sí la leen.
    expect((await ask('Yo también', editorAuth, first.conversation.id)).statusCode).toBe(403);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/assistant/conversations/${first.conversation.id}`,
      headers: viewerAuth,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().conversation).not.toHaveProperty('messages');
    const list = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/assistant/conversations`,
      headers: ownerAuth,
    });
    expect(list.json().conversations).toEqual([
      expect.objectContaining({ id: first.conversation.id, title: 'Primera' }),
    ]);
  });

  it('el autor acepta o descarta una propuesta; el lector no; layouts no cambia', async () => {
    const { ask, app, projectId, ownerAuth, viewerAuth, store } = await setup([
      { calls: [propose()] },
      { text: 'Listo.' },
    ]);
    const { conversation, proposals } = (await ask('Hazlo')).json() as AssistantReply;
    const url = `/v1/projects/${projectId}/assistant/conversations/${conversation.id}/proposals/${proposals[0]!.id}`;
    const denied = await app.inject({
      method: 'PATCH',
      url,
      headers: viewerAuth,
      payload: { status: 'accepted' },
    });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: ownerAuth,
      payload: { status: 'accepted' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.proposals[0].status).toBe('accepted');
    expect(store.layoutWrites).toEqual([]);
  });

  it('un error del proveedor se responde como aviso y el mensaje cuenta', async () => {
    const { ask, store } = await setup([
      { error: new AiProviderError('La clave de Anthropic no es válida (ANTHROPIC_API_KEY).') },
    ]);
    const res = await ask('hola');
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.transcript.at(-1)).toMatchObject({
      role: 'assistant',
      notice: true,
      text: expect.stringMatching(/clave de Anthropic/),
    });
    expect([...store.usage.values()]).toEqual([{ requests: 1, tokens: 0 }]);
  });

  it('corta el bucle de herramientas en el máximo de vueltas', async () => {
    const loop = { calls: [{ name: 'validate_scene', input: { scene: cell() } }] };
    const { ask, fake } = await setup([loop, loop, loop, loop], { ai: { maxTurns: 3 } });
    const res = await ask('Valida sin parar');
    expect(fake.requests).toHaveLength(3);
    expect(res.json().conversation.transcript.at(-1).text).toMatch(/máximo de 3 vueltas/);
  });
});

describe('asistente: límites de uso', () => {
  it('responde 429 con un mensaje claro al pasar el límite de mensajes', async () => {
    const { ask, fake, store } = await setup([{ text: 'uno' }, { text: 'dos' }], {
      ai: { requestLimit: 1 },
    });
    expect((await ask('uno')).statusCode).toBe(200);
    const res = await ask('dos');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: 'ai_limit',
      limit: { kind: 'requests', resets_at: expect.stringMatching(/T00:00:00\.000Z$/) },
    });
    expect(res.json().message).toMatch(/límite de 1 mensajes .* medianoche UTC/);
    expect(fake.requests).toHaveLength(1);
    expect([...store.usage.values()]).toEqual([{ requests: 1, tokens: 120 }]);
  });

  it('detiene la respuesta al alcanzar el límite de tokens y bloquea el siguiente mensaje', async () => {
    const loop = { calls: [{ name: 'list_components', input: {} }] };
    const { ask, fake } = await setup([loop, loop, loop], { ai: { tokenLimit: 200 } });
    const res = await ask('Componentes');
    expect(res.statusCode).toBe(200);
    expect(fake.requests).toHaveLength(2);
    expect(res.json().limit).toMatchObject({ kind: 'tokens' });
    expect(res.json().conversation.transcript.at(-1).text).toMatch(/quedó incompleta/);
    const next = await ask('Otra vez');
    expect(next.statusCode).toBe(429);
    expect(next.json().limit.kind).toBe('tokens');
  });

  it('aplica el tope global de la app', async () => {
    const { ask } = await setup([{ text: 'uno' }], { ai: { globalTokenLimit: 100 } });
    expect((await ask('uno')).statusCode).toBe(200);
    const res = await ask('dos');
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toMatch(/tope diario/);
  });
});

describe('asistente: corrida rápida', () => {
  type Store = Awaited<ReturnType<typeof setup>>['store'];
  const limits = {
    maxReplications: 20,
    maxHorizonH: 100,
    runTimeoutS: 600,
    playbackWindowS: 900,
    maxEvents: 1000,
  };

  /** Motor que termina al instante y escribe métricas en el almacén. */
  function instantSim(store: () => Store): SimSettings {
    return {
      ...limits,
      client: {
        async submit(req) {
          const run = store().runs.find((r) => r.id === req.run_id)!;
          Object.assign(run, {
            status: 'succeeded',
            summary: {
              bottleneck: { node: 'r', name: 'Robot', busy_failed: 0.9, second: null },
              assumptions: [],
              notes: [],
              representative_replication: 0,
              takt_time_s: null,
            },
          });
          const m: SimMetric & { run_id: string } = {
            run_id: run.id,
            metric: 'throughput_per_hour',
            scope: 'line',
            label: null,
            unit: 'u/h',
            replication: null,
            value: null,
            min: 340,
            mean: 355,
            max: 360,
            p5: 345,
            p95: 359,
            ci_low: 350,
            ci_high: 358,
          };
          store().metrics.push(m);
        },
      },
    };
  }

  /** Propone y luego simula la propuesta: el id solo se conoce tras el primer resultado. */
  async function proposeAndRun(
    sim: SimSettings | ((store: () => Store) => SimSettings),
    saveLayout = true,
  ) {
    let store: Store | null = null;
    const s = await setup(
      [
        { calls: [propose()] },
        { calls: [{ name: 'run_simulation', input: { proposal_id: '?' } }] },
        { text: 'Listo.' },
      ],
      { sim: typeof sim === 'function' ? sim(() => store!) : sim },
    );
    store = s.store;
    const turn = s.fake.provider.turn.bind(s.fake.provider);
    s.fake.provider.turn = async (req) => {
      const r = await turn(req);
      const prev = s.fake.toolResults().at(-1)?.content as { proposal_id?: string } | undefined;
      for (const c of r.toolCalls)
        if (c.name === 'run_simulation' && prev?.proposal_id)
          (c.input as { proposal_id: string }).proposal_id = prev.proposal_id;
      return r;
    };
    if (saveLayout)
      await s.app.inject({
        method: 'PUT',
        url: `/v1/projects/${s.projectId}/layout`,
        headers: s.ownerAuth,
        payload: { scene: empty, version: null },
      });
    const writes = s.store.layoutWrites.length;
    const res = await s.ask('¿Cuánto produce?');
    expect(res.statusCode).toBe(200);
    expect(s.store.layoutWrites.length).toBe(writes);
    return { ...s, reply: res.json() as AssistantReply, last: s.fake.toolResults().at(-1)! };
  }

  it('estima la producción de una propuesta con su rango, sin tocar el layout', async () => {
    const { reply, store, fake } = await proposeAndRun(instantSim);
    expect(fake.requests[0]!.tools.at(-1)!.name).toBe('run_simulation');
    expect(reply.conversation.proposals[0]!.estimate).toMatchObject({
      replications: 5,
      horizon_h: 8,
      throughput_per_hour: { mean: 355, low: 345, high: 359 },
      bottleneck: 'Robot',
    });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.input?.scene.objects).toHaveLength(3);
  });

  it('sin respuesta del motor en el tiempo máximo devuelve "sin estimación"', async () => {
    const { last } = await proposeAndRun({ ...limits, client: { submit: async () => {} } });
    expect(last.content).toMatchObject({
      estimate: null,
      reason: expect.stringMatching(/^sin estimación: la corrida no terminó/),
    });
  });

  it('sin layout guardado no simula', async () => {
    const { last, store } = await proposeAndRun(instantSim, false);
    expect(last.content).toMatchObject({
      estimate: null,
      reason: expect.stringMatching(/layout guardado/),
    });
    expect(store.runs).toHaveLength(0);
  });
});

describe('asistente: esquemas de herramientas', () => {
  it('las herramientas estrictas cumplen las reglas de esquema estricto', async () => {
    const { toolSpecs } = await import('../src/ai/tools.ts');
    const strict = toolSpecs(true).filter((t) => t.strict);
    expect(strict.map((t) => t.name)).toEqual([
      'search_catalog',
      'get_variant',
      'list_components',
      'run_simulation',
    ]);
    for (const t of strict) {
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(JSON.stringify(t.input_schema)).not.toMatch(
        /minimum|maximum|minLength|maxLength|anyOf/,
      );
    }
    const optional = strict.reduce((n, t) => {
      const s = t.input_schema as { properties: object; required: string[] };
      return n + Object.keys(s.properties).length - s.required.length;
    }, 0);
    expect(optional).toBeLessThanOrEqual(24);
  });
});
