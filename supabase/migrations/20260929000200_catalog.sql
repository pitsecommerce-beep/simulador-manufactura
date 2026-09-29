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
