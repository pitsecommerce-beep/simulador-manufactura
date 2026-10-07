import { z } from 'zod';

// Variables de entorno de la API. Todas se definen en Railway (nunca en el repo).
const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SUPABASE_URL: z.url(),
  // Clave publicable (sb_publishable_...) o la clave "anon" heredada.
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  // Clave secreta (sb_secret_...) o la "service_role" heredada. Solo en servidor.
  SUPABASE_SECRET_KEY: z.string().min(20),
  // Solo si el proyecto usa el secreto JWT heredado (HS256). Con llaves asimétricas se usa JWKS.
  SUPABASE_JWT_SECRET: z.string().min(20).optional(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        // "https://x.up.railway.app/" equivale a "https://x.up.railway.app": el navegador
        // envía el Origin sin diagonal final.
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // Motor de línea (sim-worker) en la red privada de Railway. Sin URL, simular está desactivado.
  SIM_WORKER_URL: z.url().optional(),
  SIM_WORKER_TOKEN: z.string().min(16).optional(),
  SIM_MAX_REPLICATIONS: z.coerce.number().int().positive().max(10_000).default(50),
  SIM_MAX_HORIZON_H: z.coerce.number().positive().max(10_000).default(720),
  SIM_RUN_TIMEOUT_S: z.coerce.number().int().positive().default(1800),
  APP_VERSION: z.string().default(process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev'),
});

export type Config = z.infer<typeof Env>;

const SimPair = Env.refine((c) => !c.SIM_WORKER_URL || c.SIM_WORKER_TOKEN, {
  message: 'SIM_WORKER_TOKEN es obligatoria si se define SIM_WORKER_URL',
  path: ['SIM_WORKER_TOKEN'],
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = SimPair.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  return parsed.data;
}
