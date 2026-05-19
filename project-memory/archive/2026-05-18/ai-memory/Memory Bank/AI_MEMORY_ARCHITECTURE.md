# AI Memory — Архитектура памяти «Разберёмся»

Последнее обновление: 2026-05-18  
Папка: `Ai Memory/`  
Статус: проектирование → этап 1 активен

---

## Одна строка

Два контура памяти: проектный кластер для разработчика + приватное облако для каждого пользователя.  
AI не хранит сырой текст — только короткие выжимки с весами важности.

---

## Архитектура: два контура

```
┌─────────────────────────────────────────────────────┐
│                 Supabase (общее)                     │
│  ┌──────────────────┐    ┌────────────────────────┐  │
│  │  PROJECT cluster │    │  USER private cloud    │  │
│  │  (только мы)     │    │  (каждый пользователь) │  │
│  │                  │    │                        │  │
│  │ - баги/идеи      │    │ - заметки              │  │
│  │ - решения        │    │ - ai_memory            │  │
│  │ - TODO/MASTER    │    │ - напоминания          │  │
│  │ - промты         │    │ - recovery             │  │
│  └──────────────────┘    └────────────────────────┘  │
│  RLS: is_project_admin   RLS: auth.uid() = user_id   │
└─────────────────────────────────────────────────────┘
```

---

## Таблицы Supabase

### profiles — флаг разработчика

```sql
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_project_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "anyone reads own profile"
on public.profiles for select using (auth.uid() = user_id);
```

Установить вручную после создания таблицы:
```sql
INSERT INTO public.profiles (user_id, is_project_admin)
VALUES ('<твой_uuid>', true);
```

---

### ai_memory — приватная память пользователя

```sql
create table if not exists public.ai_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text,
  cluster text not null default 'general',
  -- кластеры: 'personal' | 'project' | 'health' | 'finance' | 'family'
  summary text not null,           -- выжимка < 200 символов
  importance smallint not null default 3, -- 1–5
  accepted boolean default null,   -- null=ожидает, true/false=решено
  tags text[] default '{}',
  expires_at timestamptz,          -- null = бессрочно
  created_at timestamptz not null default now(),
  compacted_at timestamptz         -- дата сжатия в архив
);

alter table public.ai_memory enable row level security;

create policy "user reads own memory"
  on public.ai_memory for select using (auth.uid() = user_id);
create policy "user writes own memory"
  on public.ai_memory for insert with check (auth.uid() = user_id);
create policy "user updates own memory"
  on public.ai_memory for update using (auth.uid() = user_id);
create policy "user deletes own memory"
  on public.ai_memory for delete using (auth.uid() = user_id);
```

---

### note_analysis — кэш AI-разборов

```sql
create table if not exists public.note_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null,
  analysis jsonb not null,
  model text not null,
  tokens_used int,
  accepted_actions text[] default '{}',
  rejected_actions text[] default '{}',
  created_at timestamptz not null default now()
);

alter table public.note_analysis enable row level security;

create policy "user reads own analysis"
  on public.note_analysis for select using (auth.uid() = user_id);
create policy "user writes own analysis"
  on public.note_analysis for insert with check (auth.uid() = user_id);
```

---

### project_memory — проектный кластер (только admin)

```sql
create table if not exists public.project_memory (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id),
  source_note_id text,
  type text not null,
  -- 'bug' | 'idea' | 'decision' | 'todo' | 'prompt' | 'architecture' | 'deploy' | 'ux'
  summary text not null,
  detail text,
  target_docs text[] default '{}',
  -- ['MASTER.md', 'TODO.md', 'CHANGELOG.md', 'SUPER_PROMPT.md']
  status text not null default 'candidate',
  -- 'candidate' | 'accepted' | 'rejected' | 'shipped'
  importance smallint not null default 3,
  ai_suggested boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.project_memory enable row level security;

create policy "project admins read project memory"
  on public.project_memory for select
  using (
    exists (
      select 1 from public.profiles
      where user_id = auth.uid() and is_project_admin = true
    )
  );

create policy "project admins write project memory"
  on public.project_memory for insert
  with check (
    exists (
      select 1 from public.profiles
      where user_id = auth.uid() and is_project_admin = true
    )
  );

create policy "project admins update project memory"
  on public.project_memory for update
  using (
    exists (
      select 1 from public.profiles
      where user_id = auth.uid() and is_project_admin = true
    )
  );
```

