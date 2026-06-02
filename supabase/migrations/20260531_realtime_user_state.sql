-- ══════════════════════════════════════════════════════
-- Включить Supabase Realtime для user_state
-- Выполнить в Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

-- Полная идентичность строки нужна для передачи old/new в UPDATE-событиях
ALTER TABLE user_state REPLICA IDENTITY FULL;

-- Добавить таблицу в публикацию realtime (если ещё не добавлена)
ALTER PUBLICATION supabase_realtime ADD TABLE user_state;
