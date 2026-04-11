create table if not exists public.chat_rate_limits (
  bucket timestamptz not null,
  identity_key text not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (bucket, identity_key)
);

create index if not exists chat_rate_limits_updated_at_idx
  on public.chat_rate_limits (updated_at);

alter table public.chat_rate_limits enable row level security;

revoke all on public.chat_rate_limits from public, anon, authenticated;

create or replace function public.increment_chat_rate_limit(
  p_identity_key text,
  p_bucket_iso text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_bucket timestamptz;
  next_count integer;
begin
  normalized_bucket := date_trunc(
    'minute',
    coalesce(nullif(p_bucket_iso, '')::timestamptz, timezone('utc', now()))
  );

  insert into public.chat_rate_limits (bucket, identity_key, request_count, updated_at)
  values (normalized_bucket, p_identity_key, 1, timezone('utc', now()))
  on conflict (bucket, identity_key)
  do update set
    request_count = public.chat_rate_limits.request_count + 1,
    updated_at = timezone('utc', now())
  returning request_count into next_count;

  delete from public.chat_rate_limits
  where updated_at < timezone('utc', now()) - interval '2 days';

  return next_count;
end;
$$;

revoke all on function public.increment_chat_rate_limit(text, text) from public, anon, authenticated;
grant execute on function public.increment_chat_rate_limit(text, text) to service_role;
