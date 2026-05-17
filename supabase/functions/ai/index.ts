// supabase/functions/ai/index.ts
// Деплой: supabase functions deploy ai --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY в Supabase Dashboard → Settings → Edge Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL')?.trim() || 'claude-haiku-4-5-20251001';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function normalizeArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseJsonObject(raw: string) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500);
  if (!SB_URL || !SB_ANON) return json({ error: 'Supabase env is not configured' }, 500);

  // Проверяем сессию
  const auth = req.headers.get('Authorization') ?? '';
  const sb = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { action, payload } = body ?? {};

  if (action === 'analyze') {
    const { text } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 10) {
      return json({ error: 'Text too short' }, 400);
    }
    const safeText = text.trim().slice(0, 6000);

    const prompt = `Ты помощник приложения «Разберёмся» — спокойный и человечный. 
Проанализируй заметку пользователя и верни JSON (только JSON, без markdown):
{
  "summary": "одно предложение — суть заметки по-русски",
  "tags": ["тег1", "тег2", "тег3"],
  "actions": ["что можно сделать 1", "что можно сделать 2"]
}

Заметка:
${safeText}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return json({ error: data?.error?.message || 'Anthropic request failed' }, res.status);
    }
    const raw = data.content?.[0]?.text ?? '{}';
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') {
      return json({ error: 'AI returned invalid JSON' }, 502);
    }

    const result = {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      tags: normalizeArray(parsed.tags, 5),
      actions: normalizeArray(parsed.actions, 5),
    };

    return json(result);
  }

  return json({ error: 'Unknown action' }, 400);
});
