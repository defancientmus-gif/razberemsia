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

// ── Реальная проверка Groq-транскрипции крошечным WAV ──
// Возвращает полный статус и тело ответа Groq — чтобы видеть точную причину блокировки.
function tinyWav(): Uint8Array {
  const sr = 16000, n = sr / 5; // 0.2s тишины
  const dataLen = n * 2;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, dataLen, true);
  return buf;
}
async function checkGroqAudio(key: string): Promise<{ status: number; body: string }> {
  if (!key) return { status: 0, body: 'ключ не настроен' };
  try {
    const form = new FormData();
    form.append('file', new File([tinyWav()], 'audio.wav', { type: 'audio/wav' }));
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'ru');
    form.append('response_format', 'json');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(12000),
    });
    return { status: r.status, body: (await r.text()).slice(0, 600) };
  } catch (e) {
    return { status: -1, body: String(e).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const GROQ_API_KEY   = Deno.env.get('GROQ_API_KEY') ?? '';
  const t0 = Date.now();

  const groq = await checkGroq(GROQ_API_KEY);
  const groqAudio = await checkGroqAudio(GROQ_API_KEY);

  return json({
    checked_at: new Date().toISOString(),
    edge_latency: Date.now() - t0,
    services: {
      groq:       { ok: groq.ok,   latency_ms: groq.latency,   detail: groq.detail },
      groq_audio: { status: groqAudio.status, body: groqAudio.body },
      supabase:   { ok: true,      latency_ms: 0,               detail: 'edge function running' },
      github_pages: { ok: true,    latency_ms: 0,               detail: 'serving this page' },
    },
  });
});
