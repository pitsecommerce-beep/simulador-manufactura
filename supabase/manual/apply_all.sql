-- ============================================================================
-- ARCHIVO GENERADO por packages/db/src/bundle.ts (pnpm db:sql). No lo edites a mano.
-- Pégalo completo en Supabase > SQL Editor y pulsa Run. Es idempotente: solo aplica
-- las migraciones que falten y deja constancia en app_migrations.applied.
-- ============================================================================

create schema if not exists app_migrations;
create table if not exists app_migrations.applied (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- 20260929000100_base.sql
do $do_20260929000100$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(72110931);
  select checksum into prev from app_migrations.applied where version = '20260929000100';
  if prev is null then
    execute $mig_20260929000100$
-- Base: esquemas auxiliares y funciones comunes.
-- Convención: todas las tablas de `public` tienen RLS. Las funciones auxiliares de
-- políticas viven en `private`, que no se expone por la Data API de Supabase.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Mantiene updated_at al día.
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Anon no debe tocar nada en public: todo el simulador requiere sesión.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
$mig_20260929000100$;
    insert into app_migrations.applied (version, name, checksum)
      values ('20260929000100', '20260929000100_base.sql', 'c0def8597bf204b2d22ded487ddc3a1a303104410567151e3c3cea9e26478220');
    raise notice 'aplicada %', '20260929000100_base.sql';
  elsif prev <> 'c0def8597bf204b2d22ded487ddc3a1a303104410567151e3c3cea9e26478220' then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', '20260929000100_base.sql';
  else
    raise notice 'ya estaba %', '20260929000100_base.sql';
  end if;
end
$do_20260929000100$;

-- 20260929000200_catalog.sql
do $do_20260929000200$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(72110931);
  select checksum into prev from app_migrations.applied where version = '20260929000200';
  if prev is null then
    execute $mig_20260929000200$
-- Catálogo de robots, componentes y tipos de objeto paramétricos.
-- Regla: cualquier dato de ficha técnica que no esté publicado se guarda como NULL.
-- Nunca 0 ni un valor estimado. Cada dato lleva su procedencia en `provenance`.
-- Lectura: usuarios autenticados. Escritura: solo service_role (script de ingesta).

create table public.robots (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  manufacturer text not null,
  model text not null,
  family text,
  -- Determina cómo se modela la cinemática (URDF serie, delta analítica, etc.)
  kinematic_type text check (kinematic_type in ('serial', 'parallel_linkage', 'delta', 'scara')),
  is_synthetic boolean not null default false,
  status text not null default 'active' check (status in ('active', 'draft', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.robot_variants (
  id uuid primary key default gen_random_uuid(),
  robot_id uuid not null references public.robots (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9.-]*$'),
  variant_code text not null,
  reach_mm numeric check (reach_mm > 0),
  payload_kg numeric check (payload_kg >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (robot_id, variant_code)
);
create index on public.robot_variants (robot_id);

create table public.robot_specs (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null unique references public.robot_variants (id) on delete cascade,
  axes_count int check (axes_count between 1 and 12),
  reach_mm numeric check (reach_mm > 0),
  payload_kg numeric check (payload_kg >= 0),
  weight_kg numeric check (weight_kg > 0),
  repeatability_mm numeric check (repeatability_mm >= 0),
  mounting_allowed text[],
  ip_rating text,
  controller text,
  -- [{ "axis": 1, "min_deg": -170, "max_deg": 170, "max_speed_dps": 250 }, ...]; campos ausentes = null
  axis_limits jsonb check (axis_limits is null or jsonb_typeof(axis_limits) = 'array'),
  -- [{ "value_s": 0.52, "condition": "25/305/25 mm, 1 kg", "source": {...} }]
  published_cycle_times jsonb check (published_cycle_times is null or jsonb_typeof(published_cycle_times) = 'array'),
  -- { "<campo>": { "source_file": "datasheet.pdf", "page": 2, "retrieved_at": "2026-09-29" } }
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Metadatos de archivos. La fila guarda fuente y términos de uso de cada archivo.
create table public.robot_assets (
  id uuid primary key default gen_random_uuid(),
  robot_id uuid not null references public.robots (id) on delete cascade,
  variant_id uuid references public.robot_variants (id) on delete cascade,
  kind text not null check (kind in ('original_cad', 'derived_glb', 'urdf', 'datasheet', 'drawing', 'thumbnail', 'link_map')),
  bucket text not null check (bucket in ('catalog-originals', 'catalog-derived')),
  path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes >= 0),
  content_type text,
  compression text check (compression in ('gzip')),
  link_name text,
  source_url text,
  license_terms text,
  terms_url text,
  retrieved_at date,
  usage_restrictions text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, path),
  -- Originales, fichas y planos solo pueden vivir en el bucket privado sin acceso de cliente.
  check ((kind in ('original_cad', 'datasheet', 'drawing', 'link_map')) = (bucket = 'catalog-originals'))
);
create index on public.robot_assets (variant_id);
create index on public.robot_assets (robot_id);

create table public.components (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9.-]*$'),
  manufacturer text,
  model text not null,
  category text not null,
  is_synthetic boolean not null default false,
  status text not null default 'active' check (status in ('active', 'draft', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.component_specs (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null unique references public.components (id) on delete cascade,
  specs jsonb not null default '{}' check (jsonb_typeof(specs) = 'object'),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.component_assets (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.components (id) on delete cascade,
  kind text not null check (kind in ('original_cad', 'derived_glb', 'datasheet', 'drawing', 'thumbnail')),
  bucket text not null check (bucket in ('catalog-originals', 'catalog-derived')),
  path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes >= 0),
  content_type text,
  compression text check (compression in ('gzip')),
  source_url text,
  license_terms text,
  terms_url text,
  retrieved_at date,
  usage_restrictions text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, path),
  check ((kind in ('original_cad', 'datasheet', 'drawing')) = (bucket = 'catalog-originals'))
);
create index on public.component_assets (component_id);

-- Objetos paramétricos generados por código (pallets, cajas, bandas, vallas, personas...).
create table public.object_types (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  category text not null,
  param_schema jsonb not null default '{}' check (jsonb_typeof(param_schema) = 'object'),
  presets jsonb not null default '[]' check (jsonb_typeof(presets) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['robots', 'robot_variants', 'robot_specs', 'robot_assets', 'components',
                           'component_specs', 'component_assets', 'object_types']
  loop
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create policy "catalogo legible por autenticados" on public.robots for select to authenticated using (true);
create policy "catalogo legible por autenticados" on public.robot_variants for select to authenticated using (true);
create policy "catalogo legible por autenticados" on public.robot_specs for select to authenticated using (true);
create policy "catalogo legible por autenticados" on public.components for select to authenticated using (true);
create policy "catalogo legible por autenticados" on public.component_specs for select to authenticated using (true);
create policy "catalogo legible por autenticados" on public.object_types for select to authenticated using (true);

-- Los metadatos de archivos originales (ruta interna, bucket privado) no se exponen al cliente.
-- El cliente solo ve derivados; la URL firmada la emite la API.
create policy "solo derivados visibles" on public.robot_assets for select to authenticated
  using (bucket = 'catalog-derived');
create policy "solo derivados visibles" on public.component_assets for select to authenticated
  using (bucket = 'catalog-derived');
$mig_20260929000200$;
    insert into app_migrations.applied (version, name, checksum)
      values ('20260929000200', '20260929000200_catalog.sql', 'dcfe4f9344b11600f6d471a48797b3a6d585c0bf027f985620bf7f9c60a9bbc1');
    raise notice 'aplicada %', '20260929000200_catalog.sql';
  elsif prev <> 'dcfe4f9344b11600f6d471a48797b3a6d585c0bf027f985620bf7f9c60a9bbc1' then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', '20260929000200_catalog.sql';
  else
    raise notice 'ya estaba %', '20260929000200_catalog.sql';
  end if;
end
$do_20260929000200$;

-- 20260929000300_projects.sql
do $do_20260929000300$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(72110931);
  select checksum into prev from app_migrations.applied where version = '20260929000300';
  if prev is null then
    execute $mig_20260929000300$
-- Datos de usuario: perfiles, proyectos compartibles y todo lo que cuelga de un proyecto.
-- Acceso: propietario y miembros. Lectura: owner, viewer, editor. Escritura: owner, editor.
-- Borrar el proyecto y gestionar miembros: solo el propietario.
-- Las tablas hijas llevan project_id (con FK compuesta a su padre) para que las
-- políticas sean una sola llamada a una función, sin cadenas de joins.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  description text check (length(description) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.projects (owner_id);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('viewer', 'editor')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index on public.project_members (user_id);

-- Funciones de acceso. SECURITY DEFINER para que las políticas no se llamen a sí mismas.
create or replace function private.is_project_owner(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.projects p where p.id = pid and p.owner_id = auth.uid());
$$;

create or replace function private.is_project_member(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.project_members m where m.project_id = pid and m.user_id = auth.uid());
$$;

create or replace function private.can_read_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.projects p where p.id = pid and p.owner_id = auth.uid())
      or exists (select 1 from public.project_members m where m.project_id = pid and m.user_id = auth.uid());
$$;

create or replace function private.can_edit_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.projects p where p.id = pid and p.owner_id = auth.uid())
      or exists (select 1 from public.project_members m
                 where m.project_id = pid and m.user_id = auth.uid() and m.role = 'editor');
$$;

revoke all on function private.is_project_owner(uuid), private.is_project_member(uuid), private.can_read_project(uuid), private.can_edit_project(uuid) from public;
grant execute on function private.is_project_owner(uuid), private.is_project_member(uuid), private.can_read_project(uuid), private.can_edit_project(uuid)
  to authenticated, service_role;

-- El propietario de un proyecto no se puede cambiar desde una sesión de usuario.
create or replace function private.lock_project_owner()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id and auth.uid() is not null then
    raise exception 'owner_id no se puede modificar';
  end if;
  return new;
end;
$$;
create trigger lock_owner before update on public.projects
  for each row execute function private.lock_project_owner();

create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version int not null default 1 check (version >= 1),
  name text,
  scene jsonb not null default '{}' check (jsonb_typeof(scene) = 'object'),
  is_current boolean not null default true,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  unique (project_id, version)
);
create unique index layouts_one_current on public.layouts (project_id) where is_current;

create table public.object_instances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  layout_id uuid not null,
  object_type_id uuid references public.object_types (id),
  robot_variant_id uuid references public.robot_variants (id),
  component_id uuid references public.components (id),
  name text,
  params jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),
  -- { "position": [x,y,z] (mm), "rotation": [rx,ry,rz] (rad) }
  transform jsonb not null default '{}' check (jsonb_typeof(transform) = 'object'),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (layout_id, project_id) references public.layouts (id, project_id) on delete cascade,
  -- Exactamente un origen: objeto paramétrico, robot o componente.
  check (num_nonnulls(object_type_id, robot_variant_id, component_id) = 1)
);
create index on public.object_instances (layout_id);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  layout_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (layout_id, project_id) references public.layouts (id, project_id) on delete cascade
);

-- Corridas y métricas: las escriben la API y los workers (service_role). El cliente solo lee.
create table public.simulation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  scenario_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  mode text not null default 'accelerated' check (mode in ('accelerated', 'realtime')),
  replications int not null default 1 check (replications between 1 and 10000),
  seed bigint,
  engine_version text,
  events_path text,
  error text,
  created_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (scenario_id, project_id) references public.scenarios (id, project_id) on delete cascade
);

create table public.simulation_metrics (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  run_id uuid not null,
  replication int, -- null = agregado de todas las réplicas
  metric text not null,
  scope text not null default 'line',
  value numeric,
  min numeric,
  mean numeric,
  max numeric,
  p5 numeric,
  p95 numeric,
  unit text,
  -- Todo lo que depende de fichas técnicas es estimación salvo que se indique lo contrario.
  is_estimate boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (run_id, project_id) references public.simulation_runs (id, project_id) on delete cascade
);
create index on public.simulation_metrics (run_id);

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text,
  model text,
  title text,
  messages jsonb not null default '[]' check (jsonb_typeof(messages) = 'array'),
  tool_calls jsonb not null default '[]' check (jsonb_typeof(tool_calls) = 'array'),
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.ai_conversations (owner_id);
create index on public.ai_conversations (project_id);

create table public.generated_code (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  layout_id uuid,
  entity_id text,
  target text not null check (target in ('rapid', 'python', 'arduino')),
  source text not null,
  source_map jsonb not null default '[]' check (jsonb_typeof(source_map) = 'array'),
  generator text not null default 'template' check (generator in ('template', 'ai')),
  ai_conversation_id uuid references public.ai_conversations (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (layout_id, project_id) references public.layouts (id, project_id) on delete cascade
);
create index on public.generated_code (project_id);

-- Triggers, RLS y permisos base
do $$
declare t text;
begin
  foreach t in array array['profiles', 'projects', 'layouts', 'object_instances', 'scenarios',
                           'simulation_runs', 'ai_conversations', 'generated_code']
  loop
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
  end loop;
  foreach t in array array['profiles', 'projects', 'project_members', 'layouts', 'object_instances', 'scenarios',
                           'simulation_runs', 'simulation_metrics', 'ai_conversations', 'generated_code']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- profiles: el equipo se ve entre sí (para compartir proyectos); cada quien edita el suyo.
grant select, update (display_name) on public.profiles to authenticated;
create policy "perfiles visibles al equipo" on public.profiles for select to authenticated using (true);
create policy "editar perfil propio" on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- projects
grant select, insert, update, delete on public.projects to authenticated;
-- La comprobación del propietario va sobre la fila (no vía función) para que
-- INSERT ... RETURNING funcione: la función no ve la fila recién insertada.
create policy "leer proyecto" on public.projects for select to authenticated
  using (owner_id = auth.uid() or private.is_project_member(id));
create policy "crear proyecto propio" on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
create policy "editar proyecto" on public.projects for update to authenticated
  using (private.can_edit_project(id)) with check (private.can_edit_project(id));
create policy "borrar proyecto propio" on public.projects for delete to authenticated
  using (owner_id = auth.uid());

-- project_members: visibles para quien puede leer el proyecto; los gestiona el propietario.
grant select, insert, update, delete on public.project_members to authenticated;
create policy "ver miembros" on public.project_members for select to authenticated
  using (private.can_read_project(project_id));
create policy "propietario agrega miembros" on public.project_members for insert to authenticated
  with check (private.is_project_owner(project_id) and user_id <> auth.uid());
create policy "propietario cambia roles" on public.project_members for update to authenticated
  using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));
