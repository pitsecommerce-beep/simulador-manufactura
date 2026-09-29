export interface AppConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<AppConfig> | null;
  }
}

/** Configuración en tiempo de ejecución (config.js) con respaldo en variables de Vite. */
export function resolveConfig(
  runtime: Partial<AppConfig> | null | undefined,
  env: Record<string, string | undefined>,
): AppConfig {
  const cfg = {
    apiUrl: runtime?.apiUrl || env.VITE_API_URL || '',
    supabaseUrl: runtime?.supabaseUrl || env.VITE_SUPABASE_URL || '',
    supabasePublishableKey:
      runtime?.supabasePublishableKey || env.VITE_SUPABASE_PUBLISHABLE_KEY || '',
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Falta configuración: ${missing.join(', ')}`);
  return { ...cfg, apiUrl: cfg.apiUrl.replace(/\/$/, '') };
}
