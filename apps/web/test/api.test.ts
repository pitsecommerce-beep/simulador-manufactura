import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('cliente de API', () => {
  it('envía el token de sesión', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ projects: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await createApi('http://api', async () => 'tok').listProjects();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/v1/projects');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('convierte errores HTTP en ApiError con el mensaje del servidor', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'Sin permiso' }), { status: 403 }),
        ),
    );
    await expect(createApi('http://api', async () => null).listProjects()).rejects.toEqual(
      new ApiError(403, 'Sin permiso'),
    );
  });

  it('informa cuando no hay conexión', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(createApi('http://api', async () => null).health()).rejects.toThrow(/conectar/);
  });
});
