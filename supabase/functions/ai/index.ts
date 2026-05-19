// supabase/functions/ai/index.ts
// Деплой: supabase functions deploy ai --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY, GITHUB_TOKEN — Supabase Dashboard → Settings → Edge Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY  = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL')?.trim() || 'claude-haiku-4-5-20251001';
const SB_URL         = Deno.env.get('SUPABASE_URL') ?? '';
const SB_ANON        = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GITHUB_TOKEN   = Deno.env.get('GITHUB_TOKEN') ?? '';
const GITHUB_REPO    = Deno.env.get('GITHUB_REPO') ?? 'defancientmus-gif/razberemsia';

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
    try { return JSON.parse(match[0]); } catch (_) { return null; }
  }
}

// ── Сохранить файл в GitHub через Contents API ──
async function saveToGitHub(path: string, content: string, message: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!GITHUB_TOKEN) return { ok: false, error: 'GITHUB_TOKEN not configured' };

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  // Проверяем — файл уже есть? (нужен sha для обновления)
  let sha: string | undefined;
  try {
    const check = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'razberemsia-bot' },
    });
    if (check.ok) {
      const meta = await check.json();
      sha = meta.sha;
    }
  } catch (_) { /* файла нет — это нормально */ }

  const body: Record<string, unknown> = { message, content: encoded };
  if (sha) body.sha = sha;

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'razberemsia-bot',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }
  const data = await res.json();
  return { ok: true, url: data.content?.html_url };
}

// ── Дата для имени файла ──
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')   return json({ error: 'Method not allowed' }, 405);
  if (!ANTHROPIC_KEY)          return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500);
  if (!SB_URL || !SB_ANON)    return json({ error: 'Supabase env is not configured' }, 500);

  const auth = req.headers.get('Authorization') ?? '';
  const sb   = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: 'Invalid JSON body' }, 400); }
  const { action, payload } = body ?? {};

  // ── ANALYZE ──
  if (action === 'analyze') {
    const { text, memoryContext } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 10) return json({ error: 'Text too short' }, 400);
    const safeText = text.trim().slice(0, 6000);

    const memLines    = normalizeArray(memoryContext, 7).map((s) => s.slice(0, 200));
    const memoryBlock = memLines.length > 0
      ? `\nКонтекст — что пользователь записывал раньше:\n${memLines.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
      : '';

    const prompt = `Ты помощник приложения «Разберёмся» — спокойный и человечный.
Анализируй заметку внимательно и учитывай контекст прошлых записей, если он есть.
Верни только JSON, без markdown и пояснений:
{
  "summary": "одно предложение — суть заметки по-русски",
  "tags": ["тег1", "тег2", "тег3"],
  "actions": ["что можно сделать 1", "что можно сделать 2"]
}
${memoryBlock}
Новая заметка:
${safeText}`;

    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 350, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'Anthropic request failed' }, res.status);

    const raw    = data.content?.[0]?.text ?? '{}';
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return json({ error: 'AI returned invalid JSON' }, 502);

    const result = {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      tags:    normalizeArray(parsed.tags, 5),
      actions: normalizeArray(parsed.actions, 5),
    };
    return json(result);
  }

  // ── REWRITE ──
  if (action === 'rewrite') {
    const { text } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 10) return json({ error: 'Text too short' }, 400);
    const safeText = text.trim().slice(0, 4000);

    const prompt = `Ты помощник приложения «Разберёмся» — спокойный и человечный.
Улучши текст заметки: исправь ошибки, сделай понятнее, убери лишнее — но сохрани смысл и голос автора.
Не добавляй ничего от себя. Верни только улучшенный текст, без комментариев и объяснений.

Заметка:
${safeText}`;

    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'Anthropic request failed' }, res.status);

    const rewritten = data.content?.[0]?.text?.trim() ?? '';
    if (!rewritten) return json({ error: 'Empty response from AI' }, 502);
    return json({ rewritten });
  }

  // ── SAVE_IDEA ──
  // Сохраняет заметку-идею в папку ideas/ репозитория через GitHub API
  if (action === 'save_idea') {
    const { text, summary, tags, actions: ideaActions, noteId } = payload ?? {};

    if (typeof text !== 'string' || text.trim().length < 5) return json({ error: 'Text too short' }, 400);
    if (!GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN not configured in Supabase Secrets' }, 500);

    const date     = todayStr();
    const shortId  = (noteId || Date.now().toString(36)).slice(-6);
    const filename = `ideas/${date}_${shortId}.md`;

    const tagsLine    = Array.isArray(tags)    ? tags.join(', ')        : '';
    const actionsLine = Array.isArray(ideaActions) ? ideaActions.map(a => `- ${a}`).join('\n') : '';

    const mdContent = `# Идея — ${date}

## Заметка

${text.trim()}

## AI-разбор

**Суть:** ${summary || '—'}

**Теги:** ${tagsLine || '—'}

**Можно сделать:**
${actionsLine || '—'}

---
_Сохранено автоматически приложением «Разберёмся»_
`;

    const commitMsg = `idea: ${(summary || text.trim().slice(0, 60)).replace(/\n/g, ' ')}`;
    const result    = await saveToGitHub(filename, mdContent, commitMsg);

    if (!result.ok) return json({ error: result.error || 'GitHub save failed' }, 502);
    return json({ saved: true, url: result.url, file: filename });
  }

  return json({ error: 'Unknown action' }, 400);
});
