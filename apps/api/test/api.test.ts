import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { signToken, testApp } from './fakes.ts';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('salud', () => {
  it('GET /health responde sin sesión e informa el estado de Supabase', async () => {
    const { app } = await testApp({ pingOk: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', supabase: 'error' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
  });
});

describe('autenticación', () => {
  it('rechaza peticiones sin token', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('acepta un JWT válido de Supabase', async () => {
    const { app } = await testApp();
    const uid = randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(await signToken(uid)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: uid, email: `${uid}@test.local` });
  });

  it.each([
    ['vencido', { expiresIn: '-1m' }],
    ['de otro proyecto', { issuer: 'https://otro.supabase.co/auth/v1' }],
    ['anónimo', { role: 'anon' }],
  ])('rechaza un token %s', async (_name, opts) => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(await signToken(randomUUID(), opts)),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rechaza un token con firma alterada', async () => {
    const { app } = await testApp();
    const token = await signToken(randomUUID());
    const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(tampered) });
    expect(res.statusCode).toBe(401);
  });
});

describe('proyectos', () => {
  it('crea y lista proyectos del usuario', async () => {
    const { app } = await testApp();
    const token = await signToken(randomUUID());
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(token),
      payload: { name: '  Empaque línea 2 ' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.name).toBe('Empaque línea 2');
    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: auth(token) });
    expect(list.json().projects).toHaveLength(1);
  });

  it('valida la entrada', async () => {
    const { app } = await testApp();
    const token = await signToken(randomUUID());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(token),
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/projects/no-es-uuid',
      headers: auth(token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('comparte un proyecto por correo y el invitado lo ve con su rol', async () => {
    const { app, store } = await testApp();
    const owner = randomUUID();
    const guest = randomUUID();
    store.profiles.set('invitada@test.local', guest);
    const ownerToken = await signToken(owner);
    const guestToken = await signToken(guest);

    const { project } = (
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: auth(ownerToken),
        payload: { name: 'P' },
      })
    ).json();

    const before = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: auth(guestToken),
    });
    expect(before.statusCode).toBe(404);

    const share = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/members`,
      headers: auth(ownerToken),
      payload: { email: 'Invitada@test.local', role: 'viewer' },
    });
    expect(share.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: auth(guestToken),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().access).toBe('viewer');

    // El invitado no puede volver a compartir
    const reshare = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/members`,
      headers: auth(guestToken),
      payload: { email: 'invitada@test.local', role: 'editor' },
    });
    expect(reshare.statusCode).toBe(403);
  });

  it('informa cuando el correo no pertenece al equipo', async () => {
    const { app } = await testApp();
    const token = await signToken(randomUUID());
    const { project } = (
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: auth(token),
        payload: { name: 'P' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/members`,
      headers: auth(token),
      payload: { email: 'nadie@test.local', role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('límites y seguridad', () => {
  it('aplica límite de peticiones', async () => {
    const { app } = await testApp({ rateLimit: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('solo permite CORS a los orígenes configurados', async () => {
    const { app } = await testApp();
    const ok = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://malo.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('layout del proyecto', () => {
  const scene = {
    schema: 1,
    objects: [
      {
        id: 'p1',
        name: 'Pallet 1',
        kind: 'pallet',
        position: [1000, 0],
        elevation: 0,
        rotation_deg: 0,
        color: '#c08a4a',
        served_by: null,
        params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
      },
    ],
  };

  async function setup() {
    const { app, store } = await testApp();
    const owner = randomUUID();
    const editor = randomUUID();
    const viewer = randomUUID();
    const ownerToken = await signToken(owner);
    const { project } = (
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: auth(ownerToken),
        payload: { name: 'P' },
      })
    ).json();
    store.members.push(
      { project_id: project.id, user_id: editor, role: 'editor' },
      { project_id: project.id, user_id: viewer, role: 'viewer' },
    );
    const url = `/v1/projects/${project.id}/layout`;
    const as = async (uid: string) => auth(await signToken(uid));
    return { app, url, owner: await as(owner), editor: await as(editor), viewer: await as(viewer) };
  }

  it('sin layout devuelve una escena vacía; al guardar crea la versión 1', async () => {
    const { app, url, owner } = await setup();
    const empty = await app.inject({ method: 'GET', url, headers: owner });
    expect(empty.json()).toEqual({
      version: null,
      scene: { schema: 1, objects: [] },
      updated_at: null,
    });
    const saved = await app.inject({
      method: 'PUT',
      url,
      headers: owner,
      payload: { scene, version: null },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(1);
    const loaded = await app.inject({ method: 'GET', url, headers: owner });
    expect(loaded.json().scene.objects[0].name).toBe('Pallet 1');
  });

  it('el editor guarda; una versión desactualizada da 409', async () => {
    const { app, url, owner, editor } = await setup();
    await app.inject({ method: 'PUT', url, headers: owner, payload: { scene, version: null } });
    const ok = await app.inject({
      method: 'PUT',
      url,
      headers: editor,
      payload: { scene, version: 1 },
    });
    expect(ok.json().version).toBe(2);
    const stale = await app.inject({
      method: 'PUT',
      url,
      headers: owner,
      payload: { scene, version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toMatch(/Recarga/);
  });

  it('el lector lee pero no guarda; un extraño no ve el proyecto', async () => {
    const { app, url, viewer } = await setup();
    expect((await app.inject({ method: 'GET', url, headers: viewer })).statusCode).toBe(200);
    const res = await app.inject({
      method: 'PUT',
      url,
      headers: viewer,
      payload: { scene, version: null },
    });
    expect(res.statusCode).toBe(403);
    const stranger = auth(await signToken(randomUUID()));
    expect((await app.inject({ method: 'GET', url, headers: stranger })).statusCode).toBe(404);
  });

  it('rechaza escenas inválidas (pallet sin altura, medidas negativas)', async () => {
    const { app, url, owner } = await setup();
    const noHeight = structuredClone(scene);
    delete (noHeight.objects[0]!.params as Record<string, unknown>).height_mm;
    for (const bad of [
      noHeight,
      {
        schema: 1,
        objects: [{ ...scene.objects[0], params: { ...scene.objects[0]!.params, width_mm: -1 } }],
      },
      { schema: 2, objects: [] },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: owner,
        payload: { scene: bad, version: null },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('catálogo', () => {
  const get = async (url: string, withAuth = true) => {
    const { app } = await testApp();
    const headers = withAuth ? auth(await signToken(randomUUID())) : {};
    return app.inject({ method: 'GET', url, headers });
  };

  it.each(['/v1/catalog/variants', '/v1/catalog/facets', '/v1/catalog/variants/irb-1300-7-1-4'])(
    'exige sesión en %s',
    async (url) => {
      expect((await get(url, false)).statusCode).toBe(401);
    },
  );

  it('lista y filtra variantes; los filtros numéricos excluyen datos no publicados', async () => {
    const all = await get('/v1/catalog/variants');
    expect(all.json().variants).toHaveLength(4);
    const heavy = await get('/v1/catalog/variants?payload_min=5');
    expect(heavy.json().variants.map((v: { slug: string }) => v.slug)).toEqual([
      'irb-1300-7-1-4',
      'irb-460-110-2-4',
    ]);
    const family = await get('/v1/catalog/variants?family=Delta');
    expect(family.json().variants.map((v: { slug: string }) => v.slug)).toEqual(['irb-360-1-1130']);
    // El delta no publica alcance: se filtra por su radio de trabajo (1130/2).
    const reach = await get('/v1/catalog/variants?reach_max=600');
    expect(reach.json().variants.map((v: { slug: string }) => v.slug)).toEqual(['irb-360-1-1130']);
    const text = await get('/v1/catalog/variants?q=irb%20460');
    expect(text.json().variants).toHaveLength(1);
  });

  it('rechaza filtros inválidos', async () => {
    expect((await get('/v1/catalog/variants?payload_min=-3')).statusCode).toBe(400);
  });

  it('devuelve facetas', async () => {
    const res = await get('/v1/catalog/facets');
    expect(res.json()).toMatchObject({
      families: ['Articulated (small)', 'Delta', 'Paint', 'Palletizing 4-axis'],
      payload: { min: 1, max: 110 },
    });
  });

  it('devuelve el detalle de una variante y 404 si no existe', async () => {
    const ok = await get('/v1/catalog/variants/irb-1300-7-1-4');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().variant.variant_code).toBe('IRB 1300-7/1.4');
    expect((await get('/v1/catalog/variants/no-existe')).statusCode).toBe(404);
    expect((await get('/v1/catalog/variants/NO_VALIDO')).statusCode).toBe(400);
  });
});

describe('configuración', () => {
  it('falla con un mensaje claro si faltan variables', () => {
    expect(() => loadConfig({})).toThrow(/SUPABASE_URL/);
  });

  it('parsea orígenes CORS separados por comas', () => {
    const c = loadConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xxxxxxxxxxxxxxxx',
      SUPABASE_SECRET_KEY: 'sb_secret_xxxxxxxxxxxxxxxxxxxxxx',
      CORS_ORIGINS: 'https://a.up.railway.app, https://b.mx',
    });
    expect(c.CORS_ORIGINS).toEqual(['https://a.up.railway.app', 'https://b.mx']);
    expect(c.PORT).toBe(8080);
  });

  it('normaliza orígenes CORS con espacios y diagonales finales', () => {
    const c = loadConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xxxxxxxxxxxxxxxx',
      SUPABASE_SECRET_KEY: 'sb_secret_xxxxxxxxxxxxxxxxxxxxxx',
      CORS_ORIGINS: ' https://x.up.railway.app/ ,https://b.mx//, ',
    });
    expect(c.CORS_ORIGINS).toEqual(['https://x.up.railway.app', 'https://b.mx']);
  });
});
