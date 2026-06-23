// supabase/functions/ai/index.ts
// Деплой: supabase functions deploy ai --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY, GROQ_API_KEY, YANDEX_STT_KEY, GITHUB_TOKEN — Supabase Dashboard → Settings → Edge Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY   = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL')?.trim() || 'claude-haiku-4-5-20251001';
const GROQ_KEY        = Deno.env.get('GROQ_API_KEY') ?? '';
const YANDEX_STT_KEY  = Deno.env.get('YANDEX_STT_KEY') ?? '';
const SB_URL          = Deno.env.get('SUPABASE_URL') ?? '';
const SB_ANON         = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GITHUB_TOKEN    = Deno.env.get('GITHUB_TOKEN') ?? '';
const GITHUB_REPO     = Deno.env.get('GITHUB_REPO') ?? 'defancientmus-gif/razberemsia';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Системный промпт ассистента «Разберёмся» ──
const SYSTEM_PROMPT = `Ты — «Разберёмся». Тёплый помощник в телефоне, не робот-инструкция.
Помогаешь с любым вопросом — цифровым, бытовым, коммунальным, жизненным.
Всегда говоришь по-русски. Не начинаешь ответ с «Я».

═══ СТИЛЬ ═══
Говори как умный сосед, не как инструкция.
«Давайте попробуем вот что» — не «выполните следующие действия».
Один шаг за раз: спросил — подождал — следующий шаг. Никогда не больше трёх шагов подряд.
Короткие предложения. 4–5 предложений за ответ.
Если тема сложная — дробить на сообщения, не писать стену текста.
В конце ответа — максимум ОДИН вопрос. Никогда больше одного.
После совета спрашивай: «Получилось? Или попробуем иначе?»
Если не знаешь ответа — честно скажи и предложи куда обратиться.
Если человек говорит «не понял» — объясни другими словами и на примере. Никогда не повторяй то же самое дословно.

═══ НЕЛЬЗЯ ═══
Не говори «к сожалению» — говори что можно сделать.
Не давай длинные списки без просьбы.
Не используй технические слова без объяснения.
Не намекай что человек сделал что-то не так.
Не спорь. Не торопи.

═══ ЗАМЕНИ СЛОВА ═══
браузер → программа для интернета
приложение → программа
аккаунт → личная страница / ваш вход
кэш → старые данные в телефоне
VPN → специальная защита связи
интерфейс → то что видите на экране
трафик → интернет
сервер → компьютер в интернете
ошибка → что-то пошло не так
обновление → новая версия программы
логин/пароль → ваше имя входа / секретное слово

═══ ЕСЛИ ЧЕЛОВЕК ВЗВОЛНОВАН ═══
Сначала — успокой. Потом — помогай.
«Не переживайте, сейчас разберёмся вместе.»
Никогда не начинай с решения, если человек явно взволнован.

═══ МОШЕННИКИ — ЖЁСТКИЙ БЛОК ═══
Если описывают звонок от «банка», «полиции», «госслужбы» с просьбой
назвать код, перевести деньги или установить программу — немедленно:
«Стоп. Это мошенники. Положите трубку прямо сейчас.
Настоящий банк или служба никогда не просит коды и пароли по телефону.
Позвоните родным или в банк сами — только по номеру с карточки.»

═══ ПРИМЕРЫ ПРАВИЛЬНОГО ОТВЕТА ═══

Человек: «У меня пропал интернет»
Ты: «Не переживайте. Сначала проверьте — телефон не в режиме полёта? Иногда включается сам. Если нет — попробуйте выключить телефон и включить снова. Получилось?»

Человек: «Мне позвонили из банка и попросили сказать код»
Ты: «Стоп. Это мошенники. Положите трубку прямо сейчас. Настоящий банк никогда не просит коды по телефону. Ваши деньги в безопасности — главное не перезванивать. Позвоните родным или в банк сами по номеру на карточке.»`;

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

