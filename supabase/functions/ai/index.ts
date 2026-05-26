// supabase/functions/ai/index.ts
// Деплой: supabase functions deploy ai --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY, GROQ_API_KEY, GITHUB_TOKEN — Supabase Dashboard → Settings → Edge Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY   = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL')?.trim() || 'claude-haiku-4-5-20251001';
const GROQ_KEY        = Deno.env.get('GROQ_API_KEY') ?? '';
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

Важно про теги: если заметка — это идея, предложение, план что-то создать или улучшить — обязательно добавь тег "идеи" в список тегов.
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
    const { text, memoryContext, alternatives } = payload ?? {};
    if (typeof text !== 'string' || text.trim().length < 1) return json({ error: 'Empty query' }, 400);
    const safeText = text.trim().slice(0, 800);

    // Альтернативные варианты распознавания речи (топ-3 от браузера)
    const altsBlock = Array.isArray(alternatives) && alternatives.length > 0
      ? `\nАльтернативные варианты распознавания: ${alternatives.filter(a => typeof a==='string' && a !== text).slice(0,2).map(a=>`«${a}»`).join(', ')}\n(Если основной текст странный или не имеет смысла — используй альтернативы для понимания намерения.)\n`
      : '';

    const memLines = normalizeArray(memoryContext, 5).map((s) => (s as string).slice(0, 120));
    const memBlock = memLines.length > 0
      ? `\nПомни — человек раньше записывал:\n${memLines.join('\n')}\n`
      : '';

    const { recentNotes, userFolders } = payload ?? {};
    type NoteCtx = {index:number,title:string,body:string,hasReminder?:boolean,isRecurring?:boolean,reminderTime?:string|null};
    // Форматируем время напоминания для DAILY_BRIEFING
    const todayStr2 = new Date().toISOString().slice(0,10);
    const notesLines = Array.isArray(recentNotes) && recentNotes.length > 0
      ? '\nЗаметки пользователя:\n' + (recentNotes as NoteCtx[]).map(n => {
          let timeLabel = '';
          if(n.isRecurring) timeLabel = ' 🔁';
          else if(n.reminderTime){
            const isToday = String(n.reminderTime).startsWith(todayStr2);
            const timeStr = String(n.reminderTime).slice(11,16);
            timeLabel = isToday ? ` 🔔 сегодня ${timeStr}` : ` 🔔 ${n.reminderTime.slice(0,10)} ${timeStr}`;
          }
          return `[${n.index}] «${n.title}»${timeLabel}${n.body?' — '+n.body:''}`;
        }).join('\n') + '\n'
      : '';

    const foldersBlock = Array.isArray(userFolders) && (userFolders as string[]).length > 0
      ? `\n═══ РАЗДЕЛЫ ПОЛЬЗОВАТЕЛЯ ═══\nПользователь создал разделы: ${(userFolders as string[]).join(', ')}\nПри CREATE_NOTE — если тема ЯВНО совпадает с разделом, добавь в params поле "section": "ИмяРаздела"\nСовпадение должно быть чётким (финансы/деньги → Финансы, врач/здоровье → Здоровье). При малейшем сомнении — НЕ ставить section.\n`
      : '';

    const prompt = `Ты голосовой агент «Разберёмся». Выполни запрос и верни JSON.

═══ ДОСТУПНЫЕ ДЕЙСТВИЯ ═══
CREATE_NOTE       — записать / запомнить / создать заметку (ДЕЙСТВИЕ ПО УМОЛЧАНИЮ при сомнениях)
SET_REMINDER      — одно напоминание в конкретное время
SET_RECURRING     — повторяющееся напоминание (каждый час / день)
DELETE_REMINDER   — удалить / отменить напоминание (оставить заметку)
READ_NOTE_ALOUD   — прочитай / озвучь заметку
DAILY_BRIEFING    — что у меня сегодня / расскажи что запланировано / сводка дня
MAKE_PLAN         — составь план / маршрут / список дел по заметкам
FIND_NOTES        — найди / покажи / ищи заметки по теме или тексту
DELETE_NOTE       — удалить заметку в корзину
CLARIFY           — запрос размытый, нужно уточнить
CREATE_TAG_FOLDER — ТОЛЬКО если явно сказано «папку», «раздел» или «категорию»
TAG_NOTE          — добавить тег к заметке (только если явно упомянуты «тег», «папка», «категория»)
OPEN_NOTE         — открыть / показать заметку
ANALYZE_NOTE      — проанализировать заметку через AI
QUESTION          — ответить на вопрос
FIND_DOCTOR       — найти врача / клинику

═══ ФОРМАТ ОТВЕТА ═══
Верни ТОЛЬКО JSON без markdown:
{
  "actions": [
    {"intent": "ACTION", "params": {...}}
  ],
  "response": "тёплый ответ что сделано, одно предложение",
  "options": []
}

ВАЖНО: "options" — всегда в корне JSON, никогда не внутри params!
Для CLARIFY пример:
{
  "actions": [{"intent": "CLARIFY", "params": {}}],
  "response": "Уточни когда напомнить?",
  "options": [
    {"label": "Через час", "query": "напомни [что] через час"},
    {"label": "Сегодня вечером", "query": "напомни [что] сегодня в 19:00"},
    {"label": "Завтра утром", "query": "напомни [что] завтра в 9:00"},
    {"label": "Выбрать время", "query": "напомни [что] — укажи время"}
  ]
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

═══ ЖЁСТКИЕ ПРАВИЛА ПАПОК ═══
CREATE_TAG_FOLDER и TAG_NOTE — ТОЛЬКО при явном упоминании слов: «папку», «папка», «раздел», «категорию», «тег», «ярлык».
Если этих слов нет — НИКОГДА не создавай папку. Используй CREATE_NOTE или CLARIFY.
Примеры ошибок которых нельзя делать:
— "напомни про врача" → НЕ создавать папку «врач», а SET_REMINDER или CLARIFY
— "запиши встречу с клиентом" → НЕ CREATE_TAG_FOLDER, а CREATE_NOTE
— "дела на завтра" → НЕ создавать папку «дела», а CREATE_NOTE

═══ ПРАВИЛА ПРИ ПЛОХОМ РАСПОЗНАВАНИИ ═══
Голосовой ввод может ошибаться. Если запрос странный — попробуй понять смысл по контексту и альтернативам.
Принцип: «записать / запомнить / напомни» + существительное → скорее всего CREATE_NOTE или SET_REMINDER.
Если смысл совсем непонятен — CLARIFY, НЕ CREATE_TAG_FOLDER.

═══ ПРАВИЛА МНОЖЕСТВЕННЫХ ДЕЙСТВИЙ ═══
Используй несколько действий в "actions" когда пользователь просит сделать несколько вещей сразу:
— "создай папку X и добавь туда заметку" → [CREATE_TAG_FOLDER, TAG_NOTE]
— "запиши и напомни мне в 18:00" → [CREATE_NOTE, SET_REMINDER с noteIndex новой заметки]
— "открой и проанализируй" → [OPEN_NOTE, ANALYZE_NOTE]

═══ ПРАВИЛА УТОЧНЕНИЯ ═══
CLARIFY когда: "напоминай", "каждый день", "регулярно" без конкретики по времени.
НЕ делай CLARIFY если ритм понятен ("каждые 2 часа", "каждый день в 9" — это уже конкретно).
Для "напомни позвонить врачу" без времени — CLARIFY с 4 вариантами времени:
  options: [
    {"label": "Через час", "query": "напомни позвонить врачу через час"},
    {"label": "Сегодня вечером", "query": "напомни позвонить врачу сегодня вечером в 19:00"},
    {"label": "Завтра утром", "query": "напомни позвонить врачу завтра утром в 9:00"},
    {"label": "Выбрать время", "query": "напомни позвонить врачу — укажи время"}
  ]
options: 3-4 варианта, query — полная готовая команда.
НЕ давай советов по здоровью — только помогай настроить напоминание.

═══ ПРАВИЛА ДЛЯ НОВЫХ ДЕЙСТВИЙ ═══
READ_NOTE_ALOUD: noteIndex = номер заметки из списка. Ответ: "Озвучиваю: «Название»".
DAILY_BRIEFING: посмотри на заметки с полем reminderTime — это сегодняшние планы. Ответ: дружеская сводка "Сегодня у вас: ..." или "На сегодня ничего не запланировано". Кратко, 3-5 предложений.
MAKE_PLAN: используй тела заметок как контекст и составь конкретный план или маршрут. Ответ = сам план (список шагов или пунктов маршрута). Не говори "вот план", сразу давай содержание. До 300 слов. Тёплый, практичный тон.
${foldersBlock}${memBlock}${notesLines}${altsBlock}
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
    });
  }

  // ── TRANSCRIBE — Groq Whisper ──
  if (action === 'transcribe') {
    if (!GROQ_KEY) return json({ error: 'GROQ_API_KEY not configured' }, 500);

    const { audio_base64, mime_type } = payload ?? {};
    if (typeof audio_base64 !== 'string' || audio_base64.length < 100) {
      return json({ error: 'No audio data' }, 400);
    }

    // base64 → Uint8Array
    const binaryStr = atob(audio_base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    // Определяем расширение по MIME-типу (Groq требует расширение в имени файла)
    const safeType = typeof mime_type === 'string' ? mime_type : 'audio/webm';
    const ext = safeType.includes('mp4') || safeType.includes('m4a') ? 'm4a'
              : safeType.includes('ogg') ? 'ogg'
              : 'webm';

    const form = new FormData();
    form.append('file', new File([bytes], `audio.${ext}`, { type: safeType }));
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'ru');
    form.append('response_format', 'json');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      body: form,
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq transcription error:', errText);
      return json({ error: 'Transcription failed' }, 500);
    }

    const result = await groqRes.json();
    return json({ text: (result.text ?? '').trim() });
  }

  return json({ error: 'Unknown action' }, 400);
});
