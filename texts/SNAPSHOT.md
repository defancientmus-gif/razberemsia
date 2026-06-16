# Snapshot проекта

Обновлено: 2026-06-04 после `rz-v353`.

Этот файл фиксирует факты, а не желания. Если есть сомнение, проверять код и `git status`.

## Текущий деплой

- **SW cache:** `rz-v353` в `sw.js`.
- **Последний runtime-коммит:** `2ebd395 rz-v353: instant startup`
- **Edge Function `ai`:** передеплоена **2026-06-16** — убраны уточняющие вопросы (CLARIFY почти никогда, `options` всегда `[]`, «действуй не спрашивай»). До этого Router v1.1 (`rz-v283`, 2026-05-31). Если агент странно себя ведёт — передеплоить `supabase functions deploy ai --no-verify-jwt`.
- **Прод URL:** https://defancientmus-gif.github.io/razberemsia/
- **Обновление PWA:** `sw.js` делает `skipWaiting()` и `clients.claim()`. Клиент НЕ перезагружается при `controllerchange` (убрано в v353 — давало рывок при старте). Новый SW подхватывает файлы при следующем запуске.

## Последние большие изменения (сессия 2026-06-04)

### Desktop workspace (v348–v349)
- 2-колонная раскладка от 1000px: основной контент + sidebar справа
- Sidebar: sticky, glass, содержит быстрый ввод/агент/тетрадь
- До v349 sidebar был слева — конфликтовал с логотипом

### Анимации (v347)
- Glass-карточка агента
- Напоминание вылетает из кнопки (transform-origin = кнопка)
- Открытие заметки: zoom in (scale 0.94→1)
- Папки: staggered reveal (delay по индексу)

### Перф (v350–v353)
- blur 24→9, убрана `saturate()` — дешевле на GPU
- `contain:paint` на карточках
- `glass-lite` toggle в меню (для слабых устройств)
- `font-display: swap` — нет блокирующего периода для Playfair
- splash 600→300ms, font-gate 1500→700ms
- SW auto-reload убран → мгновенный старт

### Баги синка (исправлены ранее, ~v323)
- Удалённые заметки воскресали → `_mergeNoteArrays` знает `trashIds`
- Корзина перезаписывалась → `_mergeTrashArrays` (union)
- Лимит корзины унифицирован до 200

## Важное по репозиторию

- `texts/` — каноническая папка контекста
- `project-memory/` — legacy, не использовать как активный источник
- Не делать `git add -A` вслепую
- Untracked: `supabase/migrations/20260531_realtime_user_state.sql` — проверить и закоммитить или удалить

## Runtime

| Что | Где |
| --- | --- |
| Вход | `index.html` |
| Основной клиент | `js/app.js` (~6961 строк) |
| PWA cache/offline | `sw.js` |
| Manifest/icons | `manifest.json`, `pwa-logo-*`, `logo-mark.png` |
| AI Edge Function | `supabase/functions/ai/index.ts` (~840 строк) |
| SQL migrations | `supabase/migrations/*.sql` |

## Supabase / AI

- Основная Edge Function: `ai`.
- Модель: `claude-haiku-4-5-20251001` (через `ANTHROPIC_MODEL` env или дефолт).
- Секреты в Supabase Dashboard: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `YANDEX_STT_KEY`, `GITHUB_TOKEN`.
- STT: Yandex SpeechKit (основной) → Groq Whisper (резерв).
- Router v1.1: профили `none/light/notes/deep`, клиент — источник правды.
- `save_idea` пишет идеи в GitHub коммитами через Edge Function (`texts/IDEAS_NEAR_TERM.md`).

## Открытые риски

1. **БАГ 4 — папки без soft-delete**: удалённая папка воскресает при pull. Нужна миграция схемы + `_mergeTagFolders`.
2. **БАГ 3 — self-echo broadcast**: дебаунс `_lastPullAt` защищает, но не полностью.
3. **Realtime migration**: `20260531_realtime_user_state.sql` не закоммичена. Неизвестно, применялась ли вручную.
4. **Edge Function**: если Router v1.1 не применяется — значит не передеплоена. Проверить через `supabase functions deploy ai --no-verify-jwt`.
5. **glass-lite / живой тест**: нужен тест на iPhone — fog, blur, читаемость карточек на солнце.

## Проверки перед деплоем

- `node --check js/app.js`
- если менялись `index.html`, `js/app.js`, `sw.js` или кэшируемые ассеты — поднять `CACHE` в `sw.js`
- коммитить только нужные файлы
- после push проверить PWA через обычный URL
- после правок агента/роутера: `node scripts/smoke-agent-router.mjs`
