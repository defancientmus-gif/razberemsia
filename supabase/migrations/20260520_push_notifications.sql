-- ══════════════════════════════════════════════════════
-- VAPID Push Notifications — миграция
-- Выполнить в Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

-- 1. Push subscriptions (endpoint браузера + ключи шифрования)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,  -- ключ шифрования payload
  auth        text NOT NULL,  -- auth secret
  user_agent  text,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own push subscriptions"
  ON push_subscriptions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 2. Reminders (серверная копия напоминаний для cron-отправки)
CREATE TABLE IF NOT EXISTS reminders (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  note_id     text NOT NULL,
  note_title  text,
  note_body   text,
  remind_at   timestamptz NOT NULL,
  sent        boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own reminders"
  ON reminders FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Индекс для быстрого поиска несрабатывавших напоминаний
CREATE INDEX IF NOT EXISTS reminders_pending_idx
  ON reminders(remind_at) WHERE sent = false;

-- 3. pg_cron + pg_net — отправка каждую минуту
-- Включить расширения (уже включены в большинстве Supabase проектов):
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- Cron job: каждую минуту вызывает Edge Function push-sender
-- Раскомментировать и заменить URL + SERVICE_ROLE_KEY после деплоя функции:
/*
SELECT cron.schedule(
  'send-push-reminders',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://izvwgyudjbxlixzrgpuv.supabase.co/functions/v1/push-sender',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer SUPABASE_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  );
  $$
);
*/
