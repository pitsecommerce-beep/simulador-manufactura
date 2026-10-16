import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asRole,
  asUser,
  createTestDatabase,
  expectError,
  inRollback,
  insertId,
  type Db,
} from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;

const owner = randomUUID();
const editor = randomUUID();
const viewer = randomUUID();
const stranger = randomUUID();
let projectId: string;
let layoutId: string;
let scenarioId: string;
let runId: string;
let robotId: string;
let variantId: string;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase());

  for (const [id, email] of [
    [owner, 'owner@test.local'],
    [editor, 'editor@test.local'],
    [viewer, 'viewer@test.local'],
    [stranger, 'stranger@test.local'],
  ]) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  }

  projectId = await insertId(
    db,
    `insert into public.projects (owner_id, name) values ($1, 'Línea A') returning id`,
    [owner],
  );
  await db.query(
    `insert into public.project_members (project_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')`,
    [projectId, editor, viewer],
  );
  layoutId = await insertId(
    db,
    `insert into public.layouts (project_id, scene) values ($1, '{}') returning id`,
    [projectId],
  );
  scenarioId = await insertId(
    db,
    `insert into public.scenarios (project_id, layout_id, name) values ($1, $2, 'base') returning id`,
    [projectId, layoutId],
  );
  runId = await insertId(
    db,
    `insert into public.simulation_runs (project_id, scenario_id) values ($1, $2) returning id`,
    [projectId, scenarioId],
  );

  robotId = await insertId(
    db,
    `insert into public.robots (slug, manufacturer, model, is_synthetic) values ('synth-6ax', 'Sintético', 'S6', true) returning id`,
  );
  variantId = await insertId(
    db,
    `insert into public.robot_variants (robot_id, slug, variant_code) values ($1, 'synth-6ax-5-0.9', '5/0.9') returning id`,
    [robotId],
  );
  const sha = 'a'.repeat(64);
  await db.query(
    `insert into public.robot_assets (robot_id, variant_id, kind, bucket, path, sha256, bytes, license_terms)
     values ($1, $2, 'original_cad', 'catalog-originals', 'synth/s6.step.gz', $3, 10, 'sintético'),
            ($1, $2, 'derived_glb', 'catalog-derived', 'synth/base.glb', $3, 10, 'sintético')`,
    [robotId, variantId, sha],
  );
});

afterAll(async () => {
  await drop?.();
});

describe('cobertura de RLS', () => {
  it('todas las tablas de public tienen RLS activada', async () => {
    const { rows } = await db.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('existen todas las tablas del plan', async () => {
    const expected = [
      'robots',
      'robot_variants',
      'robot_specs',
      'robot_assets',
      'robot_documents',
      'components',
      'component_documents',
      'component_specs',
      'component_assets',
      'object_types',
      'object_instances',
      'projects',
      'layouts',
      'scenarios',
      'simulation_runs',
      'simulation_metrics',
      'generated_code',
      'ai_conversations',
      'profiles',
      'project_members',
      'jobs',
      'ai_usage',
      'asset_access_log',
    ];
    const { rows } = await db.query(`select tablename from pg_tables where schemaname = 'public'`);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...expected].sort());
  });

  it('anon no puede leer ninguna tabla de public', async () => {
    const { rows } = await db.query(`select tablename from pg_tables where schemaname = 'public'`);
    await asRole(db, 'anon', null, async (c) => {
      for (const { tablename } of rows) {
        const msg = await expectError(c, `select 1 from public.${tablename} limit 1`);
        expect(msg).toMatch(/permission denied/);
      }
    });
  });
});