create policy "propietario quita miembros o miembro sale" on public.project_members for delete to authenticated
  using (private.is_project_owner(project_id) or user_id = auth.uid());

-- Tablas editables por editores del proyecto
do $$
declare t text;
begin
  foreach t in array array['layouts', 'object_instances', 'scenarios', 'generated_code']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy "leer" on public.%I for select to authenticated using (private.can_read_project(project_id))', t);
    execute format('create policy "crear" on public.%I for insert to authenticated with check (private.can_edit_project(project_id))', t);
    execute format('create policy "editar" on public.%I for update to authenticated using (private.can_edit_project(project_id)) with check (private.can_edit_project(project_id))', t);
    execute format('create policy "borrar" on public.%I for delete to authenticated using (private.can_edit_project(project_id))', t);
  end loop;
end $$;

-- Corridas y métricas: solo lectura para miembros.
grant select on public.simulation_runs, public.simulation_metrics to authenticated;
create policy "leer" on public.simulation_runs for select to authenticated using (private.can_read_project(project_id));
create policy "leer" on public.simulation_metrics for select to authenticated using (private.can_read_project(project_id));

-- Conversaciones de IA: las escribe la API. Las lee su autor, o los miembros si pertenecen a un proyecto.
grant select on public.ai_conversations to authenticated;
create policy "leer conversaciones" on public.ai_conversations for select to authenticated
  using (owner_id = auth.uid() or (project_id is not null and private.can_read_project(project_id)));
