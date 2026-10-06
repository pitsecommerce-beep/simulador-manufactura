-- Fase 2a: datos de ficha técnica tal como vienen en catalog/*.json, con su procedencia.
-- Regla: lo no publicado es NULL. Escritura solo con el seed manual (SQL Editor) o service_role.

alter table public.robots
  add column application text,
  add column typical_application text,
  add column product_page text,
  add column data_status text check (data_status in ('ok', 'partial')),
  add column notes text[];

alter table public.robot_specs
  add column armload_kg numeric check (armload_kg >= 0),
  add column workspace_diameter_mm numeric check (workspace_diameter_mm > 0),
  add column max_tcp_speed_m_s numeric check (max_tcp_speed_m_s > 0),
  add column payload_note text,
  -- Texto original cuando el número de ejes no es un entero publicado (ej. "3 o 4").
  add column axes_note text,
  add column repeatability jsonb check (repeatability is null or jsonb_typeof(repeatability) = 'object'),
  add column extra jsonb check (extra is null or jsonb_typeof(extra) = 'object'),
  add column notes text[];

comment on column public.robot_specs.axis_limits is
  '[{ "axis": 1, "min": -170, "max": 170, "unit": "deg"|"mm", "max_speed": 250, "speed_unit": "deg/s"|"m/s", "note": null }]; lo no publicado es null';
comment on column public.robot_specs.provenance is
  '{ "<campo>": { "file", "page", "section", "doc_id", "revision", "url", "accessed_at", "license_terms" } | null }; null = la ficha no indica la fuente';

-- Documentos que respaldan los datos (fichas, especificaciones). Los CAD y planos van en
-- robot_assets / component_assets cuando existan en el bucket (fase 2b).
create table public.robot_documents (
  id uuid primary key default gen_random_uuid(),
  robot_id uuid not null references public.robots (id) on delete cascade,
  path text not null,
  kind text not null,
  doc_id text,
  revision text,
  doc_date date,
  title text,
  url text,
  library_page text,
  accessed_at timestamptz,
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes >= 0),
  license_terms text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (robot_id, path)
);

create table public.component_documents (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.components (id) on delete cascade,
  path text not null,
  kind text not null,
  title text,
  url text,
  accessed_at timestamptz,
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes >= 0),
  license_terms text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (component_id, path)
);

do $$
declare t text;
begin
  foreach t in array array['robot_documents', 'component_documents']
  loop
    execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy "catalogo legible por autenticados" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

create index on public.robot_documents (robot_id);
create index on public.component_documents (component_id);

alter table public.components
  add column type text,
  add column notes text[];
