-- ══════════════════════════════════════════════════════════════════════
-- Разберёмся — схема облака для своего Supabase (рабочий мак, Docker)
-- Собрал Гэвин (кодер Разберёмся) 09.11 по просьбе Антона.
-- Источник: supabase/migrations/* + то, что клиент (js/app.js) и функции
-- ai / push-sender реально читают и пишут. Повторный запуск безопасен.
--
-- Что нужно клиенту:
--   user_state         — ВСЁ состояние человека одной строкой (заметки, корзина,
--                        история, память ИИ, папки). Живой канал (realtime) на ней.
--   push_subscriptions — пуш-подписки браузера (пишет функция ai).
--   reminders          — серверная копия напоминаний (пишет ai, читает push-sender).
--   cron раз в минуту  — зовёт функцию push-sender.
-- Не нужно: таблица notes (миграция 20260525) — клиент в неё не пишет.
-- Триггеров в старом облаке не было: updated_at ставит сам клиент.
--
-- После запуска впиши два значения (секрет в файл не кладём):
--   insert into private.rz_config(key, value) values
--     ('push_sender_url',  'http://kong:8000/functions/v1/push-sender'),
--     ('service_role_key', '<SERVICE_ROLE_KEY твоего Supabase>')
--   on conflict (key) do update set value = excluded.value;
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. user_state ─────────────────────────────────────────────────────
-- В старом облаке таблица заведена в панели, CREATE в миграциях нет;
-- столбцы восстановлены по клиенту (app.js saveCloudNow / loadCloudData).
create table if not exists public.user_state (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  notes             jsonb       default '[]'::jsonb,
  trash             jsonb       default '[]'::jsonb,
  history           jsonb       default '[]'::jsonb,
  ai_memory         jsonb       default '[]'::jsonb,
  user_folders      jsonb       default '[]'::jsonb,
  tag_folders       jsonb       default '[]'::jsonb,
  folder_tombstones jsonb       default '{}'::jsonb,
  name              text        default '',
  updated_at        timestamptz default now()
);
-- на случай, если таблица уже есть со старым набором столбцов
alter table public.user_state add column if not exists notes             jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists trash             jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists history           jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists ai_memory         jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists user_folders      jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists tag_folders       jsonb       default '[]'::jsonb;
alter table public.user_state add column if not exists folder_tombstones jsonb       default '{}'::jsonb;
alter table public.user_state add column if not exists name              text        default '';
alter table public.user_state add column if not exists updated_at        timestamptz default now();

alter table public.user_state enable row level security;
drop policy if exists "Users manage own state" on public.user_state;
create policy "Users manage own state" on public.user_state
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.user_state to authenticated;

-- живой канал: old/new в событиях UPDATE (клиент слушает UPDATE по user_id)
alter table public.user_state replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_state') then
    alter publication supabase_realtime add table public.user_state;
  end if;
end $$;

-- ── 2. push_subscriptions ─────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz default now(),
  unique (user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "Users manage own push subscriptions" on public.push_subscriptions;
create policy "Users manage own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- ── 3. reminders ──────────────────────────────────────────────────────
create table if not exists public.reminders (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  note_id     text not null,
  note_title  text,
  note_body   text,
  remind_at   timestamptz not null,
  sent        boolean default false,
  created_at  timestamptz default now()
);
alter table public.reminders enable row level security;
drop policy if exists "Users manage own reminders" on public.reminders;
create policy "Users manage own reminders" on public.reminders
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.reminders to authenticated;
create index if not exists reminders_pending_idx on public.reminders (remind_at) where sent = false;

-- ── 4. cron: push-sender раз в минуту ─────────────────────────────────
-- Адрес и ключ — в закрытой таблице, а не в тексте задания cron.
create schema if not exists private;
revoke all on schema private from public;
create table if not exists private.rz_config (
  key   text primary key,
  value text not null
);
revoke all on private.rz_config from public;

create or replace function private.rz_call_push_sender()
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_url text;
  v_key text;
begin
  select value into v_url from private.rz_config where key = 'push_sender_url';
  select value into v_key from private.rz_config where key = 'service_role_key';
  if v_url is null or v_key is null then
    raise notice 'rz: push_sender_url или service_role_key не заданы в private.rz_config — пропуск';
    return;
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb
  );
end $$;
revoke all on function private.rz_call_push_sender() from public;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'rz: pg_cron или pg_net нет в этой базе — cron не поставлен (в Supabase они есть)';
    return;
  end if;
  create extension if not exists pg_net;
  create extension if not exists pg_cron;
  if exists (select 1 from cron.job where jobname = 'send-push-reminders') then
    perform cron.unschedule('send-push-reminders');
  end if;
  perform cron.schedule('send-push-reminders', '* * * * *', 'select private.rz_call_push_sender()');
end $$;