$mig_20260929000300$;
    insert into app_migrations.applied (version, name, checksum)
      values ('20260929000300', '20260929000300_projects.sql', 'fce968c89da19cc9690b0dbde72525bf5b8fd645c5892916a7882bc285d3ce51');
    raise notice 'aplicada %', '20260929000300_projects.sql';
  elsif prev <> 'fce968c89da19cc9690b0dbde72525bf5b8fd645c5892916a7882bc285d3ce51' then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', '20260929000300_projects.sql';
  else
    raise notice 'ya estaba %', '20260929000300_projects.sql';
  end if;
end
$do_20260929000300$;

-- 20260929000400_internal.sql
do $do_20260929000400$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(72110931);
  select checksum into prev from app_migrations.applied where version = '20260929000400';
  if prev is null then
    execute $mig_20260929000400$
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
$mig_20260929000400$;
    insert into app_migrations.applied (version, name, checksum)
      values ('20260929000400', '20260929000400_internal.sql', 'f71f32a07925c07fa56965b13141f51ddc31d1529394ffc9d2cd36c3a9546ace');
    raise notice 'aplicada %', '20260929000400_internal.sql';
  elsif prev <> 'f71f32a07925c07fa56965b13141f51ddc31d1529394ffc9d2cd36c3a9546ace' then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', '20260929000400_internal.sql';
  else
    raise notice 'ya estaba %', '20260929000400_internal.sql';
  end if;
