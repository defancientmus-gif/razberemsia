create table if not exists public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes jsonb not null default '[]'::jsonb,
  trash jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  name text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.user_state to authenticated;

drop policy if exists "Users can read own state" on public.user_state;
create policy "Users can read own state"
on public.user_state for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own state" on public.user_state;
create policy "Users can insert own state"
on public.user_state for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own state" on public.user_state;
create policy "Users can update own state"
on public.user_state for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own state" on public.user_state;
create policy "Users can delete own state"
on public.user_state for delete
using (auth.uid() = user_id);
