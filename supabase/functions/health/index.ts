// health/index.ts — публичный endpoint проверки статуса сервисов
// Не требует JWT. Возвращает JSON со статусами Yandex, Groq, Supabase.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: CORS });

// ── Проверка Yandex SpeechKit ──────────────────────────────────────────────
// Отправляем пустое тело → если ключ валидный → 400 (нет аудио, но API отвечает)
// 401/403 = ключ невалидный, 5xx = сервис лежит
async function checkYandex(key: string): Promise<{ ok: boolean; latency: number; detail: string }> {
  if (!key) return { ok: false, latency: 0, detail: 'ключ не настроен' };
  const t = Date.now();
  try {
    const r = await fetch(
      'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&format=lpcm&sampleRateHertz=16000',
      {
        method: 'POST',
        headers: {
          'Authorization': `Api-Key ${key}`,
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(32), // минимальный payload — не пустой, не настоящий
        signal: AbortSignal.timeout(8000),
      }
    );
    const latency = Date.now() - t;
    if (r.status === 401 || r.status === 403) return { ok: false, latency, detail: 'ключ отклонён' };
    if (r.status >= 500) return { ok: false, latency, detail: `сервис недоступен (${r.status})` };
    // 400 = нет аудио, но API жив и ключ принят
    return { ok: true, latency, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, latency: Date.now() - t, detail: String(e).slice(0, 80) };
  }
}

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

  const YANDEX_STT_KEY = Deno.env.get('YANDEX_STT_KEY') ?? '';
  const GROQ_API_KEY   = Deno.env.get('GROQ_API_KEY') ?? '';
  const t0 = Date.now();

  // Параллельные проверки
  const [yandex, groq] = await Promise.all([
    checkYandex(YANDEX_STT_KEY),
    checkGroq(GROQ_API_KEY),
  ]);

  return json({
    checked_at: new Date().toISOString(),
    edge_latency: Date.now() - t0,
    services: {
      yandex_stt: { ok: yandex.ok, latency_ms: yandex.latency, detail: yandex.detail },
      groq:       { ok: groq.ok,   latency_ms: groq.latency,   detail: groq.detail },
      supabase:   { ok: true,      latency_ms: 0,               detail: 'edge function running' },
      github_pages: { ok: true,    latency_ms: 0,               detail: 'serving this page' },
    },
  });
});
