-- Проверка razberemsya-skhema.sql на ЧИСТОМ Postgres 15 (без Supabase).
-- Запуск: psql -v ON_ERROR_STOP=1 -d <пустая база> -f proverka-skhemy.sql
-- Заглушки ниже повторяют то, что в Supabase уже есть: auth.users, auth.uid(), роль authenticated.

\set ON_ERROR_STOP 1

-- ── заглушки Supabase ──
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to authenticated;
grant execute on function auth.uid() to authenticated;

-- ── схема, дважды (повторный запуск не должен падать) ──
\i razberemsya-skhema.sql
\i razberemsya-skhema.sql

-- ── данные двух людей ──
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
-- так пишет клиент: upsert одной строки
insert into public.user_state (user_id, notes, trash, history, ai_memory, user_folders, tag_folders, name, updated_at, folder_tombstones)
values ('11111111-1111-1111-1111-111111111111', '[{"id":"n1","title":"молоко"}]', '[]', '[]', '[]', '[]', '[]', 'Аня', now(), '{}')
on conflict (user_id) do update set notes = excluded.notes, updated_at = excluded.updated_at;
insert into public.reminders (user_id, note_id, note_title, remind_at)
values ('11111111-1111-1111-1111-111111111111', 'n1', 'молоко', now() + interval '1 hour');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('11111111-1111-1111-1111-111111111111', 'https://push.example/1', 'k', 'a');

-- чужую строку записать нельзя
do $$ begin
  begin
    insert into public.user_state (user_id) values ('22222222-2222-2222-2222-222222222222');
    raise exception 'ПРОВАЛ: записал чужую строку user_state';
  exception when insufficient_privilege then null;
  end;
end $$;

-- второй человек не видит ничего первого
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from public.user_state) <> 0 then raise exception 'ПРОВАЛ: видит чужой user_state'; end if;
  if (select count(*) from public.reminders) <> 0 then raise exception 'ПРОВАЛ: видит чужие reminders'; end if;
  if (select count(*) from public.push_subscriptions) <> 0 then raise exception 'ПРОВАЛ: видит чужие подписки'; end if;
end $$;

-- первый видит своё, опрос по updated_at работает
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$ begin
  if (select notes->0->>'title' from public.user_state) <> 'молоко' then raise exception 'ПРОВАЛ: своя строка не читается'; end if;
  if (select updated_at from public.user_state) is null then raise exception 'ПРОВАЛ: нет updated_at'; end if;
end $$;
reset role;

-- живой канал и закрытая таблица
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='user_state') then
    raise exception 'ПРОВАЛ: user_state не в публикации realtime'; end if;
  if (select relreplident from pg_class where oid = 'public.user_state'::regclass) <> 'f' then
    raise exception 'ПРОВАЛ: нет replica identity full'; end if;
  if has_table_privilege('authenticated', 'private.rz_config', 'select') then
    raise exception 'ПРОВАЛ: обычный пользователь читает private.rz_config'; end if;
end $$;

-- без адреса функция cron не падает, а пропускает
select private.rz_call_push_sender();

\echo 'ВСЁ ЗЕЛЁНОЕ: схема встаёт дважды, чужое не видно, realtime и закрытая таблица на месте'
