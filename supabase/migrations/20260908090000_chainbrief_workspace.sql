-- ChainBrief authenticated workspace: saved briefs, public share links, and watchlists.
-- Run this migration once in the Supabase SQL editor before enabling the new workspace UI.

create extension if not exists pgcrypto;

create table if not exists public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 120),
  query text not null check (char_length(query) between 2 and 500),
  identity_hint text not null default '' check (char_length(identity_hint) <= 500),
  language text not null check (language in ('en', 'vi')),
  result jsonb not null,
  report_text text not null,
  is_public boolean not null default false,
  public_slug text unique check (public_slug is null or public_slug ~ '^[A-Za-z0-9_-]{20,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists briefs_user_created_idx on public.briefs (user_id, created_at desc);
create index if not exists briefs_public_slug_idx on public.briefs (public_slug) where is_public = true;

create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  symbol text check (symbol is null or char_length(symbol) <= 20),
  official_domain text check (official_domain is null or char_length(official_domain) <= 255),
  blockchain text check (blockchain is null or char_length(blockchain) <= 80),
  contract_address text check (contract_address is null or char_length(contract_address) <= 160),
  last_brief_id uuid references public.briefs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists watchlist_identity_unique
  on public.watchlist (user_id, lower(name), coalesce(contract_address, ''), coalesce(official_domain, ''));
create index if not exists watchlist_user_created_idx on public.watchlist (user_id, created_at desc);

create or replace function public.set_chainbrief_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists briefs_set_updated_at on public.briefs;
create trigger briefs_set_updated_at before update on public.briefs
for each row execute function public.set_chainbrief_updated_at();

drop trigger if exists watchlist_set_updated_at on public.watchlist;
create trigger watchlist_set_updated_at before update on public.watchlist
for each row execute function public.set_chainbrief_updated_at();

alter table public.briefs enable row level security;
alter table public.watchlist enable row level security;

create or replace function public.get_shared_brief(p_slug text)
returns table (
  id uuid,
  title text,
  language text,
  result jsonb,
  report_text text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.title, b.language, b.result, b.report_text, b.created_at, b.updated_at
  from public.briefs b
  where b.is_public = true and b.public_slug = p_slug
  limit 1;
$$;

drop policy if exists "briefs_select_owner_or_public" on public.briefs;
drop policy if exists "briefs_select_owner" on public.briefs;
create policy "briefs_select_owner"
on public.briefs for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "briefs_insert_owner" on public.briefs;
create policy "briefs_insert_owner"
on public.briefs for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "briefs_update_owner" on public.briefs;
create policy "briefs_update_owner"
on public.briefs for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "briefs_delete_owner" on public.briefs;
create policy "briefs_delete_owner"
on public.briefs for delete to authenticated
using (auth.uid() = user_id);

drop policy if exists "watchlist_select_owner" on public.watchlist;
create policy "watchlist_select_owner"
on public.watchlist for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "watchlist_insert_owner" on public.watchlist;
create policy "watchlist_insert_owner"
on public.watchlist for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "watchlist_update_owner" on public.watchlist;
create policy "watchlist_update_owner"
on public.watchlist for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "watchlist_delete_owner" on public.watchlist;
create policy "watchlist_delete_owner"
on public.watchlist for delete to authenticated
using (auth.uid() = user_id);

revoke all on public.briefs from anon, authenticated;
revoke all on public.watchlist from anon, authenticated;
grant select, insert, update, delete on public.briefs to authenticated;
grant select, insert, update, delete on public.watchlist to authenticated;
revoke all on function public.get_shared_brief(text) from public;
grant execute on function public.get_shared_brief(text) to anon, authenticated;
