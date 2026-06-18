# Настройка нового проекта: GitHub Pages + Supabase

> По факту устройства «Разберёмся». Повтори шаги в новом репозитории (БУ.шка / CRM).
> Принцип: статический фронт на GitHub Pages, вся серверная логика и секреты — в Supabase.

---

## A. GITHUB — хостинг + деплой

1. **Создать репо** на GitHub (публичный, если Pages бесплатный план). Запушить код в `main`.
2. **Включить GitHub Pages:** Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
   Сайт поедет на `https://<user>.github.io/<repo>/`.
3. **Деплой одной командой — `deploy.sh`** (скопировать из «Разберёмся», адаптировать префикс кэша):
   - bump версии кэша в `sw.js` (`const CACHE='xx-vN'` → N+1),
   - `node --check` фронта,
   - обновить строку деплоя в `texts/SNAPSHOT.md`,
   - `git add` ТОЛЬКО нужных файлов (sw.js, index.html, js/app.js, manifest.json, SNAPSHOT),
   - commit + `git push origin HEAD:main`.
   Pages пересобирается из `main` сам за ~1 мин.
4. **Перед push** приложение может пушить idea-коммиты само → часто нужен `git pull --rebase` перед своим push.

---

## B. SUPABASE — backend, auth, секреты

### B1. Проект и клиент
1. Создать проект на supabase.com. Взять **Project URL** и **publishable/anon key** (Settings → API).
2. В клиенте (`js/app.js`, первые строки):
   ```js
   const SUPABASE_URL='https://<ref>.supabase.co';
   const SUPABASE_ANON_KEY='sb_publishable_...';   // anon/publishable — НЕ service_role!
   const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
     auth:{detectSessionInUrl:true,persistSession:true,autoRefreshToken:true,flowType:'pkce'}
   });
   ```
3. **supabase-js вендорить локально** (`js/vendor/supabase.js`) и кэшировать в SW — CDN без `crossorigin` ломает офлайн.

### B2. Auth (вход без пароля)
- Authentication → Providers: **Email** включён, **magic link / OTP**. Пароль не нужен (`flowType:'pkce'`, `detectSessionInUrl`).
- Authentication → URL Configuration: добавить Site URL = адрес GitHub Pages (для redirect магической ссылки).

### B3. База данных + RLS (главная таблица состояния)
SQL Editor → выполнить:
```sql
create table if not exists user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes jsonb default '[]'::jsonb,
  trash jsonb default '[]'::jsonb,
  history jsonb default '[]'::jsonb,
  ai_memory jsonb default '[]'::jsonb,
  user_folders jsonb default '[]'::jsonb,
  tag_folders jsonb default '[]'::jsonb,
  folder_tombstones jsonb default '{}'::jsonb,
  name text default '',
  updated_at timestamptz default now()
);
alter table user_state enable row level security;
create policy "Users manage own state" on user_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
**RLS обязателен** — каждый видит только свою строку. Никогда не отключать.
(Под свой продукт меняешь набор jsonb-колонок. Клиент делает `upsert({user_id, ...поля, updated_at}, {onConflict:'user_id'})`.)

### B4. Edge Functions (вся AI/серверная логика)
1. Поставить CLI: `brew install supabase/tap/supabase`. Залогиниться: `supabase login`.
2. Связать репо с проектом: `supabase link --project-ref <ref>` (создаёт `supabase/.temp/`).
3. Функция лежит в `supabase/functions/<name>/index.ts` (Deno, импорт `https://esm.sh/@supabase/supabase-js@2`).
4. **Деплой функции (отдельно от фронта!):** `supabase functions deploy <name> --no-verify-jwt` (Docker не нужен — грузит исходник). Фиксировать факт деплоя в `SNAPSHOT.md`.
5. **CORS** в начале функции (иначе браузер заблокирует):
   ```js
   const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json'};
   // в обработчике: if(req.method==='OPTIONS') return new Response(null,{headers:CORS});
   ```
6. Функция сама проверяет юзера по токену (Authorization: Bearer) через `sb.auth.getUser()` — клиент шлёт `access_token` из сессии.

### B5. Секреты Edge Functions (НЕ в клиент!)
Dashboard → Project Settings → **Edge Functions → Secrets** (или `supabase secrets set KEY=value`):
- `ANTHROPIC_API_KEY` — ключ Claude (api.anthropic.com).
- `ANTHROPIC_MODEL` (опц.) — напр. `claude-haiku-4-5-20251001`.
- `GROQ_API_KEY` — резервный STT (Whisper).
- `YANDEX_STT_KEY` — основной STT (русский).
- `GITHUB_TOKEN` + `GITHUB_REPO` — если функция коммитит в репо (напр. идеи).
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — обычно подставляются автоматически.
> Если AI молча падает — первым делом проверить баланс/живость `ANTHROPIC_API_KEY` на console.anthropic.com.

### B6. (Опц.) Realtime — мгновенная синхра между устройствами
```sql
alter table user_state replica identity full;
alter publication supabase_realtime add table user_state;
```

### B7. (Опц.) Push-уведомления
Таблицы `push_subscriptions` и `reminders` с RLS (`auth.uid()=user_id`), отдельная функция `push-sender` + VAPID-ключи в секретах.

---

## C. Жёсткие правила (одинаковы для всех проектов)
- API/service-ключи — НИКОГДА в клиент. Только anon/publishable в клиенте; секреты — в Edge Secrets.
- RLS не отключать.
- AI/секретные вызовы — только через Edge Function.
- Внешние либы вендорить локально.
- Фронт — через `deploy.sh`; Edge — отдельно, фиксировать в SNAPSHOT.

Связано: [[REPO_BLUEPRINT.md]] (костяк репо и память), [[TECH_PROMPT.md]] (душа системы).
