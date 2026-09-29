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
      'components',
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