---

### recovery_options — восстановление доступа

```sql
create table if not exists public.recovery_options (
  user_id uuid primary key references auth.users(id) on delete cascade,
  backup_email text,
  recovery_code_hash text,          -- bcrypt хэш, не сам код
  recovery_code_created_at timestamptz,
  trusted_contact_email text,       -- этап 5
  passkey_registered boolean default false, -- этап 5
  export_requested_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.recovery_options enable row level security;

create policy "user reads own recovery"
  on public.recovery_options for select using (auth.uid() = user_id);
create policy "user writes own recovery"
  on public.recovery_options for insert with check (auth.uid() = user_id);
create policy "user updates own recovery"
  on public.recovery_options for update using (auth.uid() = user_id);
```

---

### memory_events — audit log

```sql
create table if not exists public.memory_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  -- 'hint_accepted' | 'hint_rejected' | 'memory_added' | 'memory_compacted' | 'export_requested'
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table public.memory_events enable row level security;

create policy "user inserts own events"
  on public.memory_events for insert with check (auth.uid() = user_id);
create policy "user reads own events"
  on public.memory_events for select using (auth.uid() = user_id);
```

---

## RLS-матрица

| Таблица            | Обычный пользователь | Project admin  | Service role |
|--------------------|----------------------|----------------|--------------|
| `user_state`       | своя строка          | своя строка    | всё          |
| `ai_memory`        | свои строки          | свои строки    | всё          |
| `note_analysis`    | свои строки          | свои строки    | всё          |
| `project_memory`   | ❌ нет доступа       | все строки     | всё          |
| `recovery_options` | своя строка          | своя строка    | всё          |
| `memory_events`    | свои события         | свои события   | всё          |
| `profiles`         | читает свой          | читает свой    | всё          |

---

## JSON-форматы

### Расширенный ответ Edge Function

```json
{
  "summary": "Пользователь хочет починить вход в Supabase после смены почты",
  "tags": ["supabase", "auth", "баг"],
  "actions": [
    "Открыть Supabase Dashboard → Authentication",
    "Проверить настройки OTP"
  ],
  "type": "task",
  "level": "normal",
  "microHint": "Похоже на техническую задачу. Добавить в TODO?",
  "reminderCandidate": null,
  "question": null,
  "confidence": 0.87,
  "safety": "ok",
  "memoryCandidate": "Проблема с Supabase OTP после смены почты",
  "cluster": "project",
  "importance": 4,
  "projectCandidate": {
    "type": "bug",
    "summary": "OTP не приходит после смены primary email в Supabase",
    "targetDocs": ["TODO.md"]
  }
}
```

### Запись в ai_memory

```json
{
  "user_id": "uuid",
  "note_id": "note_1748xxx",
  "cluster": "personal",
  "summary": "Планирует купить лекарства бабушке до пятницы",
  "importance": 3,
  "accepted": true,
  "tags": ["покупки", "семья"],
  "expires_at": "2026-05-25T00:00:00Z"
}
```

### Запись в project_memory

```json
{
  "author_id": "uuid",
  "source_note_id": "note_1748yyy",
  "type": "bug",
  "summary": "Кнопка ✦ AI не реагирует при тексте < 10 символов",
  "detail": "Фронт не показывает ошибку, Edge Function возвращает 400.",
  "target_docs": ["TODO.md"],
  "status": "candidate",
  "importance": 4,
  "ai_suggested": true
}
```

### Контекст AI-запроса с памятью

```json
{
  "action": "analyze",
  "payload": {
    "text": "надо заехать к врачу и взять справку",
    "memoryContext": [
      "Часто записывает дела, связанные с семьёй",
      "Ранее откладывал медицинские задачи",
      "Принимает напоминания о важных делах"
    ],
    "userLevel": "beginner",
    "recentHints": {
      "accepted": ["reminder", "checklist"],
      "rejected": ["internet_search"]
    }
  }
}
```

---

## Edge Function: новые actions

Добавить в `supabase/functions/ai/index.ts` (или в `smooth-processor`):

