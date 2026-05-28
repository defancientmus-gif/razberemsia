# NEXT — текущая задача и контекст сессии

> Этот файл читается ПЕРВЫМ в каждой сессии.
> Обновляется в конце каждой сессии — что сделано, что следующее.

---

## Последняя сессия — 2026-05-28 (rz-v257)

**Сделано:**
- ✅ **Inbox delete fix** (rz-v256): убрали ненадёжный swipe-reveal для inbox-карточек, добавили кнопку `×` прямо в карточку — надёжно работает на iOS
- ✅ **Reminder redesign** (rz-v257): полный TickTick-стиль — чекбокс слева, тайм и ··· справа, анимация «галочка → исчезновение», без кнопок действий снизу
- ✅ **save_idea bug fix** (rz-v257): агент больше не пишет в удалённую папку `ideas/` — теперь дописывает в `texts/IDEAS_NEAR_TERM.md` (функция `appendToGitHub`)

**Текущий SW cache:** `rz-v257`

---

## Аудит кода 2026-05-28 — найденные баги

### Исправлены сегодня:
- ✅ `save_idea` → `ideas/` (удалена) → теперь `texts/IDEAS_NEAR_TERM.md`
- ✅ Reminder panel — TickTick redesign (checkboxes + collapse animation)
- ✅ Inbox delete — swipe-reveal заменён на прямую кнопку

### Не критичные, отложены:
- 🟡 `loadNotes()` сбрасывает `drillLevel=0` при каждом вызове — вызывает 50ms flash к level 0 при сохранении из секции. Workaround: setTimeout(drillGo, 50). Cosmetic.
- 🟡 `attachSwipeDelete(d, delBg, null, 116)` в loadNotepad — лишние аргументы (null, 116) игнорируются. Dead code smell.
- 🟡 Множественные `loadAll()` вызовы при одном действии (loadNotes+loadHomeFeed+loadNotepad). Работает, но не оптимально. Нужен debounce через requestAnimationFrame.
- 🟡 `_drillInitSwipe` — listener leak guard работает (`_drillSwipeInited`). НЕ баг.
- 🟡 textarea event listeners — cloneNode pattern корректно удаляет. НЕ баг.

### В следующей сессии:
- 🔜 **Lists toolbar** — кнопки форматирования над клавиатурой в редакторе заметки (сейчас `tools-row` hidden по умолчанию, ToggleToolsRow работает — но нужно доделать inline list toggle внутри textarea)
- 🔜 **AI Analysis Overlay** — всплывающая панель поверх заметки (из NEXT.md #11)

---

## Архитектура (важно знать — предыдущие сессии)

### AI Context Engine (rz-v254)
- `_agentViewCtx` — где пользователь (section/folder/home)
- `_buildAgentContext()` — top notes, section stats, inbox stats, upcoming reminders
- `_trackNoteOpen(id)` — открытие заметки, at 5+ opens → ai_memory
- `_getNoteStats()` → `localStorage rz_note_stats`

### Session conversation history (rz-v253)
- `_agentHistory[]` — 4 хода, 15 мин TTL
- `_agentHistoryTs` — timestamp последнего хода
- Передаётся агенту в каждом запросе как `conversationHistory`

### Notes context (rz-v252)
- 40 заметок (было 30)
- `createdAt`, `updatedAt`, `section` в каждой заметке
- `needsDeepCtx` — расширенный body (400 символов) для "сводки/плана/расскажи"

### Timezone fix (rz-v249)
- `clientNow` / `clientTz` передаются с каждым запросом
- Claude получает `ТЕКУЩАЯ ДАТА И ВРЕМЯ ПОЛЬЗОВАТЕЛЯ:` в промпт

---

## Архитектура (базовая)

**AI-папки** (`drillAiTag`) = входящий ящик (авт.)
**Разделы** (`getUserFolders`) = база данных (пользователь)
**`_filed_in:ИМЯ`** → заметка принадлежит разделу → статус «разобрались»

---

## Стек

| Что | Где |
|-----|-----|
| UI | `index.html` + `js/app.js` |
| PWA кэш | `sw.js` → `const CACHE = 'rz-vXXX'` |
| AI | `supabase/functions/ai/index.ts` |
| Здоровье | `supabase/functions/health/index.ts` |
| Прод | https://defancientmus-gif.github.io/razberemsia/ |
| Деплой | `./deploy.sh "описание"` |

---

## Следующие задачи (в порядке приоритета)

1. 🔥 **AI Analysis Overlay** — панель AI поверх заметки (NEXT.md #11)
2. 🔜 **Lists toolbar** — кнопки форматирования над клавиатурой в заметке
3. 🔜 **Supabase Auth** — JWT expiry 30 дней, выключить Phone provider
4. 🔜 **Серверный DAILY_BRIEFING** — агент читает reminders из БД
5. 🔜 **Realtime sync** — Supabase Realtime WebSocket

---

## Технический долг

- `loadNotes()` reset drill → flash → cosmetic workaround работает
- `attachSwipeDelete(d,delBg,null,116)` — лишние аргументы (notepad), мелочь
- GIN-индекс поиска по-русски в `notes` — серверный поиск
- `_deduplicateRecurringNotes()` — нет тестов на edge cases
