# Разберёмся

PWA/HTML-прототип спокойного цифрового помощника.

## Главное правило

Рабочая входная точка проекта — `index.html`.

Не создаём новые рабочие HTML-файлы с версиями в названии. Старые HTML-копии складываем в `backups/legacy-html/`.

## Как открыть проект на новом устройстве

```powershell
git clone https://github.com/defancientmus-gif/razberemsia.git
cd razberemsia
```

Если проект уже скачан:

```powershell
git pull
```

## Как сохранить и отправить изменения

```powershell
.\deploy.ps1 "описание изменения"
```

`deploy.ps1` сам работает из папки проекта, поэтому путь к проекту на конкретном компьютере менять не нужно.

## Основные файлы

- `index.html` — HTML-оболочка приложения.
- `js/app.js` — основной runtime приложения.
- `manifest.json` — PWA-настройки.
- `sw.js` — service worker и кэш.
- `supabase.sql` — таблица и RLS-правила для облачных заметок Supabase.
- `supabase/functions/smooth-processor/index.ts` — текущая Edge Function для AI-анализа заметок.
- `project-memory/` — каноническая папка промтов, памяти, правил, TODO и архивов.

## Supabase

Для живого входа по почте используется Supabase email OTP: пользователь вводит почту, получает 6-значный код и вводит его в приложении.

В `index.html` должны быть публичные клиентские значения:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

В Supabase SQL Editor выполните `supabase.sql`. Он создаёт таблицу `user_state` и правила, чтобы пользователь видел только свои заметки.

В Supabase Auth URL Configuration укажите:

- Site URL: `https://defancientmus-gif.github.io/razberemsia/`
- Redirect URL: `https://defancientmus-gif.github.io/razberemsia/`

Важно: не использовать `service_role` key в клиентском HTML и не отключать RLS.

## Документы проекта

- `project-memory/README.md` — карта актуальных документов и архива.
- `project-memory/current/2026-05-19_PROJECT_BRIEF.md` — краткий контекст проекта.
- `project-memory/current/2026-05-19_TODO.md` — ближайшие задачи.
- `project-memory/current/2026-05-19_AGENT_RULES.md` — правила работы для AI/разработки.
- `project-memory/current/2026-05-19_CHANGELOG.md` — история изменений.
- `MASTER.md`, `PROJECT_CONTEXT.md`, `TODO.md`, `CLAUDE.md` — короткие указатели на `project-memory/current/`.
