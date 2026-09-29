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
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(await signToken(uid)) });
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
    const res = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(token), payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
    const bad = await app.inject({ method: 'GET', url: '/v1/projects/no-es-uuid', headers: auth(token) });
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
      await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(ownerToken), payload: { name: 'P' } })
    ).json();

    const before = await app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: auth(guestToken) });
    expect(before.statusCode).toBe(404);

    const share = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/members`,
      headers: auth(ownerToken),
      payload: { email: 'Invitada@test.local', role: 'viewer' },
    });
    expect(share.statusCode).toBe(201);

    const after = await app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: auth(guestToken) });
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
      await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(token), payload: { name: 'P' } })
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
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('solo permite CORS a los orígenes configurados', async () => {
    const { app } = await testApp();
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://malo.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
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
});
