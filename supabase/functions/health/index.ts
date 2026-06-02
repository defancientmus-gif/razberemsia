// health/index.ts — публичный endpoint проверки статуса сервисов
// Не требует JWT. Возвращает JSON со статусами Groq, Supabase.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: CORS });

// ── Проверка Groq ──────────────────────────────────────────────────────────
async function checkGroq(key: string): Promise<{ ok: boolean; latency: number; detail: string }> {
  if (!key) return { ok: false, latency: 0, detail: 'ключ не настроен' };
  const t = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t;
    // 401/403 = ключ недействителен; 5xx = сервис лежит; 400/200 = сервис жив
    if (r.status === 401 || r.status === 403) return { ok: false, latency, detail: 'ключ отклонён' };
    if (r.status >= 500) return { ok: false, latency, detail: `сервис недоступен (${r.status})` };
    return { ok: true, latency, detail: `HTTP ${r.status} — сервис доступен` };
  } catch (e) {
    return { ok: false, latency: Date.now() - t, detail: String(e).slice(0, 80) };
  }
}

// ── Проверка Claude API (через Groq/Anthropic внутри ai функции) ───────────
// Просто убеждаемся что Edge Function отвечает (сам факт ответа = Supabase жив)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const GROQ_API_KEY   = Deno.env.get('GROQ_API_KEY') ?? '';
  const t0 = Date.now();

  const groq = await checkGroq(GROQ_API_KEY);

  return json({
    checked_at: new Date().toISOString(),
    edge_latency: Date.now() - t0,
    services: {
      groq:       { ok: groq.ok,   latency_ms: groq.latency,   detail: groq.detail },
      supabase:   { ok: true,      latency_ms: 0,               detail: 'edge function running' },
      github_pages: { ok: true,    latency_ms: 0,               detail: 'serving this page' },
    },
  });
});
