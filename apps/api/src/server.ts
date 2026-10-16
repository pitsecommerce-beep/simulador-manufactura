import { buildApp } from './app.ts';
import { supabaseTokenVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { supabaseSystemRepo, supabaseUserRepo } from './repo.ts';
import { httpSimClient } from './sim.ts';
import { anthropicProvider } from './ai/anthropic.ts';

const config = loadConfig();

const app = await buildApp({
  verifyToken: supabaseTokenVerifier({
    supabaseUrl: config.SUPABASE_URL,
    jwtSecret: config.SUPABASE_JWT_SECRET,
  }),
  userRepo: (user) => supabaseUserRepo(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, user),
  systemRepo: supabaseSystemRepo(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY),
  corsOrigins: config.CORS_ORIGINS,
  rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
  sim:
    config.SIM_WORKER_URL && config.SIM_WORKER_TOKEN
      ? {
          client: httpSimClient(config.SIM_WORKER_URL, config.SIM_WORKER_TOKEN),
          maxReplications: config.SIM_MAX_REPLICATIONS,
          maxHorizonH: config.SIM_MAX_HORIZON_H,
          runTimeoutS: config.SIM_RUN_TIMEOUT_S,
          playbackWindowS: 1800,
          maxEvents: 200_000,
        }
      : null,
  ai:
    config.AI_MODEL && config.ANTHROPIC_API_KEY
      ? {
          provider: anthropicProvider({
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.AI_MODEL,
            effort: config.AI_EFFORT,
            maxTokens: config.AI_MAX_TOKENS,
            timeoutMs: config.AI_TIMEOUT_MS,
          }),
          requestLimit: config.AI_DAILY_REQUEST_LIMIT,
          tokenLimit: config.AI_DAILY_TOKEN_LIMIT,
          globalTokenLimit: config.AI_GLOBAL_DAILY_TOKEN_LIMIT,
          maxTurns: 8,
          quickRun: { timeoutMs: 60_000, pollMs: 2_000, replications: 5, horizonH: 8 },
        }
      : null,
  version: config.APP_VERSION,
  logLevel: config.LOG_LEVEL,
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
