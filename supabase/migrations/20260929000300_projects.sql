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
