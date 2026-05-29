# Snapshot проекта

Обновлено: 2026-05-29 после локального фикса `rz-v277`.

Этот файл фиксирует факты, а не желания. Если есть сомнение, проверять код и `git status`.

## Текущий деплой

- **SW cache:** `rz-v277` в `sw.js`.
- **Последний runtime-коммит:** `037e918 rz-v276: organize context files and handoff`.
- **Текущая правка:** `rz-v277`, единый тег `идея`, автосохранение идеи из обычного `Сохранить`, защита от повторного клика.
- **Edge Function `ai`:** задеплоена 2026-05-29 после правки нормализации тегов.
- **Прод URL:** https://defancientmus-gif.github.io/razberemsia/
- **Обновление PWA:** `sw.js` делает `skipWaiting()` и `clients.claim()`, `js/app.js` делает один reload на `controllerchange`. Это дает быстрый сценарий: правка -> cache bump -> commit/push -> через 1-2 минуты видно в PWA.

## Что только что исправлено

- Кнопка `Сохранить` больше не должна зависать из-за бесконечного `_reloadViews()`.
- Было: `function _reloadViews(){_reloadViews();}`.
- Стало: `loadHomeFeed(); loadNotes(); loadNotepad();`.
- Старые ссылки `pwa-feather-*` заменены на актуальные `pwa-logo-*`, чтобы не коммитить удаленные иконки с живыми ссылками.
- Тег идеи приведен к одному канону: `идея`. Legacy-варианты `идеи`, `idea`, `ideas` нормализуются и не должны создавать отдельные AI-папки.
- Обычное `Сохранить` теперь тоже вызывает `save_idea`, если заметка находится в контексте идеи: тег/папка `идея`, label `идея` или текст начинается с "идея/идеи".
- Повторный быстрый клик по `Сохранить` закрыт локальным замком, чтобы не создавать дубли.
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
- Локальный код `save_idea` нацелен на `texts/IDEAS_NEAR_TERM.md`.
- Серверная Edge Function нормализует теги, но не форсирует `идея`, потому что тот же action используется для фидбека.

## Открытые риски

1. `save_idea`: после деплоя `rz-v277` нужен живой тест заметкой с тегом/контекстом `идея`, чтобы подтвердить запись в GitHub.
2. `ideas/`: считать legacy raw-историей. Решить, оставляем ли папку readonly или переносим новые автосохранения только в `texts/IDEAS_NEAR_TERM.md`.
3. Supabase deployed function `ai` обновлена после `rz-v277`; если живой тест не пройдет, проверять уже runtime/auth/GitHub, а не расхождение локальной и deployed функции.

## Проверки перед деплоем

- `node --check js/app.js`
- если менялись `index.html`, `js/app.js`, `sw.js` или кэшируемые ассеты - поднять `CACHE` в `sw.js`
- коммитить только нужные файлы
- после push проверить PWA через обычный URL
