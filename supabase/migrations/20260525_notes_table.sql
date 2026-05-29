-- ══════════════════════════════════════════════════════
-- Notes table — миграция заметок из user_state JSON-блоба
-- Выполнить в Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notes (
  id          text PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title       text,
  body        text,
  label       text DEFAULT 'заметка',
  reminder    text,          -- ISO datetime "2026-05-25T15:00"
  recurring   jsonb,         -- {times:["09:00"], days:"daily"}
  ai_tags     text[],
  ai_summary  text,
  ai_cache    jsonb,
  items       jsonb,         -- list-mode [{t:"text", d:false}]
  from_pad    boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz    -- NULL = активная, NOT NULL = в корзине
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own notes"
  ON notes FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Загрузка заметок пользователя по дате (основной запрос)
CREATE INDEX IF NOT EXISTS notes_user_active_idx
  ON notes(user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Быстрый поиск напоминаний
CREATE INDEX IF NOT EXISTS notes_reminder_idx
  ON notes(user_id, reminder)
  WHERE reminder IS NOT NULL AND deleted_at IS NULL;

-- Полнотекстовый поиск (для будущего поиска по заметкам)
CREATE INDEX IF NOT EXISTS notes_search_idx
  ON notes USING gin(to_tsvector('russian', coalesce(title,'') || ' ' || coalesce(body,'')));