```typescript
// action: 'save_to_project'
// Проверяет is_project_admin, пишет в project_memory
if (action === 'save_to_project') {
  const { entry } = payload ?? {};
  // проверить admin через profiles
  // записать в project_memory
  return json({ saved: true });
}

// action: 'project_digest'
// Собирает candidate из project_memory, отправляет в Claude
// Возвращает готовые блоки Markdown для TODO/MASTER/CHANGELOG
if (action === 'project_digest') {
  // fetch project_memory WHERE status = 'candidate'
  // Claude: "Сгруппируй по документам и верни markdown блоки"
  return json({ digest: markdownBlocks });
}

// action: 'save_memory'
// Пишет в ai_memory после согласия пользователя
if (action === 'save_memory') {
  const { summary, cluster, importance, tags, noteId } = payload ?? {};
  // INSERT INTO ai_memory
  return json({ saved: true });
}
```

---

## Экономика токенов

**Формула одного запроса:**
```
системный промт      ~300 токенов
текст заметки        ~500 токенов (max)
memory_context       ~300 токенов (5 выжимок × 60 символов)
recentHints          ~100 токенов
─────────────────────────────────
input total          ~1200 токенов
output               ~200 токенов

Haiku 4.5: ~$0.0012 за запрос
1000 запросов/день  = ~$1.20/день
```

**Правила снижения стоимости:**

| Приём | Экономия |
|-------|----------|
| Summaries вместо полного текста | −60% токенов контекста |
| `importance >= 3` фильтр | −40% memory в запрос |
| Кэш `note_analysis` (не анализировать дважды) | −30% повторных запросов |
| Compaction старой памяти в один блок | −50% старого контекста |
| Только user-approved записи в memory | качество > количество |

**Лимит:** 20 AI-запросов в день на пользователя (считать через `memory_events`).

---

## Поэтапный план внедрения

### ✅ Этап 0 — Базовый AI (выполнено 2026-05-18)
- Кнопка `✦ AI` работает
- Edge Function → Claude → `summary`, `tags`, `actions`
- `ANTHROPIC_API_KEY` в Supabase Secrets
- Модель: `claude-haiku-4-5-20251001`

---

### 🔄 Этап 1 — Проектный кластер (текущий)

**Цель:** мы сами можем писать заметки о разработке и AI их собирает.

Чеклист:
- [ ] Выполнить SQL всех таблиц выше в Supabase → SQL Editor
- [ ] `INSERT INTO profiles (user_id, is_project_admin) VALUES ('<uuid>', true)`
- [ ] Добавить `action: 'save_to_project'` в Edge Function
- [ ] В `loadAll()` подгружать `isAdmin` из `profiles` и сохранять в переменную
- [ ] Показывать кнопку "Запомнить для проекта" ТОЛЬКО если `isAdmin = true`
- [ ] Проверить RLS: залогиниться обычным пользователем → убедиться что `project_memory` пустая

**НЕ ДЕЛАТЬ:** не показывать проектный UI обычным пользователям.

---

### 📋 Этап 2 — Кнопка и микроблок

**Цель:** после AI-анализа предлагать сохранить в проект одним нажатием.

```
┌──────────────────────────────────────────────────┐
│ ✦ Похоже, это техническая задача по проекту.    │
│   Добавить в TODO «Разберёмся»?                  │
│                                                  │
│  [Добавить]  [Не надо]  [Почему это?]           │
└──────────────────────────────────────────────────┘
```

Чеклист:
- [ ] Расширить ответ AI полем `projectCandidate`
- [ ] Показывать микроблок если `projectCandidate !== null && isAdmin`
- [ ] Клик "Добавить" → `action: 'save_to_project'`
- [ ] Клик "Не надо" → `memory_events` с `hint_rejected`
- [ ] Клик "Почему это?" → показать одно предложение из `projectCandidate.summary`

---

### 📊 Этап 3 — AI-сводка для документов

**Цель:** по запросу получать готовые блоки для MASTER/TODO/CHANGELOG.

```
action: 'project_digest'
→ Claude группирует все candidate по target_docs
→ Возвращает markdown блоки готовые для вставки
```

Чеклист:
- [ ] Добавить `action: 'project_digest'` в Edge Function
- [ ] Показывать результат в отдельном экране (только admin)
- [ ] Кнопки: "Скопировать для TODO" / "Скопировать для MASTER"
- [ ] После копирования → обновить статус в `project_memory` на `accepted`

