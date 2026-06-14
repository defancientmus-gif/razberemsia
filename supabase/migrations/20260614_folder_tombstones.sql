-- ══════════════════════════════════════════════════════
-- user_state: колонка надгробий папок (folder_tombstones)
-- Лечит воскрешение удалённых папок при синхронизации между устройствами.
-- Выполнить в Supabase Dashboard → SQL Editor.
-- Безопасно: IF NOT EXISTS + DEFAULT — не ломает существующие строки.
--
-- Формат: {"tags":{"<tagKey>":<deletedAtMs>}, "users":{"<nameLow>":<deletedAtMs>}}
-- Клиент сам начнёт писать сюда, как только увидит колонку в SELECT.
-- ══════════════════════════════════════════════════════

ALTER TABLE user_state ADD COLUMN IF NOT EXISTS folder_tombstones jsonb DEFAULT '{}'::jsonb;
