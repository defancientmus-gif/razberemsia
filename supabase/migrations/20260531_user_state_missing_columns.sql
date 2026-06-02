-- ══════════════════════════════════════════════════════
-- user_state: добавить все недостающие колонки
-- Выполнить в Supabase Dashboard → SQL Editor
-- Безопасно: IF NOT EXISTS не ломает если колонка уже есть
-- ══════════════════════════════════════════════════════

ALTER TABLE user_state ADD COLUMN IF NOT EXISTS ai_memory   jsonb DEFAULT '[]'::jsonb;
ALTER TABLE user_state ADD COLUMN IF NOT EXISTS user_folders jsonb DEFAULT '[]'::jsonb;
ALTER TABLE user_state ADD COLUMN IF NOT EXISTS tag_folders  jsonb DEFAULT '[]'::jsonb;
