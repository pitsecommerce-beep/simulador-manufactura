import { buildApp } from './app.ts';
import { supabaseTokenVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { supabaseSystemRepo, supabaseUserRepo } from './repo.ts';

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
