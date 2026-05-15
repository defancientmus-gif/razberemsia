# Разберёмся

PWA/HTML-прототип спокойного цифрового помощника.

## Главное правило

Рабочая входная точка проекта — `index.html`.

Не создаём новые рабочие HTML-файлы с версиями в названии. Старые копии и бэкапы складываем в папку `1`.

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

- `index.html` — главный прототип.
- `manifest.json` — PWA-настройки.
- `sw.js` — service worker и кэш.
- `supabase.sql` — таблица и RLS-правила для облачных заметок Supabase.

## Supabase

Для живого входа по почте нужно вставить в `index.html`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

В Supabase SQL Editor выполните `supabase.sql`. Он создаёт таблицу `user_state` и правила, чтобы пользователь видел только свои заметки.

В Supabase Auth URL Configuration укажите:

- Site URL: `https://defancientmus-gif.github.io/razberemsia/`
- Redirect URL: `https://defancientmus-gif.github.io/razberemsia/`
- `PROJECT_CONTEXT.md` — краткий контекст проекта.
- `TODO.md` — ближайшие задачи.
- `CHANGELOG.md` — история изменений.
- `Master PROMT/` — мастер-документы и философия проекта.