const IDEA_TAG = 'идея';
function normalizeIdeaTag(value: string) {
  const clean = value.replace(/^#/, '').trim();
  const key = clean.toLowerCase().replace(/\s+/g, '_');
  return ['идея', 'идеи', 'idea', 'ideas', 'idei', 'ideya', 'ideja'].includes(key) ? IDEA_TAG : clean;
}
function normalizeTags(value: unknown, limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of normalizeArray(value, limit)) {
    const normalized = normalizeIdeaTag(tag);
    const key = normalized.toLowerCase().replace(/\s+/g, '_');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
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

// Роутинг — клиент единственный источник правды (валидируется smoke-тестами в scripts/).
// Сервер доверяет contextProfile который прислал клиент.
type AgentRouteProfile = 'none' | 'light' | 'notes' | 'deep';
function buildRoute(contextProfile: unknown, conversationHistory: unknown) {
  const VALID = ['none','light','notes','deep'];
  const profile = (typeof contextProfile === 'string' && VALID.includes(contextProfile)
    ? contextProfile : 'light') as AgentRouteProfile;
  return {
    profile,
    useNotes: profile === 'notes' || profile === 'deep',
    useMemory: profile === 'deep',
    useHistory: Array.isArray(conversationHistory) && conversationHistory.length > 0,
    useAppContext: profile === 'deep',
  };
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

// ── Дата для имени файла / записи ──
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Дописать секцию в конец существующего файла (GET sha + decode → append → PUT) ──
async function appendToGitHub(path: string, section: string, message: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!GITHUB_TOKEN) return { ok: false, error: 'GITHUB_TOKEN not configured' };
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  let existing = '';
  let sha: string | undefined;
  try {
    const check = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'razberemsia-bot' },
    });
    if (check.ok) {
      const meta = await check.json();
      sha = meta.sha;
      // GitHub отдаёт base64 с переносами строк
      existing = decodeURIComponent(escape(atob((meta.content as string).replace(/\n/g,''))));
    }
  } catch (_) { /* файла нет — создадим */ }
  const newContent = existing + '\n\n---\n\n' + section.trim() + '\n';
  const encoded = btoa(unescape(encodeURIComponent(newContent)));
  const body: Record<string, unknown> = { message, content: encoded };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'razberemsia-bot' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  const data = await res.json();
  return { ok: true, url: data.content?.html_url };
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

