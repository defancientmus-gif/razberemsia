# Runbook: пуши и деплой

> Практический процесс по факту «Разберёмся». Три независимые «полосы» деплоя — не путать.

---

## Три полосы деплоя (важно: они РАЗДЕЛЬНЫЕ)

| Что меняешь | Чем деплоить | Куда едет |
|---|---|---|
| Фронт (`index.html`, `js/app.js`, `sw.js`, `manifest.json`) | `./deploy.sh "описание"` | GitHub Pages (main) |
| Мозг агента (`supabase/functions/ai/index.ts` и др.) | `supabase functions deploy <name> --no-verify-jwt` | Supabase Edge |
| Схема БД (`supabase/migrations/*.sql`) | Dashboard → SQL Editor (вставить и Run) | Supabase Postgres |

**⚠️ Главная грабля:** `deploy.sh` коммитит ТОЛЬКО фронт. **Edge-функции и доки `texts/*.md` он НЕ коммитит.**
Поэтому правка Edge может уехать на прод, но остаться вне гита (мы на этом попались с GUIDE).
После деплоя Edge — **руками** `git add supabase/functions/... && git commit && push`.

---

## A. Деплой фронта — `./deploy.sh "описание правки"`

Что делает скрипт по шагам:
1. **Bump кэша** в `sw.js`: `rz-vN` → `rz-v(N+1)` (единственный источник версии).
2. **`node --check js/app.js`** — синтаксис; при ошибке деплой отменяется.
3. Обновляет строку «Последний деплой» в `SNAPSHOT.md`.
4. `git add` ТОЛЬКО: `sw.js`, `SNAPSHOT.md`, и из {`index.html`,`js/app.js`,`manifest.json`} те, что изменены.
5. `git commit -m "описание"`.
6. `git push origin HEAD:main`.

GitHub Pages пересобирается из `main` сам за ~1 минуту.

**Перед deploy.sh (ручные проверки):**
```bash
node --check js/app.js          # синтаксис (скрипт тоже делает)
git diff --check                # нет ли битых пробелов/маркеров конфликта
node scripts/smoke-agent-router.mjs   # ОБЯЗАТЕЛЬНО после правок агента/роутера/промпта
```

---

## B. Главная грабля пушей: remote убегает вперёд

Приложение САМО коммитит idea-файлы в репозиторий (через `save_idea` Edge → GitHub).
Поэтому твой `git push` часто получает **`! [rejected] (fetch first)`** — на origin появились коммиты, которых нет локально.

**Лечение — всегда перед push:**
```bash
git pull --rebase origin main && git push origin HEAD:main
```
Если есть свои незакоммиченные правки и rebase ругается — сперва `git stash`, потом rebase, потом `git stash pop`.
`deploy.sh` сам не делает pull — если он упал на push, выполни pull --rebase и повтори push вручную (cache уже поднят, коммит уже сделан → просто `git push`).

---

## C. Деплой Edge Function (мозг агента)

```bash
supabase functions deploy ai --no-verify-jwt
```
- Docker НЕ нужен (грузит исходник). `--no-verify-jwt` — функция сама проверяет токен внутри.
- **Деплой Edge ≠ коммит.** После деплоя — закоммитить `.ts` руками + зафиксировать факт в `SNAPSHOT.md`.
- Если CLI не залогинен: `supabase login` → `supabase link --project-ref <ref>`.
- Проверить что живой: `curl -s -o /dev/null -w "%{http_code}" -X POST <url>/functions/v1/ai -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -d '{"action":"ping"}'` → `401` = жив + ключ есть; `500` = ключ не настроен.

---

## D. Деплой миграции (схема БД)

1. Написать `supabase/migrations/YYYYMMDD_описание.sql` (всегда `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` — идемпотентно, не ломает существующее).
2. Dashboard → SQL Editor → вставить → **Run**.
3. Закоммитить файл миграции в гит + отметить в SNAPSHOT.
> Клиентский код, который пишет в новую колонку, выкатывать с **graceful degradation** (слать поле, только убедившись что колонка есть) — иначе upsert упадёт на «column does not exist» и сломает ВСЁ облачное сохранение.

---

## E. Проверка после деплоя

```bash
# какая версия реально на проде:
curl -s "https://defancientmus-gif.github.io/razberemsia/sw.js" | grep -o "rz-v[0-9]*" | head -1
```
- Открыть Safari (там уже залогинен): `open -a Safari "https://defancientmus-gif.github.io/razberemsia/"`.
- В шапке приложения — бейдж `β rz-vN`. Должен совпасть с задеплоенным.
- **PWA обновляется не сразу:** SW делает `skipWaiting`, но НЕ перезагружает страницу (намеренно — чтобы старт был мгновенным). Новый код подхватывается при **следующем** открытии приложения. На телефоне: закрыть-открыть 1–2 раза.

---

## F. Частые поломки → лечение

| Симптом | Причина | Лечение |
|---|---|---|
| `push rejected (fetch first)` | app запушил идеи | `git pull --rebase origin main` → push |
| Старая версия на телефоне | SW cache-first | закрыть-открыть приложение 1–2 раза |
| Edge-правка на проде, но гит «отстаёт» | `deploy.sh` не коммитит Edge | `git add supabase/... && commit && push` |
| Облако перестало сохраняться после миграции | колонки ещё нет, клиент шлёт поле | graceful degradation: слать поле только при `_colOk` |
| Агент молчит | кредиты/ключ Anthropic | проверить баланс на console.anthropic.com |
| Офлайн сломался | CDN-зависимость (opaque response) | вендорить либу локально, кэшировать в SW |

---

## G. Золотые правила
- Версия живёт ТОЛЬКО в `sw.js` (`deploy.sh` её бампит) — руками не трогать.
- `git add` — только нужное, не `-A` вслепую.
- Фронт — `deploy.sh`; Edge и миграции — отдельно и фиксировать в SNAPSHOT.
- После правок агента/роутера — smoke перед деплоем.
- Перед push — `git pull --rebase`.

Связано: [[SETUP_GITHUB_SUPABASE.md]] (первичная настройка), [[REPO_BLUEPRINT.md]] (костяк), [[SNAPSHOT.md]] (текущее состояние).
