-- Tablas internas: cola de trabajos, uso de IA y registro de URLs firmadas.
-- RLS activada y sin políticas: ningún cliente accede. Solo service_role y la
-- conexión directa de los workers.

create table public.jobs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('ping', 'convert_cad', 'simulate', 'render_thumbnail', 'train_policy')),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'unsupported', 'needs_mapping', 'cancelled')),
  priority int not null default 0,
  attempts int not null default 0,
  max_attempts int not null default 3 check (max_attempts >= 1),
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  result jsonb,
  project_id uuid references public.projects (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready on public.jobs (kind, priority desc, run_after) where status = 'queued';

create trigger touch before update on public.jobs
  for each row execute function private.touch_updated_at();

-- Toma el siguiente trabajo disponible de los tipos indicados, sin bloquear a otros workers.
-- También recupera trabajos 'running' cuyo worker murió (lock vencido).
create or replace function private.claim_job(kinds text[], worker text, lock_timeout interval default interval '15 minutes')
returns setof public.jobs
language plpgsql
as $$
begin
  return query
  update public.jobs j
     set status = 'running', locked_by = worker, locked_at = now(), attempts = j.attempts + 1
   where j.id = (
     select id from public.jobs
      where kind = any (kinds)
        and attempts < max_attempts
        and ((status = 'queued' and run_after <= now())
          or (status = 'running' and locked_at < now() - lock_timeout))
      order by priority desc, run_after, id
      for update skip locked
      limit 1)
  returning j.*;
end;
$$;

-- Cierra un trabajo. Si falla y quedan intentos, lo reprograma con backoff exponencial.
create or replace function private.finish_job(job_id bigint, new_status text, job_result jsonb default null, error text default null)
returns void
language plpgsql
as $$
begin
  update public.jobs j
     set status = case
                    when new_status = 'failed' and j.attempts < j.max_attempts then 'queued'
                    else new_status
                  end,
         run_after = case
                       when new_status = 'failed' then now() + (interval '10 seconds' * power(2, j.attempts))
                       else j.run_after
                     end,
         result = coalesce(job_result, j.result),
         last_error = error,
         locked_by = null,
         locked_at = null
   where j.id = job_id;
  perform pg_notify('jobs_finished', job_id::text);
end;
$$;

create or replace function private.notify_job_created()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify('jobs_' || new.kind, new.id::text);
  return new;
end;
$$;
create trigger notify_created after insert on public.jobs
  for each row execute function private.notify_job_created();

revoke all on function private.claim_job(text[], text, interval), private.finish_job(bigint, text, jsonb, text) from public;
grant execute on function private.claim_job(text[], text, interval), private.finish_job(bigint, text, jsonb, text) to service_role;

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  requests int not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (user_id, day)
);

create table public.asset_access_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  asset_table text not null check (asset_table in ('robot_assets', 'component_assets', 'sim_artifact')),
  asset_id text not null,
  ttl_seconds int not null,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['jobs', 'ai_usage', 'asset_access_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage on all sequences in schema public to service_role;
