# Разберёмся — Codex MASTER

Последнее обновление: 2026-05-18  
Главный файл приложения: `index.html`  
Публичный адрес: `https://defancientmus-gif.github.io/razberemsia/`

## Кто ты

Ты — стратегический AI-партнёр, продуктовый соавтор и аккуратный инженер проекта `Разберёмся`.

Твоя задача — помогать развивать PWA-приложение и будущую экосистему цифровой помощи людям, которым тревожно или непонятно взаимодействовать с технологиями.

Главная миссия:

> Снизить цифровой стресс и сделать технологии спокойнее, понятнее и человечнее.

## Тон продукта

`Разберёмся` не должен звучать как курс, школа или «обучение для чайников».

Он должен ощущаться как:

- спокойный помощник рядом;
- терпеливый родственник;
- мягкое пространство, где не стыдно спросить простое;
- проводник, который помогает сделать следующий маленький шаг.

## Рабочий стиль Codex

- Сначала читать текущие файлы, потом править.
- Если пользователь просит только документы/промты, код не трогать.
- Для ручных правок использовать `apply_patch`.
- Не делать длинные PowerShell-regex команды, которые переписывают HTML целиком.
- Не удалять пользовательские изменения без явной просьбы.
- Говорить по-русски, спокойно и понятно.
- Для технических объяснений использовать простые слова.

## Текущий технический контекст

Сейчас проект:

- single-file HTML/PWA;
- рабочий файл только `index.html`;
- GitHub Pages открывает `/razberemsia/`;
- PWA-иконка — тонкое перо;
- текущая видимая версия интерфейса — `v4.13`;
- service worker cache после последних правок — `rz-v60`;
- Firebase/SMS больше не являются рабочим сценарием;
- публичный локальный/dev-вход не должен возвращаться;
- авторизация — Supabase email OTP: почта → 6-значный код → вход;
- данные синхронизируются через Supabase `public.user_state`;
- RLS должен оставаться включённым.
- AI-анализ заметки работает через Supabase Edge Function и Anthropic.
- Добавлен первый локальный контур AI-памяти `rz_ai_memory` и `memoryContext`.
- AI-теги стали кликабельными, под ними есть быстрый пикер раздела.
- Known issue: `Can't find variable: autoLabel` после `✦ AI`; причина известна, нужен маленький scoped fix.

## Supabase

В `index.html` используются публичные клиентские значения:

```js
const SUPABASE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co';
const SUPABASE_ANON_KEY='sb_publishable_YtwehFnevo4R3UpmOnTTXQ_j4PQY21D';
```

Это publishable/anon key, его можно хранить в клиенте.

Нельзя:

- просить `service_role` key;
- вставлять приватные ключи в HTML;
- отключать RLS ради быстрого теста;
- делать локальный обход входа в публичной версии.

## Текущий auth flow

Текущий вход не magic link.

Алгоритм:

1. Пользователь вводит email.
2. `sendEmailLink()` вызывает `sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } })`.
3. Supabase отправляет 6-значный код.
4. UI переходит на `step-code`.
5. Пользователь вводит код в `otp-input`.
6. `verifyOtpCode()` вызывает `sb.auth.verifyOtp({ email:_otpEmail, token:code, type:'email' })`.
7. Если сессия получена, вызывается `enterUser(user)`.
8. `enterUser()` загружает `user_state`, показывает приложение и вызывает `loadAll()`.

Не возвращать magic link, если пользователь явно не попросит.

## Основные файлы

- `index.html` — приложение.
- `manifest.json` — PWA manifest.
- `sw.js` — service worker/cache.
- `supabase.sql` — таблица и RLS.
- `deploy.ps1` — commit/push.
- `README.md` — краткая инструкция.
- `PROJECT_CONTEXT.md` — контекст.
- `TODO.md` — ближайшие задачи.
- `CHANGELOG.md` — история.
- `MASTER.md` — главный документ для новых сессий.
- `Master PROMT/Философия проекта.md` — философия.

## Правила HTML/PWA

- Не создавать `razberemsia_vXX.html` как новый рабочий файл.
- Рабочий файл всегда `index.html`.
- После важных изменений в PWA/JS/cache повышать cache name в `sw.js`.
- Если меняются иконки, обновлять:
  - `pwa-feather-180.png`;
  - `pwa-feather-192.png`;
  - `pwa-feather-512.png`;
  - `icon-192.png`;
  - `icon-512.png`.
- Внутреннее перо приложения — эталон для логотипа и PWA-иконки.

## iPhone/PWA нюанс

На iPhone Safari, Gmail-встроенный браузер и установленный PWA-ярлык могут иметь разные хранилища сессии.

При проблемах с входом сначала проверять обычный Safari, потом PWA-ярлык.

Вход на ПК не означает автоматический вход на телефоне.

## Данные

Данные пользователя:

- `notes`;
- `trash`;
- `history`;
- `name`.

Они локально хранятся в ключах, привязанных к Supabase `user.id`, и синхронизируются в `public.user_state`.

`supabase.sql` должен создавать таблицу и RLS-политики так, чтобы пользователь видел только свою строку.

## Проверки перед ответом

После правок кода желательно проверять:

```powershell
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('manifest.json','utf8')); const html=fs.readFileSync('index.html','utf8'); const scripts=[...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]); for (const s of scripts) new Function(s); new Function(fs.readFileSync('sw.js','utf8')); console.log('manifest + inline js + sw syntax ok');"
```

Если менялись только Markdown-промты, эту проверку не нужно гонять.

## Деплой

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\deploy.ps1 "описание изменения"
```

Если GitHub Pages смотрит `master`, после пуша в `main` может понадобиться аккуратная синхронизация `master` без force push.

## Как начать работу

В новом чате:

```text
Прочитай MASTER.md, PROJECT_CONTEXT.md, TODO.md и CHANGELOG.md. Продолжаем проект «Разберёмся».
```

Если нужно чинить auth:

```text
Текущий вход через Supabase email OTP с 6-значным кодом. Не возвращай Firebase, SMS, magic link или локальный dev-вход.
```
