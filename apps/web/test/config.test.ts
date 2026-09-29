import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/lib/config';

describe('resolveConfig', () => {
  const env = {
    VITE_API_URL: 'http://localhost:8080/',
    VITE_SUPABASE_URL: 'http://sb',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'k',
  };

  it('usa variables de Vite en desarrollo y quita la barra final', () => {
    expect(resolveConfig(null, env)).toEqual({
      apiUrl: 'http://localhost:8080',
      supabaseUrl: 'http://sb',
      supabasePublishableKey: 'k',
    });
  });

  it('prioriza la configuración en tiempo de ejecución', () => {
    expect(resolveConfig({ apiUrl: 'https://api.up.railway.app' }, env).apiUrl).toBe(
      'https://api.up.railway.app',
    );
  });

  it('falla indicando qué falta', () => {
    expect(() => resolveConfig(null, {})).toThrow(/apiUrl, supabaseUrl, supabasePublishableKey/);
  });
});