---

### 🧠 Этап 4 — Клиентская ai_memory

**Цель:** у каждого пользователя накапливается приватная память.

Чеклист:
- [ ] После анализа заметки: если `importance >= 3` → микроблок "Запомнить?"
- [ ] Клик "Запомнить" → `action: 'save_memory'` → INSERT в `ai_memory`
- [ ] В следующем запросе подгружать последние 5-7 memory (importance ≥ 3) как `memoryContext`
- [ ] В `loadAll()` подгружать `userLevel` из последних `memory_events`
- [ ] Показывать в настройках счётчик "Запомнено X вещей"

---

### 🔐 Этап 5 — Восстановление доступа

**Цель:** пользователь не теряет данные при смене телефона/почты.

Порядок внедрения (от простого к сложному):
1. Резервная почта (форма в настройках)
2. Recovery code (показать один раз, хранить только хэш bcrypt)
3. Экспорт архива (ZIP всех заметок + memory)
4. История версий (last 10 snapshots user_state)
5. Доверенный контакт (этап 5b)
6. Passkey (этап 5c, после остальных)

---

### ⚡ Этап 6 — Оптимизация и поиск

**Цель:** система не замедляется при росте базы.

Чеклист:
- [ ] Compaction: раз в неделю сжимать memory старше 30 дней
- [ ] Архивировать записи с `importance < 2` старше 14 дней
- [ ] Добавить `tokens_used` в `note_analysis` для мониторинга
- [ ] Admin-дашборд: сколько токенов потрачено за неделю
- [ ] Embeddings + pgvector (Supabase) — для семантического поиска по памяти
- [ ] Лимит запросов через подсчёт `memory_events` за 24 часа

---

## UX-правила микроблоков

1. **Одна подсказка за раз** — никогда не показывать две одновременно
2. **Короткий текст** — максимум 2 строки + 2-3 кнопки
3. **Всегда есть "Не надо"** — пользователь всегда может отказаться
4. **Отказы считаются** — три подряд отказа → снизить частоту на 30 дней
5. **"Почему это?"** — раскрывает одно предложение объяснения
6. **Не менять текст заметки** — только предлагать, никогда автоматически

---

## Риски

| Риск | Вероятность | Контрмера |
|------|-------------|-----------|
| Личная заметка попадает в project_memory | средняя | RLS + кнопка только для admin |
| AI делает ложный вывод о типе | высокая | Всегда подтверждение перед записью |
| Потеря контекста при compaction | средняя | importance ≥ 4 не сжимать, архивировать |
| Стоимость растёт с базой | низкая | Лимит 20 запросов/день, importance-фильтр |
| Пользователь теряет доступ | высокая для ЦА | Этап 5 делать раньше, чем кажется |
| Утечка project_memory через баг RLS | низкая | Тестировать с JWT обычного пользователя |
| Смешение личных и проектных заметок | средняя | `cluster` поле + явный UI-разделитель |

---

## НЕ ДЕЛАТЬ

- ❌ Не хранить API keys нигде кроме Supabase Secrets
- ❌ Не вызывать `api.anthropic.com` напрямую из браузера
- ❌ Не давать обычным пользователям видеть project_memory
- ❌ Не отправлять весь user_state в каждый AI-запрос
- ❌ Не менять заметку автоматически без согласия
- ❌ Не делать embeddings до стабилизации базовой памяти
- ❌ Не строить UI управления project_memory — читать через Supabase Dashboard
- ❌ Не делать autocompaction — только ручной запуск на первых этапах
- ❌ Не смешивать личные и проектные заметки в одной таблице
- ❌ Не хранить recovery code в открытом виде — только bcrypt хэш

---

## Текущий статус

| Этап | Статус |
|------|--------|
| 0 — Базовый AI | ✅ Выполнен 2026-05-18 |
| 1 — Проектный кластер | 🔄 В работе |
| 2 — Кнопка и микроблок | ⏳ Следующий |
| 3 — AI-сводка для docs | ⏳ Планируется |
| 4 — Клиентская ai_memory | ⏳ Планируется |
| 5 — Восстановление доступа | ⏳ Планируется |
| 6 — Оптимизация и поиск | ⏳ Далеко |
