# Snapshot проекта

Обновлено: 2026-05-29 после `rz-v276`.

Этот файл фиксирует факты, а не желания. Если есть сомнение, проверять код и `git status`.

## Текущий деплой

- **SW cache:** `rz-v276` в `sw.js`.
- **Последний runtime-коммит:** `f451e5b rz-v275: fix save sheet reload helper`.
- **Текущая локальная уборка:** `rz-v276`, контекстный маршрут, handoff и замена старых иконок.
- **Прод URL:** https://defancientmus-gif.github.io/razberemsia/
- **Обновление PWA:** `sw.js` делает `skipWaiting()` и `clients.claim()`, `js/app.js` делает один reload на `controllerchange`. Это дает быстрый сценарий: правка -> cache bump -> commit/push -> через 1-2 минуты видно в PWA.

## Что только что исправлено

- Кнопка `Сохранить` больше не должна зависать из-за бесконечного `_reloadViews()`.
- Было: `function _reloadViews(){_reloadViews();}`.
- Стало: `loadHomeFeed(); loadNotes(); loadNotepad();`.
- Старые ссылки `pwa-feather-*` заменены на актуальные `pwa-logo-*`, чтобы не коммитить удаленные иконки с живыми ссылками.
- Проверка: `node --check js/app.js` проходит.

## Важное по репозиторию

- `texts/` становится канонической папкой контекста.
- `project-memory/` больше не должен использоваться как активный источник.
- `scripts/build-claude-handoff.sh` должен собирать handoff из `CLAUDE.md`, `texts/` и актуального runtime, а не из старого `project-memory`.
- В git до уборки было много старых удалений и untracked-файлов. Не делать `git add -A` вслепую без понимания.

## Runtime

| Что | Где |
| --- | --- |
| Вход | `index.html` |
| Основной клиент | `js/app.js` |
| PWA cache/offline | `sw.js` |
| Manifest/icons | `manifest.json`, `pwa-logo-*`, `logo-mark.png` |
| AI Edge Function | `supabase/functions/ai/index.ts` |
| SQL migrations | `supabase/migrations/*.sql` |

## Supabase / AI

- Основная Edge Function: `ai`.
- Legacy: `smooth-processor`, не считать источником правды.
- Секреты в Supabase Dashboard: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `YANDEX_STT_KEY`, `GITHUB_TOKEN`.
- Локальный код `save_idea` сейчас нацелен на `texts/IDEAS_NEAR_TERM.md`, но тест 2026-05-29 не дошел до GitHub. Это отдельная задача.

## Открытые риски

1. `save_idea`: выяснить, почему тестовая заметка с тегом `идея` не появилась ни в `texts/IDEAS_NEAR_TERM.md`, ни в `ideas/`, ни в GitHub-коммитах.
2. `ideas/`: считать legacy raw-историей. Решить, оставляем ли папку readonly или переносим новые автосохранения только в `texts/IDEAS_NEAR_TERM.md`.
3. Supabase deployed function может отличаться от локальной. Перед правкой AI-цепочки проверить, что реально задеплоено.

## Проверки перед деплоем

- `node --check js/app.js`
- если менялись `index.html`, `js/app.js`, `sw.js` или кэшируемые ассеты - поднять `CACHE` в `sw.js`
- коммитить только нужные файлы
- после push проверить PWA через обычный URL
