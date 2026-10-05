-- SOLO PARA TESTS. Emula en un Postgres limpio las piezas de Supabase de las que
-- dependen las migraciones: roles, esquema auth (users, uid(), role(), jwt()) y
-- esquema storage (buckets, objects). Nunca se aplica en Supabase real.

-- Los roles son globales del servidor y varios tests crean bases en paralelo:
-- si otro proceso ya creó el rol, se ignora el error.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin noinherit%s', r,
                       case when r = 'service_role' then ' bypassrls' else '' end);
      end if;
    exception when duplicate_object or unique_violation then
      null;
    end;
  end loop;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Privilegios por defecto como en Supabase: todo concedido, RLS decide.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    auth.jwt() ->> 'sub'
  )::uuid;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    auth.jwt() ->> 'role'
  );
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
