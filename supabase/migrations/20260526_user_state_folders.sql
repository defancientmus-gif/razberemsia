-- ══════════════════════════════════════════════════════
-- user_state: добавить синхронизацию папок агента и разделов пользователя
-- Выполнить в Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

-- Пользовательские разделы (Архив): [{name, createdAt, idx}]
ALTER TABLE user_state
  ADD COLUMN IF NOT EXISTS user_folders jsonb DEFAULT '[]'::jsonb;

-- AI-папки (Входящие): [{tag, label, createdAt}]
ALTER TABLE user_state
  ADD COLUMN IF NOT EXISTS tag_folders jsonb DEFAULT '[]'::jsonb;