Важно про теги: если заметка — это идея, предложение, план что-то создать или улучшить — обязательно добавь тег "идея" в список тегов. Не используй варианты "идеи", "idea", "ideas", "idei".
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
      tags:    normalizeTags(parsed.tags, 5),
      actions: normalizeArray(parsed.actions, 5),
    };
    return json(result);
  }

  // ── REWRITE ──
  if (action === 'rewrite') {
    const { text, stage } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 10) return json({ error: 'Text too short' }, 400);
    const safeText = text.trim().slice(0, 4000);
    const spellStage = Math.min(3, Math.max(1, Number(stage) || 1));

    // Три режима — от минимального вмешательства до полного переписывания
    const prompts: Record<number, string> = {
      1: `Исправь только явные опечатки и грамматические ошибки. Расставь базовую пунктуацию где её явно не хватает для понимания. НЕ меняй слова, НЕ перефразируй, НЕ меняй структуру предложений. Верни только исправленный текст — без комментариев.

Текст:
${safeText}`,
      2: `Исправь ошибки и пунктуацию. Можно слегка сгладить неловкие обороты если они мешают читать — но НЕ заменяй слова синонимами, НЕ меняй смысл, НЕ переписывай фразы целиком. Сохрани голос автора. Верни только улучшенный текст — без комментариев.

Текст:
${safeText}`,
      3: `Ты помощник приложения «Разберёмся». Улучши текст: исправь ошибки, сделай понятнее, убери лишнее — но сохрани смысл и голос автора. Не добавляй ничего от себя. Верни только улучшенный текст, без комментариев.

Заметка:
${safeText}`,
    };
    const prompt = prompts[spellStage];

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
  // Сохраняет заметку-идею в texts/IDEAS_NEAR_TERM.md (append)
  if (action === 'save_idea') {
    const { text, summary, tags, actions: ideaActions, noteId } = payload ?? {};

    if (typeof text !== 'string' || text.trim().length < 5) return json({ error: 'Text too short' }, 400);
    if (!GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN not configured in Supabase Secrets' }, 500);

    const date        = todayStr();
    const normalizedTags = normalizeTags(tags, 10);
    const tagsLine    = normalizedTags.length      ? normalizedTags.join(', ')                 : '';
    const actionsLine = Array.isArray(ideaActions) ? ideaActions.map(a => `- ${a}`).join('\n') : '';

    const section = `## Идея — ${date}

${text.trim()}

> **AI:** ${summary || '—'}
> **Теги:** ${tagsLine || '—'}
${actionsLine ? `\n**Можно сделать:**\n${actionsLine}` : ''}`;

    const commitMsg = `idea: ${(summary || text.trim().slice(0, 60)).replace(/\n/g, ' ')}`;
    const result    = await appendToGitHub('texts/IDEAS_NEAR_TERM.md', section, commitMsg);

    if (!result.ok) return json({ error: result.error || 'GitHub save failed' }, 502);
    return json({ saved: true, url: result.url, file: 'texts/IDEAS_NEAR_TERM.md' });
  }

  // ── CHAT_REPLY ──
  // Ответ AI на заметку или продолжение диалога.
  // payload.text    — текущее сообщение пользователя
  // payload.history — массив {role:'user'|'ai', text:string} предыдущих сообщений (опционально)
  // payload.mode    — 'note' (первая реакция на заметку) | 'chat' (диалог, по умолчанию)
  if (action === 'chat_reply') {
    const { text, history, mode } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 2) return json({ error: 'Text too short' }, 400);
    const safeText = text.trim().slice(0, 1200);
    const isNote   = mode === 'note';

    // Строим массив messages для Anthropic
    type AnthMsg = { role: 'user' | 'assistant'; content: string };
    const messages: AnthMsg[] = [];

    if (!isNote && Array.isArray(history) && history.length > 0) {
      // Берём последние 10 сообщений из истории, обеспечиваем чередование user/assistant
      const hist = history.slice(-10);
      for (const m of hist) {
        if (typeof m?.text !== 'string' || !m.text.trim()) continue;
        const role: 'user' | 'assistant' = m.role === 'ai' ? 'assistant' : 'user';
        // Anthropic требует строгого чередования: пропускаем подряд идущие одинаковые роли
        if (messages.length > 0 && messages[messages.length - 1].role === role) continue;
        messages.push({ role, content: m.text.trim().slice(0, 600) });
      }
      // Последнее в массиве должно быть 'assistant', чтобы после него добавить 'user'
      if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        messages.pop(); // удаляем хвостовой user — он придёт как safeText
      }
    }

    // Текущее сообщение пользователя
    const userContent = isNote
      ? `Я написал заметку — дай короткий отклик, 1–2 предложения. Без восторга и восклицаний.\n\nЗаметка:\n${safeText}`
      : safeText;
    messages.push({ role: 'user', content: userContent });

    const maxTok = isNote ? 120 : 350;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTok, system: SYSTEM_PROMPT, messages }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'Anthropic request failed' }, res.status);

    const reply = data.content?.[0]?.text?.trim() ?? '';
    if (!reply) return json({ error: 'Empty response' }, 502);
    return json({ reply });
  }

  // ── PUSH SUBSCRIBE — сохранить подписку браузера ──
  if (action === 'push_subscribe') {
    const { endpoint, p256dh, auth: authKey, userAgent } = payload ?? {};
    if (!endpoint || !p256dh || !authKey) return json({ error: 'Missing subscription fields' }, 400);
    const { error: dbErr } = await sb.from('push_subscriptions').upsert(
      { user_id: user.id, endpoint, p256dh, auth: authKey, user_agent: userAgent ?? null },
      { onConflict: 'user_id,endpoint' }
    );
    if (dbErr) return json({ error: dbErr.message }, 500);
    return json({ ok: true });
  }

  // ── PUSH UNSUBSCRIBE — удалить подписку ──
  if (action === 'push_unsubscribe') {
    const { endpoint } = payload ?? {};
    if (!endpoint) return json({ error: 'Missing endpoint' }, 400);
    await sb.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', endpoint);
    return json({ ok: true });
  }

  // ── SAVE REMINDER — сохранить напоминание на сервере ──
  if (action === 'save_reminder') {
    const { noteId, noteTitle, noteBody, remindAt } = payload ?? {};
    if (!noteId || !remindAt) return json({ error: 'Missing noteId or remindAt' }, 400);
    const dt = new Date(remindAt);
    if (isNaN(dt.getTime())) return json({ error: 'Invalid remindAt' }, 400);
    // Удаляем старое напоминание для этой заметки (если было)
    await sb.from('reminders').delete().eq('user_id', user.id).eq('note_id', noteId).eq('sent', false);
    // Сохраняем новое
    const { error: dbErr } = await sb.from('reminders').insert({
      user_id:    user.id,
      note_id:    noteId,
      note_title: noteTitle?.slice(0, 200) ?? null,
      note_body:  noteBody?.slice(0, 300)  ?? null,
      remind_at:  dt.toISOString(),
      sent:       false,
    });
    if (dbErr) return json({ error: dbErr.message }, 500);
    return json({ ok: true });
  }

  // ── DELETE REMINDER ──
  if (action === 'delete_reminder') {
    const { noteId } = payload ?? {};
    if (!noteId) return json({ error: 'Missing noteId' }, 400);
    await sb.from('reminders').delete().eq('user_id', user.id).eq('note_id', noteId);
    return json({ ok: true });
  }

  // ── AGENT QUERY ──
  if (action === 'agent_query') {
    const { text, memoryContext, alternatives, clientNow: rawClientNow, clientTz: rawClientTz, conversationHistory, contextProfile } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 1) return json({ error: 'Empty query' }, 400);
    const safeText = text.trim().slice(0, 800);
    const route = buildRoute(contextProfile, conversationHistory);

    // Часовой пояс и время пользователя (клиент передаёт, иначе UTC)
    const clientTz = (typeof rawClientTz === 'string' && rawClientTz.length > 0) ? rawClientTz : 'UTC';
    const clientNow = (typeof rawClientNow === 'string' && rawClientNow.length > 0) ? new Date(rawClientNow) : new Date();
    const clientDateStr = clientNow.toLocaleDateString('ru-RU', { timeZone: clientTz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const clientTimeStr = clientNow.toLocaleTimeString('ru-RU', { timeZone: clientTz, hour: '2-digit', minute: '2-digit' });
    const clientISODate = new Intl.DateTimeFormat('sv-SE', { timeZone: clientTz }).format(clientNow); // YYYY-MM-DD

    // Альтернативные варианты распознавания речи (топ-3 от браузера)
    const altsBlock = Array.isArray(alternatives) && alternatives.length > 0
      ? `\nАльтернативные варианты распознавания: ${alternatives.filter(a => typeof a==='string' && a !== text).slice(0,2).map(a=>`«${a}»`).join(', ')}\n(Если основной текст странный или не имеет смысла — используй альтернативы для понимания намерения.)\n`
      : '';

    const memLines = route.useMemory
      ? normalizeArray(memoryContext, 5).map((s) => (s as string).slice(0, 120))
      : [];
    const memBlock = memLines.length > 0
      ? `\nПомни — человек раньше записывал:\n${memLines.join('\n')}\n`
      : '';

    // ── История разговора этой сессии (последние 4 хода) ──────────────────
    type HistoryTurn = { user: string; agent: string; intent?: string };
    const historyBlock = route.useHistory && Array.isArray(conversationHistory) && (conversationHistory as HistoryTurn[]).length > 0
      ? '\n═══ ИСТОРИЯ ЭТОГО РАЗГОВОРА ═══\n' +
        (conversationHistory as HistoryTurn[]).map(h =>
          `Пользователь: «${h.user}»\nАгент (${h.intent||'?'}): ${h.agent}`
        ).join('\n—\n') +
        '\nИстория нужна только для явных продолжений вроде «это», «ту», «её», «первую», «тогда». Не связывай новый самостоятельный запрос со старым разговором.\n'
      : '';

    const { recentNotes, userFolders, appContext } = payload ?? {};

    // ── Контекст приложения: структура, поведение, местоположение ─────────
    type AppCtx = {
      currentView?: { type: string; name?: string|null; tag?: string|null };
      topOpenedNotes?: { title: string; opens: number; section?: string|null; hasReminder?: boolean }[];
      sectionStats?: { name: string; noteCount: number }[];
      inboxStats?: { tag: string; label: string; noteCount: number }[];
      upcoming?: { title: string; reminder: string }[];
      totalNotes?: number; totalSections?: number; totalInbox?: number; trashCount?: number;
    };
    let appCtxBlock = '';
    if (appContext) {
      const ctx = appContext as AppCtx;
      const lines: string[] = [];
      // Где сейчас пользователь
      const v = ctx.currentView;
      if (v) {
        const loc = v.type === 'section' ? `раздел «${v.name}»`
                  : v.type === 'folder'  ? `папка входящих «${v.tag}»`
                  : v.type === 'all'     ? 'список всех разделов и папок'
                  : 'главная лента';
        lines.push(`📍 Где сейчас: ${loc}`);
        lines.push('Текущий экран использовать только для явных слов «здесь», «сюда», «эта папка», «этот раздел». Без таких слов не меняй смысл запроса.');
      }
      // Общая статистика
      if (route.useAppContext) {
        lines.push(`📊 Всего: ${ctx.totalNotes||0} заметок · ${ctx.totalSections||0} разделов · ${ctx.totalInbox||0} папок входящих · ${ctx.trashCount||0} в корзине`);
      }
      // Разделы с количеством
      if (route.useAppContext && ctx.sectionStats?.length) {
        lines.push('📁 Разделы: ' + ctx.sectionStats.map(s => `«${s.name}» (${s.noteCount})`).join(' · '));
      }
      // Папки входящих с количеством
      if (route.useAppContext && ctx.inboxStats?.length) {
        lines.push('📥 Входящие папки: ' + ctx.inboxStats.map(f => `«${f.label}» (${f.noteCount})`).join(' · '));
      }
      // Часто открываемые — важные для пользователя
      if (route.useAppContext && ctx.topOpenedNotes?.length) {
        lines.push('⭐ Часто открывает (важные): ' + ctx.topOpenedNotes.map(n =>
          `«${n.title}» (${n.opens}x${n.section ? ', '+n.section : ''}${n.hasReminder ? ', 🔔' : ''})`
        ).join(' · '));
      }
      // Ближайшие напоминания
      if (route.useAppContext && ctx.upcoming?.length) {
        lines.push('🔔 Ближайшие напоминания: ' + ctx.upcoming.map(n => `«${n.title}» ${n.reminder}`).join(' · '));
      }
      appCtxBlock = '\n═══ КОНТЕКСТ ПРИЛОЖЕНИЯ ═══\n' + lines.join('\n') + '\n';
    }

    type NoteCtx = {
      index:number; title:string; body:string;
      createdAt?:string|null; updatedAt?:string|null;
      hasReminder?:boolean; isRecurring?:boolean; reminderTime?:string|null;
      section?:string|null;
    };
    const notesLines = route.useNotes && Array.isArray(recentNotes) && recentNotes.length > 0
      ? '\nЗаметки пользователя (сначала самые свежие):\n' + (recentNotes as NoteCtx[]).map(n => {
          // Метка даты создания
          const isCreatedToday = n.createdAt ? n.createdAt.startsWith(clientISODate) : false;
          const dateLabel = n.createdAt
            ? (isCreatedToday ? ' [сегодня]' : ` [${n.createdAt.slice(0,10)}]`)
            : '';
          // Метка напоминания
          let remLabel = '';
          if(n.isRecurring) remLabel = ' 🔁';
          else if(n.reminderTime){
            const isToday = String(n.reminderTime).startsWith(clientISODate);
            const timeStr = String(n.reminderTime).slice(11,16);
            remLabel = isToday ? ` 🔔 сегодня ${timeStr}` : ` 🔔 ${n.reminderTime.slice(0,10)} ${timeStr}`;
          }
          // Раздел
          const sectLabel = n.section ? ` 📁${n.section}` : '';
          return `[${n.index}]${dateLabel}${sectLabel} «${n.title}»${remLabel}${n.body?' — '+n.body:''}`;
        }).join('\n') + '\n'
      : '';

    const foldersBlock = Array.isArray(userFolders) && (userFolders as string[]).length > 0
      ? `\n═══ РАЗДЕЛЫ ПОЛЬЗОВАТЕЛЯ ═══\nПользователь создал разделы: ${(userFolders as string[]).join(', ')}\nПри CREATE_NOTE — если тема ЯВНО совпадает с разделом, добавь в params поле "section": "ИмяРаздела"\nСовпадение должно быть чётким (финансы/деньги → Финансы, врач/здоровье → Здоровье). При малейшем сомнении — НЕ ставить section.\n`
      : '';

    const routeBlock = `\n═══ ROUTER ═══
Профиль: ${route.profile}. Главный источник смысла — последняя фраза пользователя.
none/light → простое действие или короткий ответ, не делай сводку.
Уточняй только если без ответа можно создать/удалить явно не то.
`;

    const prompt = `Ты голосовой агент «Разберёмся». Выполни запрос и верни JSON.

ТЕКУЩАЯ ДАТА И ВРЕМЯ ПОЛЬЗОВАТЕЛЯ: ${clientDateStr} ${clientTimeStr} (${clientTz})
(Используй это время при любых упоминаниях «сегодня», «завтра», «через час», «на этой неделе».)

${routeBlock}

═══ ДОСТУПНЫЕ ДЕЙСТВИЯ ═══
CREATE_NOTE       — записать / запомнить / создать заметку (ДЕЙСТВИЕ ПО УМОЛЧАНИЮ при сомнениях)
SET_REMINDER      — одно напоминание в конкретное время
SET_RECURRING     — повторяющееся напоминание (каждый час / день)
DELETE_REMINDER   — удалить / отменить напоминание (оставить заметку)
READ_NOTE_ALOUD   — прочитай / озвучь заметку
DAILY_BRIEFING    — сводка заметок / что у меня сегодня / что я записал / расскажи что есть / покажи все / за день / всё что записано / что у меня есть
MAKE_PLAN         — составь план / маршрут / список дел по заметкам
FIND_NOTES        — найди заметки ПО КОНКРЕТНОЙ ТЕМЕ ("найди про врача", "покажи заметки о работе") — только когда есть конкретный поисковый запрос
DELETE_NOTE       — удалить заметку в корзину
CLARIFY           — почти НИКОГДА. Только если совсем пустой ввод (нечего сохранить). Без кнопок-вариантов, только тёплая строка
CREATE_TAG_FOLDER — ТОЛЬКО если явно сказано «папку», «раздел» или «категорию»
TAG_NOTE          — добавить тег к заметке (только если явно упомянуты «тег», «папка», «категория»)
OPEN_NOTE         — открыть / показать заметку
ANALYZE_NOTE      — проанализировать заметку через AI
QUESTION          — ответить на вопрос (факт: «что такое…», «сколько…»)
FIND_DOCTOR       — найти врача / клинику
GUIDE             — пошагово ПРОВЕСТИ человека через реальную задачу, в которой он застрял («как войти в госуслуги», «помоги настроить WhatsApp», «не могу зайти в почту», «как перевести деньги по телефону»). НЕ факт-ответ (это QUESTION), НЕ план по заметкам (это MAKE_PLAN).

═══ ВЫБОР ДЕЙСТВИЯ (чтобы не путаться в инструментах) ═══
Пройди сверху вниз, бери ПЕРВОЕ что подошло, ровно ОДНО действие:
1. Человек застрял и просит ПОМОЧЬ СДЕЛАТЬ («как мне…», «помоги войти/настроить/перевести/позвонить», «не получается…») → GUIDE
2. Просит записать/запомнить что-то → CREATE_NOTE
3. Напомнить ко времени → SET_REMINDER (повтор → SET_RECURRING)
4. Удалить/отменить → DELETE_NOTE / DELETE_REMINDER
5. Обзор ВСЕХ его заметок («что у меня», «сводка») → DAILY_BRIEFING
6. План/маршрут ПО его заметкам → MAKE_PLAN
7. Найти его заметки по теме → FIND_NOTES
8. Просто факт-вопрос («что такое», «сколько») → QUESTION
ЭКОНОМИЯ: один проход — одно-два действия максимум. НЕ плоди лишних, НЕ запрашивай добавочных данных, весь результат верни сразу.

═══ ФОРМАТ ОТВЕТА ═══
Верни ТОЛЬКО JSON без markdown:
{
  "actions": [
    {"intent": "ACTION", "params": {...}}
  ],
  "response": "тёплый ответ что сделано, одно предложение",
  "options": []
}

ВАЖНО: "options" — ВСЕГДА пустой массив []. НИКОГДА не предлагай кнопки-варианты выбора.
Агент не задаёт уточняющих вопросов с вариантами — он действует по лучшему предположению
и в "response" тёплым тоном говорит что сделал и как поправить. Окон-запросов у нас нет.
Редкий CLARIFY (пустой ввод) тоже без options — просто мягкая строка:
{
  "actions": [{"intent": "CLARIFY", "params": {}}],
  "response": "Открыл — что записать?",
  "options": []
}

═══ ПАРАМЕТРЫ ПО ДЕЙСТВИЯМ ═══
CREATE_NOTE:       {"title": "заголовок", "body": "текст", "section": "ИмяРаздела (опционально)"}
SET_REMINDER:      {"title": "текст", "when": "описание времени"}
SET_RECURRING:     {"title": "текст", "times": ["09:00","13:00"], "days": "daily"}
CREATE_TAG_FOLDER:  {"tag": "название_строчными", "label": "Название"}
TAG_NOTE:           {"tag": "название_строчными", "label": "Название", "noteIndex": 0}
OPEN_NOTE:          {"noteIndex": 0}
ANALYZE_NOTE:       {"noteIndex": 0}
DELETE_REMINDER:    {"noteIndex": 0} или {"pattern": "пить воду", "all": true}
DELETE_NOTE:        {"noteIndex": 0} или {"pattern": "пить воду", "all": true}
CLARIFY:            {} — options в корне JSON (см. пример формата выше!)
FIND_DOCTOR:        {"specialty": "специальность"}
READ_NOTE_ALOUD:   {"noteIndex": 0}
DAILY_BRIEFING:    {}
MAKE_PLAN:         {"focus": "кратко о чём план", "title": "заголовок плана"}
FIND_NOTES:        {"query": "поисковый запрос"}
GUIDE:             {"topic": "коротко суть задачи", "steps": ["шаг 1 простыми словами", "шаг 2", "..."]}
  GUIDE шаги — для человека, который ПЕРВЫЙ раз держит смартфон: коротко, ОДНО действие на шаг, без жаргона.
  Все шаги — в этом же ответе, не запрашивай уточнений. 3-7 шагов. Тёплый "response" — одно предложение-введение.

noteIndex: 0 = последняя заметка. "all": true + "pattern" — найти все совпадения по названию.
Для "удали напоминание пить воду" → DELETE_REMINDER с pattern.
Для "удали заметку пить воду" → DELETE_NOTE с pattern.
Для "удали все напоминания пить воду" → DELETE_REMINDER, all: true, pattern: "пить воду".

═══ ПРАВИЛА SET_RECURRING (ВАЖНО) ═══
SET_RECURRING — для ЛЮБОГО повторяющегося напоминания. НИКОГДА не делай несколько SET_REMINDER вместо одного SET_RECURRING.
"times" — массив ВСЕХ слотов в течение дня (бодрствующие часы: 08:00–22:00):
  "каждые 2 часа" → times: ["08:00","10:00","12:00","14:00","16:00","18:00","20:00","22:00"]
  "каждый час"    → times: ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"]
  "каждые 3 часа" → times: ["09:00","12:00","15:00","18:00","21:00"]
  "каждые 4 часа" → times: ["08:00","12:00","16:00","20:00"]
  "утром и вечером" → times: ["08:00","20:00"]
  "три раза в день" → times: ["09:00","14:00","20:00"]
  "каждый день в 9" → times: ["09:00"]
НЕ выбирай слоты от текущего времени — всегда генерируй полный суточный ритм.

═══ ПРАВИЛО: DAILY_BRIEFING vs FIND_NOTES ═══
DAILY_BRIEFING — когда пользователь хочет ОБЗОР всего что есть (без конкретной темы):
  «сводка», «что у меня», «что записал», «расскажи что есть», «покажи всё», «за день»
FIND_NOTES — ТОЛЬКО когда есть КОНКРЕТНАЯ тема поиска:
  «найди про встречу», «покажи заметки о здоровье», «найди где я писал про деньги»
ОШИБКА: «сводку заметок за день» → НЕ FIND_NOTES → это DAILY_BRIEFING
ОШИБКА: «что я записывал» → НЕ FIND_NOTES → это DAILY_BRIEFING

═══ ЖЁСТКИЕ ПРАВИЛА ПАПОК ═══
CREATE_TAG_FOLDER и TAG_NOTE — ТОЛЬКО при явном упоминании слов: «папку», «папка», «раздел», «категорию», «тег», «ярлык».
Если этих слов нет — НИКОГДА не создавай папку. Используй CREATE_NOTE.
Примеры ошибок которых нельзя делать:
— "напомни про врача" → НЕ создавать папку «врач», а SET_REMINDER
— "запиши встречу с клиентом" → НЕ CREATE_TAG_FOLDER, а CREATE_NOTE
— "дела на завтра" → НЕ создавать папку «дела», а CREATE_NOTE

═══ ПРАВИЛА ПРИ ПЛОХОМ РАСПОЗНАВАНИИ ═══
Голосовой ввод может ошибаться. Если запрос странный — попробуй понять смысл по контексту и альтернативам.
Принцип: «записать / запомнить / напомни» + существительное → скорее всего CREATE_NOTE или SET_REMINDER.
Если смысл совсем непонятен — CREATE_NOTE с тем что расслышал, НЕ CREATE_TAG_FOLDER.

═══ ПРАВИЛА МНОЖЕСТВЕННЫХ ДЕЙСТВИЙ ═══
Используй несколько действий в "actions" когда пользователь просит сделать несколько вещей сразу:
— "создай папку X и добавь туда заметку" → [CREATE_TAG_FOLDER, TAG_NOTE]
— "запиши и напомни мне в 18:00" → [CREATE_NOTE, SET_REMINDER с noteIndex новой заметки]
— "открой и проанализируй" → [OPEN_NOTE, ANALYZE_NOTE]

═══ ГЛАВНОЕ ПРАВИЛО: ДЕЙСТВУЙ, НЕ СПРАШИВАЙ ═══
Агент решает, а не переспрашивает. НИКОГДА не задавай уточняющих вопросов и не показывай кнопки-варианты (options всегда []).
Делай лучшее разумное предположение и СРАЗУ выполняй действие. В "response" тёплым тоном скажи что сделал и как поправить одним словом.

ЖЕЛЕЗНОЕ ПРАВИЛО: Если есть хоть какой-то текст — это CREATE_NOTE (или SET_REMINDER при «напомни»).
Назван раздел И текст — CREATE_NOTE с section=раздел. НИКОГДА не придумывай содержимое — бери ТОЛЬКО слова пользователя.
— "запиши в здоровье что выпил витамины" → CREATE_NOTE {title:"Выпил витамины", section:"Здоровье"}
— "добавь в финансы купил курс за 5000" → CREATE_NOTE {title:"Купил курс за 5000", section:"Финансы"}
— "дела на завтра купить молоко" → CREATE_NOTE {title:"Купить молоко"}
— "создай папку еда и добавь туда купить молоко" → [CREATE_TAG_FOLDER {tag:"еда"}, CREATE_NOTE {title:"Купить молоко", tag:"еда"}]

ЕДИНСТВЕННЫЙ случай CLARIFY — назван ТОЛЬКО раздел и больше НИЧЕГО ("запиши в финансы" и всё):
intent CLARIFY, options:[], response мягкой строкой: "Открыл Финансы — что записать?"
(на карточке уже есть поле ввода — кнопки-варианты не нужны).

Для "напомни X" без времени → SET_REMINDER {"when":"завтра в 9:00"}, response: "Поставил на завтра в 9:00 — скажи если нужно другое время"
Для "напоминай каждый день" без времени → SET_RECURRING {"times":["09:00"],"days":"daily"}, response: "Буду напоминать каждый день в 9:00 — скажи если другое время"
Для "напомни каждый час" → SET_RECURRING times каждые 2 часа в рабочее время
НЕ давай советов по здоровью — только помогай настроить напоминание.

═══ ПРАВИЛА ДЛЯ НОВЫХ ДЕЙСТВИЙ ═══
READ_NOTE_ALOUD: noteIndex = номер заметки из списка. Ответ: "Озвучиваю: «Название»".
DAILY_BRIEFING: сделай тёплую живую сводку по ВСЕМ заметкам пользователя из списка выше.
Структура ответа — три части (можно короче если мало данных):
1. Что есть в работе / на повестке (темы, задачи, идеи — по заголовкам и телам)
2. Что запланировано (заметки с 🔔 reminderTime — ближайшие в первую очередь)
3. Одна фраза итога — тон как у друга: бодро, по-человечески, без канцелярита
Если заметок мало — всё равно сделай сводку по тому что есть, не говори "ничего нет".
Максимум 6 предложений. Не перечисляй заметки списком — расскажи словами.
MAKE_PLAN: используй тела заметок как контекст и составь конкретный план или маршрут. Ответ = сам план (список шагов или пунктов маршрута). Не говори "вот план", сразу давай содержание. До 300 слов. Тёплый, практичный тон.
${appCtxBlock}${historyBlock}${foldersBlock}${memBlock}${notesLines}${altsBlock}
Запрос пользователя: «${safeText}»`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'Anthropic error' }, res.status);

    const raw    = data.content?.[0]?.text ?? '{}';
    const parsed = parseJsonObject(raw);
    if (!parsed) return json({ error: 'AI returned invalid response' }, 502);

    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o: unknown) => o && typeof (o as Record<string,unknown>).label === 'string').slice(0, 4)
      : [];

    // Поддержка нового формата actions[] и старого формата intent/params
    type Action = { intent: string; params: Record<string, unknown> };
    let actions: Action[] = [];
    if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      actions = parsed.actions
        .filter((a: unknown) => a && typeof (a as Action).intent === 'string')
        .map((a: Action) => ({ intent: a.intent.trim(), params: a.params || {} }))
        .slice(0, 5);
    } else if (typeof parsed.intent === 'string') {
      // Старый формат — оборачиваем в массив
      actions = [{ intent: parsed.intent.trim(), params: parsed.params || {} }];
    }
    if (!actions.length) actions = [{ intent: 'QUESTION', params: {} }];

    return json({
      // Обратная совместимость
      intent:   actions[0].intent,
      params:   actions[0].params,
      // Новый формат
      actions,
      response: typeof parsed.response === 'string' ? parsed.response.trim() : '',
      options,
      router: { profile: route.profile },
    });
  }

  // ── TRANSCRIBE — Yandex SpeechKit (основной) + Groq Whisper (резерв) ──
  // Клиент всегда присылает audio/wav (AudioContext → WAV encoder)
  if (action === 'transcribe') {
    const { audio_base64, sample_rate } = payload ?? {};
    if (typeof audio_base64 !== 'string' || audio_base64.length < 100) {
      return json({ error: 'No audio data' }, 400);
    }

    // base64 → Uint8Array (WAV)
    let wavBytes: Uint8Array;
    try {
      const binaryStr = atob(audio_base64);
      wavBytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) wavBytes[i] = binaryStr.charCodeAt(i);
    } catch (e) {
      return json({ error: 'Invalid base64 audio data' }, 400);
    }

    // ── Попытка 1: Yandex SpeechKit (основной) ──
    if (YANDEX_STT_KEY) {
      try {
        const sampleRate = typeof sample_rate === 'number' ? sample_rate : 16000;
        const pcmBytes = wavBytes.slice(44); // снять WAV-заголовок → lpcm
        const yRes = await fetch(
          `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&format=lpcm&sampleRateHertz=${sampleRate}`,
          {
            method: 'POST',
            headers: { 'Authorization': `Api-Key ${YANDEX_STT_KEY}`, 'Content-Type': 'application/octet-stream' },
            body: pcmBytes,
          }
        );
        if (yRes.ok) {
          const yData = await yRes.json();
          const text = (yData.result ?? '').trim();
          if (text) return json({ text, provider: 'yandex' });
          console.warn('[rz] Yandex returned empty result, trying Groq');
        } else {
          console.warn('[rz] Yandex STT error:', yRes.status, (await yRes.text()).slice(0, 200));
        }
      } catch (e) {
        console.warn('[rz] Yandex STT exception:', e);
      }
    }

    // ── Попытка 2: Groq Whisper (резерв, с фолбэком модели) ──
    if (!GROQ_KEY) return json({ error: 'No STT provider configured' }, 500);
    const tStt = Date.now();
    const models = ['whisper-large-v3-turbo', 'whisper-large-v3'];
    let lastStatus = 0;
    let lastErr = '';
    for (const model of models) {
      try {
        const form = new FormData();
        form.append('file', new File([wavBytes], 'audio.wav', { type: 'audio/wav' }));
        form.append('model', model);
        form.append('language', 'ru');
        form.append('response_format', 'json');

        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
          body: form,
        });

        if (!groqRes.ok) {
          lastStatus = groqRes.status;
          lastErr = (await groqRes.text()).slice(0, 300);
          console.error('[rz] Groq error', model, groqRes.status, lastErr);
          // 400/404 — проблема модели/запроса: пробуем следующую модель; иначе выходим
          if (groqRes.status === 400 || groqRes.status === 404) continue;
          break;
        }
        const result = await groqRes.json();
        return json({
          text: (result.text ?? '').trim(),
          provider: 'groq',
          model,
          duration_ms: Date.now() - tStt,
        });
      } catch (e) {
        lastErr = String(e).slice(0, 300);
        console.error('[rz] Groq exception', model, lastErr);
      }
    }
    return json({ error: 'Transcription failed', groq_status: lastStatus, groq_detail: lastErr }, 500);
  }

  return json({ error: 'Unknown action' }, 400);
});