end
$do_20260929000400$;

-- 20260929000500_storage.sql
do $do_20260929000500$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(72110931);
  select checksum into prev from app_migrations.applied where version = '20260929000500';
  if prev is null then
    execute $mig_20260929000500$
-- Buckets de Storage, todos privados.
-- No se crean políticas sobre storage.objects para estos buckets: sin política no hay
-- acceso de cliente. La API emite URLs firmadas de corta duración (service_role) solo
-- para catalog-derived y sim-artifacts. catalog-originals no tiene ruta de descarga.
--
-- Límite por archivo: 50 MB (máximo del plan Free de Supabase). Los STEP se suben
-- comprimidos con gzip por el script de ingesta.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('catalog-originals', 'catalog-originals', false, 52428800),
  ('catalog-derived', 'catalog-derived', false, 52428800),
  ('sim-artifacts', 'sim-artifacts', false, 52428800)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;
$mig_20260929000500$;
    insert into app_migrations.applied (version, name, checksum)
      values ('20260929000500', '20260929000500_storage.sql', '2528eb5a314e0fdd61a23d3c8c6cc9e93f45ef2dcb2b7d229d564865f5e6ac6e');
    raise notice 'aplicada %', '20260929000500_storage.sql';
  elsif prev <> '2528eb5a314e0fdd61a23d3c8c6cc9e93f45ef2dcb2b7d229d564865f5e6ac6e' then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', '20260929000500_storage.sql';
  else
    raise notice 'ya estaba %', '20260929000500_storage.sql';
  end if;
end
$do_20260929000500$;

select version, name, applied_at from app_migrations.applied order by version;
