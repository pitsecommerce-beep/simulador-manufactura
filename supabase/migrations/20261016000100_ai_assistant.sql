-- Fase 9 (parte C): asistente de IA. La api escribe las conversaciones y el consumo con la
-- clave secreta (service_role); los clientes solo leen conversaciones (política existente).

alter table public.ai_conversations
  -- Propuestas de escena: id, escena, advertencias y estado pending | accepted | discarded.
  add column proposals jsonb not null default '[]' check (jsonb_typeof(proposals) = 'array'),
  -- Lo que se muestra en el chat (texto del usuario y del asistente). `messages` guarda el
  -- historial del proveedor tal cual, para reenviarlo sin editar.
  add column transcript jsonb not null default '[]' check (jsonb_typeof(transcript) = 'array');

create index on public.ai_conversations (project_id, owner_id, updated_at desc);

-- Consumo diario (día UTC). Con p_requests > 0 primero comprueba los límites (por usuario y
-- global) y, si alguno se alcanzó, no registra nada. Los tokens se suman siempre: se informan
-- después de cada llamada al modelo. Devuelve el consumo resultante y qué límite se alcanzó.
create or replace function public.consume_ai_usage(
  p_user_id uuid,
  p_requests int,
  p_tokens_in bigint,
  p_tokens_out bigint,
  p_request_limit int,
  p_token_limit bigint,
  p_global_token_limit bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date := (now() at time zone 'utc')::date;
  u public.ai_usage;
  global_tokens bigint;
  blocked text := null;
begin
  -- Serializa por día: el tope global suma a todos los usuarios.
  perform pg_advisory_xact_lock(hashtext('ai_usage'), (d - date '2000-01-01'));

  insert into public.ai_usage (user_id, day) values (p_user_id, d)
    on conflict (user_id, day) do nothing;
  select * into u from public.ai_usage where user_id = p_user_id and day = d for update;
  select coalesce(sum(tokens_in + tokens_out), 0) into global_tokens
    from public.ai_usage where day = d;

  if p_requests > 0 then
    if p_request_limit is not null and u.requests + p_requests > p_request_limit then
      blocked := 'requests';
    elsif p_token_limit is not null and u.tokens_in + u.tokens_out >= p_token_limit then
      blocked := 'tokens';
    elsif p_global_token_limit is not null and global_tokens >= p_global_token_limit then
      blocked := 'global_tokens';
    end if;
  end if;

  if blocked is null then
    update public.ai_usage
      set requests = requests + greatest(p_requests, 0),
          tokens_in = tokens_in + greatest(p_tokens_in, 0),
          tokens_out = tokens_out + greatest(p_tokens_out, 0)
      where user_id = p_user_id and day = d
      returning * into u;
    global_tokens := global_tokens + greatest(p_tokens_in, 0) + greatest(p_tokens_out, 0);
  end if;

  return jsonb_build_object(
    'allowed', blocked is null,
    'blocked', blocked,
    'day', d,
    'requests', u.requests,
    'tokens', u.tokens_in + u.tokens_out,
    'global_tokens', global_tokens
  );
end;
$$;

revoke all on function public.consume_ai_usage(uuid, int, bigint, bigint, int, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.consume_ai_usage(uuid, int, bigint, bigint, int, bigint, bigint)
  to service_role;
