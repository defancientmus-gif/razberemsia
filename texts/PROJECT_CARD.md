# Визитная карточка проекта

Обновлено: 2026-06-04. Runtime cache по текущему коду: `rz-v346`.

## Коротко

**Разберёмся** - мобильный PWA-помощник с голосовым AI-агентом, заметками, памятью, напоминаниями и спокойным интерфейсом для людей, которым сложно разбираться с цифровыми задачами.

Одна строка продукта:

> Человек говорит как умеет -> агент понимает -> раскладывает по полочкам -> помогает сделать следующий шаг.

Главная идея: приложение не экзаменует пользователя и не заставляет думать техническими терминами. Оно переводит хаос, тревогу и бытовые задачи в понятные действия.

## Для кого

- пожилые люди;
- люди с низкой цифровой уверенностью;
- люди в цифровом стрессе;
- пользователи, которым сложно с аккаунтами, кодами, настройками, интернетом, приложениями;
- люди, которым нужен спокойный личный помощник, а не сложный таск-менеджер.

## Что это за тип приложения

Это **PWA**: web-приложение, которое открывается в браузере, устанавливается на телефон как приложение и умеет работать с кэшем, уведомлениями и offline fallback.

Важный момент: у проекта нет отдельного "движка" уровня React, Flutter или Unity. Основа максимально прямая:

- статический фронтенд;
- браузерные API;
- Supabase как backend/cloud-слой;
- Supabase Edge Functions как серверная логика;
- AI-провайдеры через серверную функцию.

## Технологический стек

### Frontend

- `HTML` - основной экран и разметка: `index.html`.
- `CSS` - весь визуальный слой внутри `index.html`.
- `JavaScript` - основная логика приложения: `js/app.js`.
- Без React/Vue/Svelte/Vite/Webpack. Сейчас это vanilla-приложение без сборщика.
- Дизайн mobile-first: приложение рассчитано прежде всего на телефон и PWA-режим.

### PWA / runtime

- `manifest.json` - установка на экран, иконки, shortcuts.
- `sw.js` - Service Worker:
  - cache-first для статичных файлов;
  - offline fallback;
  - `skipWaiting()` и `clients.claim()` для быстрого обновления;
  - отдельные долгоживущие кэши для шрифтов и библиотек;
  - системные уведомления и push-события.
- Runtime-версия берётся из `const CACHE` в `sw.js`.

### Backend

- Supabase project: `https://izvwgyudjbxlixzrgpuv.supabase.co`.
- Auth: Supabase email OTP.
- Database: Supabase Postgres.
- Security: Row Level Security по `auth.uid()`.
- Realtime: клиентская подписка на `user_state` + fallback polling.
- Edge Functions на Deno/TypeScript:
  - `supabase/functions/ai/index.ts` - основной AI endpoint;
  - `supabase/functions/health/index.ts` - проверка живости сервисов;
  - `supabase/functions/push-sender/index.ts` - серверная отправка push;
  - `smooth-processor` - legacy, не основной источник логики.

### AI

- Основной AI endpoint: `/functions/v1/ai`.
- Основная модель задаётся через `ANTHROPIC_MODEL`.
- По текущему коду default: `claude-haiku-4-5-20251001`.
- AI используется для:
  - ответов агента;
  - анализа заметок;
  - роутинга намерений;
  - создания заметок и напоминаний;
  - поиска/обобщения;
  - сохранения идей в проектный backlog.

### Голос

- Быстрый голосовой ввод в разных местах использует Web Speech API, где доступно:
  - `SpeechRecognition`;
  - `webkitSpeechRecognition`.
- Голос агента записывается через:
  - `getUserMedia`;
  - `AudioContext`;
  - WAV encoder в `js/app.js`.
- Серверная транскрибация по текущему коду:
  - Yandex SpeechKit как основной STT;
  - Groq Whisper как fallback, но сейчас он нестабилен/не работает надёжно, поэтому Yandex вернули осознанно;
  - Groq модели: `whisper-large-v3-turbo`, затем `whisper-large-v3`.
- Направление для ближайших тестов: проверить альтернативный STT отдельно, не ломая рабочую цепочку Yandex -> fallback.
- Голосовой ответ использует браузерный `speechSynthesis`.

### Уведомления

- Локальные уведомления через Service Worker.
- Push API / PushManager.
- VAPID Web Push через серверную функцию.
- Таблицы: `push_subscriptions`, `reminders`.

### Хранение данных

Основные сущности:

- `public.user_state` - JSON-состояние пользователя:
  - заметки/legacy-состояние;
  - AI memory;
  - пользовательские разделы;
  - AI-папки;
  - timestamps.
