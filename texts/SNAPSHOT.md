# Snapshot проекта

Обновлено: 2026-06-16 после `rz-v398`.

Этот файл фиксирует факты, а не желания. Если есть сомнение, проверять код и `git status`.

## Текущий деплой

- **SW cache:** `rz-v398` в `sw.js`.
- **Последний runtime-коммит:** `0525e4f rz-v398: fix Yandex STT sample_rate`
- **Edge Function `ai`:** передеплоена **2026-06-16** — убраны уточняющие вопросы (CLARIFY почти никогда, `options` всегда `[]`, «действуй не спрашивай»). Передеплой: `supabase functions deploy ai --no-verify-jwt` (Docker не нужен, грузит исходник).
- **Прод URL:** https://defancientmus-gif.github.io/razberemsia/
- **Обновление PWA:** `sw.js` делает `skipWaiting()`, НЕ вызывает `clients.claim()` (убран в v354 — ломал первый запуск). Клиент НЕ перезагружается при `controllerchange`. Новый SW подхватывает файлы при следующем запуске → старт всегда мгновенный.

## Последние большие изменения (сессия 2026-06-09 → 06-16)

### Тёмная тема (v379–v386)
- Fog через CSS-переменные `--fog` + pre-computed `--fog-72/42/...` (НЕ `color-mix` — не поддерживается на старых iOS Safari).
- Тёмные карточки/кнопки/шапка/лого/дата; кнопки агента (`.new-note-btn` — отдельный класс!) тёмное стекло.

### Офлайн + скорость запуска (v387)
- **supabase-js вендорится локально** `js/vendor/supabase.js` (CDN без `crossorigin` = opaque response = SW не кэшировал = офлайн умирал).
- Мгновенный вход с `rz_last_user` (сессия проверяется в фоне). Лого без FOUT (гейт `fonts-ready`).

### Перегрев + плавность (v388–v390)
- `nnb-float`/`dot-pulse`/`agent-glass` → transform/opacity-only (box-shadow в keyframes грел GPU).
- `backdrop-filter` снят с движущихся кнопок. Под открытым оверлеем фоновые анимации на паузе.
- Анимации появления/переходов — мягкое перо `cubic-bezier(.22,1,.36,1)`, без overshoot.

### «Все заметки» (v392–v393)
- Время-группы Сегодня/Вчера/Неделя/Ранее, спокойные карточки без шума, выплывающая лента (гейт `.reveal` — без моргания на «показать ещё»).

### Десктоп (v394–v395)
- Шапка = PWA-стекло (blur+saturate). Меню (`.jarvis-quick`) и кнопки агента (`.home-act-row`) переезжают в шапку на ≥1000px (`_syncDesktopHeader` + matchMedia). Лента на всю ширину, правый рейл убран. **Не до конца вылизано — нужен живой тест на десктопе.**

### Логика агента (v396–v398)
- Живая карточка «Разбираюсь…» сразу при запросе → плавно превращается в ответ. Разборы/анализы не автозакрываются.
- Агент слышит через родной `SpeechRecognition` (как голосовая заметка), Yandex/Groq — резерв.
- Fix: клиент шлёт реальную `sample_rate` (был дефолт 16000 при аудио 48000 → Yandex слышал кашу).

## Важное по репозиторию

- `texts/` — каноническая папка контекста. `texts/archive/`, `ideas/` — только по запросу.
- Не делать `git add -A` вслепую. Деплой фронта — через `./deploy.sh` (бампит `sw.js`, коммитит index/sw/app/manifest/SNAPSHOT).
- Edge Function и миграции деплоятся ОТДЕЛЬНО, фиксировать здесь.
- Приложение пушит idea-коммиты само (через `save_idea`) — перед push часто нужен `git pull --rebase`.

## Runtime

| Что | Где |
| --- | --- |
| Вход | `index.html` (~5170 строк) |
| Основной клиент | `js/app.js` (~7380 строк) |
| Вендоренная библиотека | `js/vendor/supabase.js` (supabase-js 2.108.1) |
| PWA cache/offline | `sw.js` |
| Manifest/icons | `manifest.json`, `pwa-logo-*`, `logo-mark.png` |
| AI Edge Function | `supabase/functions/ai/index.ts` (~832 строки) |
| SQL migrations | `supabase/migrations/*.sql` (6 файлов) |

## Supabase / AI

- Основная Edge Function: `ai`. Модель `claude-haiku-4-5-20251001` (env `ANTHROPIC_MODEL` или дефолт).
- Секреты: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `YANDEX_STT_KEY`, `GITHUB_TOKEN`.
- STT агента: родной `SpeechRecognition` (клиент) → Yandex SpeechKit → Groq Whisper (резерв сервера).
- Router v1.1: профили `none/light/notes/deep`, клиент — источник правды (`smoke-agent-router.mjs`).
- Колонка `folder_tombstones` в `user_state` — применена Женей 2026-06-15 (надгробия папок).

## Открытые риски

1. ~~**БАГ 4 — папки без soft-delete**~~ ✅ ИСПРАВЛЕНО (rz-v391, надгробия + миграция применена). Проверить на 3 устройствах.
2. **БАГ 3 — self-echo broadcast**: дебаунс `_lastPullAt` защищает, но не полностью.
3. **Десктоп v395**: меню в шапке — нужен живой тест/подгонка на широком экране (Женя смотрит).
4. **Realtime migration** `20260531_realtime_user_state.sql`: закоммичена, но неизвестно применялась ли в Dashboard. Уточнить.
5. **Свайпы reminder-карточек / tag picker**: после редизайнов не тестировались на живом iPhone.
6. **ANTHROPIC_API_KEY / кредиты**: 2026-06-16 ИИ кратко отваливался (баланс/нагрузка Anthropic). Если ИИ молчит — проверить баланс на console.anthropic.com.

## Проверки перед деплоем

- `node --check js/app.js`
- `git diff --check` (whitespace)
- если менялись `index.html`, `js/app.js`, `sw.js` или ассеты — `./deploy.sh` сам бампит `CACHE`
- после правок агента/роутера/промпта: `node scripts/smoke-agent-router.mjs`
- коммитить только нужные файлы; после push проверить PWA через обычный URL (Safari, уже залогинен)