describe('catálogo', () => {
  it('autenticados leen el catálogo pero no lo modifican', async () => {
    await asUser(db, stranger, async (c) => {
      const { rows } = await c.query('select slug from public.robots');
      expect(rows.map((r) => r.slug)).toContain('synth-6ax');
      expect(
        await expectError(
          c,
          `insert into public.robots (slug, manufacturer, model) values ('x', 'y', 'z')`,
        ),
      ).toMatch(/permission denied/);
      expect(await expectError(c, `update public.robots set model = 'hack'`)).toMatch(
        /permission denied/,
      );
    });
  });

  it('documentos de catálogo: lectura para autenticados, sin escritura', async () => {
    await inRollback(db, async (c) => {
      await c.query(
        `insert into public.robot_documents (robot_id, path, kind) values ($1, 'datasheet.pdf', 'datasheet')`,
        [robotId],
      );
      await c.query(
        `select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
        [JSON.stringify({ sub: stranger, role: 'authenticated' })],
      );
      const { rows } = await c.query('select path from public.robot_documents');
      expect(rows).toEqual([{ path: 'datasheet.pdf' }]);
      for (const sql of [
        `insert into public.robot_documents (robot_id, path, kind) values ('${robotId}', 'x.pdf', 'datasheet')`,
        `update public.robot_documents set url = 'https://malo.example'`,
        `delete from public.robot_documents`,
        `update public.robot_specs set payload_kg = 999`,
        `delete from public.robot_variants`,
        `insert into public.component_documents (component_id, path, kind) values (gen_random_uuid(), 'x', 'y')`,
      ]) {
        expect(await expectError(c, sql)).toMatch(/permission denied/);
      }
    });
  });

  it('los metadatos de CAD original no son visibles para el cliente', async () => {
    await asUser(db, owner, async (c) => {
      const { rows } = await c.query('select kind, bucket from public.robot_assets');
      expect(rows).toEqual([{ kind: 'derived_glb', bucket: 'catalog-derived' }]);
    });
  });

  it('un CAD original no puede registrarse en el bucket de derivados', async () => {
    const msg = await inRollback(db, (c) =>
      expectError(
        c,
        `insert into public.robot_assets (robot_id, kind, bucket, path, sha256, bytes)
       values ($1, 'original_cad', 'catalog-derived', 'leak.step', $2, 1)`,
        [robotId, 'b'.repeat(64)],
      ),
    );
    expect(msg).toMatch(/check constraint/);
  });

  it('los datos de ficha ausentes se guardan como null', async () => {
    await db.query('begin');
    try {
      await db.query('insert into public.robot_specs (variant_id) values ($1)', [variantId]);
      const { rows } = await db.query(
        'select axes_count, reach_mm, payload_kg, repeatability_mm, axis_limits from public.robot_specs where variant_id = $1',
        [variantId],
      );
      expect(rows[0]).toEqual({
        axes_count: null,
        reach_mm: null,
        payload_kg: null,
        repeatability_mm: null,
        axis_limits: null,
      });
    } finally {
      await db.query('rollback');
    }
  });
});

describe('proyectos compartidos', () => {
  it('los perfiles se crean al registrar usuarios', async () => {
    const { rows } = await db.query('select email from public.profiles where user_id = $1', [
      owner,
    ]);
    expect(rows[0]?.email).toBe('owner@test.local');
  });

  it('propietario y miembros ven el proyecto; un extraño no', async () => {
    for (const u of [owner, editor, viewer]) {
      await asUser(db, u, async (c) => {
        const { rowCount } = await c.query('select 1 from public.projects where id = $1', [
          projectId,
        ]);
        expect(rowCount).toBe(1);
      });
    }
    await asUser(db, stranger, async (c) => {
      expect((await c.query('select 1 from public.projects')).rowCount).toBe(0);
      expect((await c.query('select 1 from public.layouts')).rowCount).toBe(0);
      expect((await c.query('select 1 from public.project_members')).rowCount).toBe(0);
      expect((await c.query('select 1 from public.simulation_runs')).rowCount).toBe(0);
    });
  });

  it('un usuario crea su proyecto y lo recibe con RETURNING', async () => {
    await asUser(db, stranger, async (c) => {
      const { rows } = await c.query(
        `insert into public.projects (name) values ('Mío') returning owner_id`,
      );
      expect(rows[0].owner_id).toBe(stranger);
    });
  });

  it('no se puede crear un proyecto a nombre de otro', async () => {
    await asUser(db, stranger, async (c) => {
      const msg = await expectError(
        c,
        `insert into public.projects (owner_id, name) values ($1, 'X')`,
        [owner],
      );
      expect(msg).toMatch(/row-level security/);
    });
  });

  it('viewer no edita; editor sí', async () => {
    await asUser(db, viewer, async (c) => {
      const r = await c.query(`update public.projects set name = 'v' where id = $1`, [projectId]);
      expect(r.rowCount).toBe(0);
      const msg = await expectError(
        c,
        `insert into public.layouts (project_id, version) values ($1, 2)`,
        [projectId],
      );
      expect(msg).toMatch(/row-level security/);
    });
    await asUser(db, editor, async (c) => {
      const r = await c.query(`update public.projects set name = 'e' where id = $1`, [projectId]);
      expect(r.rowCount).toBe(1);
      await c.query(`update public.layouts set is_current = false where project_id = $1`, [
        projectId,
      ]);
      const ins = await c.query(
        `insert into public.layouts (project_id, version) values ($1, 2) returning id`,
        [projectId],
      );
      expect(ins.rowCount).toBe(1);
    });
  });

  it('guardar layout: el editor actualiza la escena con control de versión; lector y extraño no', async () => {
    const save = (c: Db, version: number) =>
      c.query(
        `update public.layouts set scene = $2, version = $3 + 1
         where project_id = $1 and is_current and version = $3 returning version`,
        [projectId, JSON.stringify({ schema: 1, objects: [] }), version],
      );
    for (const u of [viewer, stranger]) {
      await asUser(db, u, async (c) => {
        expect((await save(c, 1)).rowCount).toBe(0);
      });
    }
    await asUser(db, editor, async (c) => {
      expect((await save(c, 1)).rows).toEqual([{ version: 2 }]);
      // Una versión desactualizada no actualiza nada (la API responde 409).
      expect((await save(c, 1)).rowCount).toBe(0);
      const { rows } = await c.query('select scene from public.layouts where project_id = $1', [
        projectId,
      ]);
      expect(rows[0].scene).toEqual({ schema: 1, objects: [] });
    });
  });

  it('corridas y métricas: los miembros leen, nadie escribe desde el cliente', async () => {
    await inRollback(db, async (c) => {
      await c.query(
        `insert into public.simulation_metrics (project_id, run_id, metric, scope, mean, ci_low, ci_high, label)
         values ($1, $2, 'throughput_per_hour', 'line', 360, 350, 370, 'Línea')`,
        [projectId, runId],
      );
      await c.query(
        `update public.simulation_runs set name = 'Base', summary = '{}', input = '{}', progress = 1 where id = $1`,
        [runId],
      );
      for (const [u, expected] of [
        [viewer, 1],
        [stranger, 0],
      ] as const) {
        await c.query(
          `select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
          [JSON.stringify({ sub: u, role: 'authenticated' })],
        );
        expect((await c.query('select ci_low from public.simulation_metrics')).rowCount).toBe(
          expected,
        );
        expect((await c.query('select name from public.simulation_runs')).rowCount).toBe(expected);
        await c.query(`select set_config('role', 'postgres', true)`);
      }
      await c.query(
        `select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
        [JSON.stringify({ sub: owner, role: 'authenticated' })],
      );
      for (const sql of [
        `update public.simulation_runs set status = 'succeeded'`,
        `insert into public.simulation_metrics (project_id, run_id, metric) values ('${projectId}', '${runId}', 'x')`,
        `delete from public.simulation_metrics`,
      ]) {
        expect(await expectError(c, sql)).toMatch(/permission denied/);
      }
    });
  });

  it('solo el propietario borra el proyecto y gestiona miembros', async () => {
    await asUser(db, editor, async (c) => {
      expect(
        (await c.query('delete from public.projects where id = $1', [projectId])).rowCount,
      ).toBe(0);
      const msg = await expectError(
        c,
        `insert into public.project_members (project_id, user_id, role) values ($1, $2, 'editor')`,
        [projectId, stranger],
      );
      expect(msg).toMatch(/row-level security/);
      const up = await c.query(
        `update public.project_members set role = 'editor' where user_id = $1`,
        [viewer],
      );
      expect(up.rowCount).toBe(0);
    });
    await asUser(db, owner, async (c) => {
      await c.query(
        `insert into public.project_members (project_id, user_id, role) values ($1, $2, 'viewer')`,
        [projectId, stranger],
      );
      expect(
        (await c.query('delete from public.projects where id = $1', [projectId])).rowCount,
      ).toBe(1);
    });
  });

  it('un miembro puede salir del proyecto', async () => {
    await asUser(db, viewer, async (c) => {
      const r = await c.query(
        'delete from public.project_members where project_id = $1 and user_id = $2',
        [projectId, viewer],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it('el propietario no se puede cambiar desde una sesión de usuario', async () => {
    await asUser(db, owner, async (c) => {
      const msg = await expectError(c, `update public.projects set owner_id = $1 where id = $2`, [
        editor,
        projectId,
      ]);
      expect(msg).toMatch(/owner_id no se puede modificar/);
    });
  });

  it('los miembros leen corridas y métricas pero no las escriben', async () => {
    await asUser(db, viewer, async (c) => {
      expect(
        (await c.query('select 1 from public.simulation_runs where id = $1', [runId])).rowCount,
      ).toBe(1);
      const msg = await expectError(
        c,
        `insert into public.simulation_runs (project_id, scenario_id) values ($1, $2)`,
        [projectId, scenarioId],
      );
      expect(msg).toMatch(/permission denied/);
    });
  });

  it('una instancia no puede apuntar a un layout de otro proyecto', async () => {
    const other = await insertId(
      db,
      `insert into public.projects (owner_id, name) values ($1, 'B') returning id`,
      [stranger],
    );
    const ot = await insertId(
      db,
      `insert into public.object_types (key, name, category) values ('pallet_t', 'Pallet', 'pallet') returning id`,
    );
    const msg = await inRollback(db, (c) =>
      expectError(
        c,
        `insert into public.object_instances (project_id, layout_id, object_type_id) values ($1, $2, $3)`,
        [other, layoutId, ot],
      ),
    );
    expect(msg).toMatch(/foreign key/);
  });
});

describe('tablas internas y storage', () => {
  it('los clientes no acceden a jobs, ai_usage ni asset_access_log', async () => {
    await asUser(db, owner, async (c) => {
      for (const t of ['jobs', 'ai_usage', 'asset_access_log']) {
        expect(await expectError(c, `select 1 from public.${t}`)).toMatch(/permission denied/);
      }
    });
  });

  it('los buckets son privados y no tienen políticas de cliente', async () => {
    const { rows } = await db.query('select id, public from storage.buckets order by id');
    expect(rows).toEqual([
      { id: 'catalog-derived', public: false },
      { id: 'catalog-originals', public: false },
      { id: 'sim-artifacts', public: false },
    ]);
    const policies = await db.query(
      `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`,
    );
    expect(policies.rowCount).toBe(0);

    await db.query(
      `insert into storage.objects (bucket_id, name) values ('catalog-originals', 'synth/s6.step.gz')`,
    );
    await asUser(db, owner, async (c) => {
      expect((await c.query('select 1 from storage.objects')).rowCount).toBe(0);
    });
  });

  it('las funciones de acceso de la cola no son ejecutables por clientes', async () => {
    await asUser(db, owner, async (c) => {
      const msg = await expectError(c, `select * from private.claim_job(array['ping'], 'x')`);
      expect(msg).toMatch(/permission denied/);
    });
  });
});

describe('cola de trabajos', () => {
  it('claim_job reparte trabajos sin duplicarlos y finish_job reintenta con backoff', async () => {
    await db.query(
      `insert into public.jobs (kind, payload, max_attempts) values ('ping', '{}', 2), ('ping', '{}', 2)`,
    );
    const a = await db.query(`select * from private.claim_job(array['ping'], 'w1')`);
    const b = await db.query(`select * from private.claim_job(array['ping'], 'w2')`);
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
    expect((await db.query(`select * from private.claim_job(array['ping'], 'w3')`)).rowCount).toBe(
      0,
    );

    await db.query(`select private.finish_job($1, 'failed', null, 'boom')`, [a.rows[0].id]);
    const retried = await db.query(
      'select status, run_after > now() as delayed from public.jobs where id = $1',
      [a.rows[0].id],
    );
    expect(retried.rows[0]).toEqual({ status: 'queued', delayed: true });

    await db.query(`select private.finish_job($1, 'succeeded', '{"ok":true}')`, [b.rows[0].id]);
    const ok = await db.query('select status, result from public.jobs where id = $1', [
      b.rows[0].id,
    ]);
    expect(ok.rows[0]).toEqual({ status: 'succeeded', result: { ok: true } });
  });
});

describe('asistente de IA', () => {
  const consume = (c: Db, user: string, req: number, tin: number, tout: number, global = 1e9) =>
    c
      .query(`select public.consume_ai_usage($1, $2, $3, $4, 2, 1000, $5) as r`, [
        user,
        req,
        tin,
        tout,
        global,
      ])
      .then((r) => r.rows[0].r);

  it('consume_ai_usage solo la ejecuta la clave secreta', async () => {
    await asUser(db, owner, async (c) => {
      const msg = await expectError(
        c,
        `select public.consume_ai_usage($1, 1, 0, 0, 30, 1000000, null)`,
        [owner],
      );
      expect(msg).toMatch(/permission denied/);
    });
    await asRole(db, 'anon', null, async (c) => {
      const msg = await expectError(
        c,
        `select public.consume_ai_usage($1, 1, 0, 0, 30, 1000000, null)`,
        [owner],
      );
      expect(msg).toMatch(/permission denied/);
    });
  });

  it('cuenta solicitudes y tokens y bloquea al alcanzar cada límite', async () => {
    await asRole(db, 'service_role', null, async (c) => {
      expect(await consume(c, editor, 1, 0, 0)).toMatchObject({ allowed: true, requests: 1 });
      expect(await consume(c, editor, 0, 300, 100)).toMatchObject({ allowed: true, tokens: 400 });
      expect(await consume(c, editor, 1, 0, 0)).toMatchObject({ allowed: true, requests: 2 });
      // Tercera solicitud: límite de 2 por día.
      expect(await consume(c, editor, 1, 0, 0)).toMatchObject({
        allowed: false,
        blocked: 'requests',
        requests: 2,
      });
      // Los tokens se registran aunque el límite ya se haya alcanzado.
      expect(await consume(c, editor, 0, 700, 0)).toMatchObject({ allowed: true, tokens: 1100 });
      expect(await consume(c, viewer, 1, 0, 0)).toMatchObject({ allowed: true, requests: 1 });
      expect(await consume(c, viewer, 0, 900, 200)).toMatchObject({ tokens: 1100 });
      expect(await consume(c, viewer, 1, 0, 0)).toMatchObject({
        allowed: false,
        blocked: 'tokens',
      });
      // Tope global: suma a todos los usuarios del día.
      expect(await consume(c, owner, 1, 0, 0, 2000)).toMatchObject({
        allowed: false,
        blocked: 'global_tokens',
        global_tokens: 2200,
      });
      const { rows } = await c.query(`select requests from public.ai_usage where user_id = $1`, [
        owner,
      ]);
      expect(rows).toEqual([{ requests: 0 }]);
    });
  });

  it('las conversaciones las escribe la api; su autor y los miembros las leen', async () => {
    await inRollback(db, async (c) => {
      await c.query(
        `insert into public.ai_conversations (project_id, owner_id, proposals, transcript)
         values ($1, $2, '[{"id":"p1","status":"pending"}]', '[]')`,
        [projectId, editor],
      );
      await c.query(
        `select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
        [JSON.stringify({ sub: viewer, role: 'authenticated' })],
      );
      const read = await c.query('select proposals from public.ai_conversations');
      expect(read.rows).toEqual([{ proposals: [{ id: 'p1', status: 'pending' }] }]);
      expect(await expectError(c, `update public.ai_conversations set proposals = '[]'`)).toMatch(
        /permission denied/,
      );
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: stranger, role: 'authenticated' }),
      ]);
      expect((await c.query('select 1 from public.ai_conversations')).rowCount).toBe(0);
    });
  });
});