- `notes` - отдельная таблица заметок.
- `push_subscriptions` - подписки на push.
- `reminders` - напоминания.
- `user_folders`, `tag_folders` - сейчас хранятся как JSON-поля в `user_state`.

## Архитектура в одном потоке

```text
Пользователь
  -> PWA в браузере / на телефоне
  -> js/app.js
  -> Supabase Auth / DB / Realtime
  -> Supabase Edge Function ai
  -> Anthropic / Groq / Yandex / GitHub API
  -> понятный ответ, заметка, напоминание или действие
```

Голосовой агент:

```text
Микрофон
  -> AudioContext
  -> WAV
  -> Edge Function ai: action=transcribe
  -> STT
  -> текст
  -> intent router
  -> действие агента
```

## Ключевые функции

- Заметки и списки.
- AI-анализ заметки.
- AI-чат внутри заметки.
- Голосовой агент.
- Голосовое создание заметок.
- Напоминания.
- Push-уведомления.
- Поиск по заметкам.
- Разделы и AI-папки.
- Корзина и восстановление.
- Supabase sync между устройствами.
- Realtime sync + fallback polling.
- Сохранение идей в проектный backlog через GitHub.
- Health-страница для проверки сервисов: `health.html`.

## Ключевые продуктовые принципы

- Голос - главный путь.
- Заметки - это память агента, не просто блокнот.
- AI не должен менять исходный текст без подтверждения.
- Интерфейс должен быть спокойным, коротким, без стыда и технического жаргона.
- Агент не должен перегружать пользователя списками и вопросами.
- В тревожных сценариях сначала успокоить, потом помогать.
- В сценариях мошенничества - жёсткий блок и прямое предупреждение.
- Медицина - только навигация к врачу, не диагнозы.

## Ключевые инженерные правила

- Перед правками читать код, а не угадывать.
- Не делать `git add -A` вслепую.
- Не трогать unrelated/untracked без причины.
- Если менялись `index.html`, `js/app.js`, `sw.js`, `manifest.json` или кэшируемые ассеты - обязательно поднять `CACHE` в `sw.js`.
- После правок `js/app.js` запускать `node --check js/app.js`.
- После фронтовых правок проверять PWA/health в браузере.
- Edge Function `ai` - источник правды для AI, `smooth-processor` legacy.
- Коммитить только нужные файлы.

## Деплой

Фронт деплоится на GitHub Pages:

```text
https://defancientmus-gif.github.io/razberemsia/
```

Основной сценарий:

```bash
./deploy.sh "описание правки"
```

Что делает deploy script:

- поднимает `CACHE` в `sw.js`;
- проверяет `js/app.js` через `node --check`;
- обновляет `SNAPSHOT`;
- добавляет нужные файлы;
- делает commit;
- делает push в `main`.

Edge Functions деплоятся отдельно через Supabase CLI:

```bash
supabase functions deploy ai --no-verify-jwt
supabase functions deploy health --no-verify-jwt
supabase functions deploy push-sender --no-verify-jwt
```

## Карта файлов

| Зона | Файлы |
| --- | --- |
| Вход приложения | `index.html` |
| Основная логика | `js/app.js` |
| PWA/cache/push | `sw.js`, `manifest.json` |
| AI backend | `supabase/functions/ai/index.ts` |
| Health-check | `health.html`, `supabase/functions/health/index.ts` |
| Push backend | `supabase/functions/push-sender/index.ts` |
| База | `supabase.sql`, `supabase/migrations/*.sql` |
| Контекст проекта | `texts/*.md` |
| Деплой фронта | `deploy.sh` |

## Сильные стороны проекта

- Очень низкий порог входа: говорить можно обычными словами.
- PWA без тяжёлого frontend-стека - быстро править и деплоить.
- Supabase закрывает auth, database, realtime и edge-логику.
- AI-логика централизована в одной Edge Function.
- Service Worker даёт контролируемые обновления и offline-поведение.
- Продуктовая философия уже хорошо сформулирована: спокойный помощник, а не сложная программа.

## Текущие зоны внимания

- Голосовое распознавание: Yandex сейчас рабочий основной путь; альтернативы вроде Groq/локального STT проверять отдельно, без поспешной замены.
- Документы `STATUS/SNAPSHOT/CONTEXT` иногда отстают от runtime, их нужно синхронизировать после технических изменений.
- Realtime migration есть локально и требует решения: официально применить/закоммитить или убрать.
- `save_idea` требует периодического живого теста.
- Перед каждым деплоем важно не забывать cache bump, иначе PWA может показывать старый код.
