// Edge Function: push-sender
// Вызывается pg_cron каждую минуту.
// Находит несрабатывавшие напоминания → отправляет VAPID Web Push.
//
// Secrets (Supabase Dashboard → Settings → Edge Functions):
//   VAPID_PUBLIC_KEY   — base64url публичный ключ
//   VAPID_PRIVATE_KEY  — base64url приватный ключ
//   VAPID_SUBJECT      — mailto:your@email.com
//   SUPABASE_URL       — автоматически
//   SUPABASE_SERVICE_ROLE_KEY — автоматически

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')     ?? 'mailto:admin@razberemsia.ru';
const SB_URL        = Deno.env.get('SUPABASE_URL')      ?? '';
const SB_SERVICE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const sb = createClient(SB_URL, SB_SERVICE);

// ── VAPID JWT helpers ──────────────────────────────────────────────
function base64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - s.length % 4);
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), c => c.charCodeAt(0));
}
function bytesToBase64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function encodeJson(obj: unknown): string {
  return bytesToBase64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function importPrivateKey(privB64u: string): Promise<CryptoKey> {
  // Извлекаем x и y из публичного ключа (uncompressed: 0x04 + 32b x + 32b y)
  const pubBytes = base64urlToBytes(VAPID_PUBLIC);
  const x = bytesToBase64url(pubBytes.slice(1, 33));
  const y = bytesToBase64url(pubBytes.slice(33, 65));
  // Импортируем через JWK — надёжнее ручного PKCS8
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: privB64u, x, y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}
function tlv(data: Uint8Array): Uint8Array {
  if (data.length < 128) return concat([new Uint8Array([data.length]), data]);
  if (data.length < 256) return concat([new Uint8Array([0x81, data.length]), data]);
  return concat([new Uint8Array([0x82, data.length >> 8, data.length & 0xff]), data]);
}
function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function makeVapidJwt(audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header  = encodeJson({ typ: 'JWT', alg: 'ES256' });
  const payload = encodeJson({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT });
  const sigInput = new TextEncoder().encode(`${header}.${payload}`);
  const privKey  = await importPrivateKey(VAPID_PRIVATE);
  // Web Crypto API возвращает IEEE P1363 (raw r||s, 64 байта для P-256) — DER конвертация не нужна
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, sigInput));
  return `${header}.${payload}.${bytesToBase64url(sig)}`;
}

// ── Encrypt payload for Web Push (RFC 8291 / HKDF / AES-128-GCM) ──
async function encryptPayload(
  payload: string,
  p256dhB64u: string,
  authB64u: string
): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; serverPublicKey: Uint8Array }> {
  const enc = new TextEncoder().encode(payload);
  const receiverPub = base64urlToBytes(p256dhB64u);
  const authSecret  = base64urlToBytes(authB64u);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Generate ephemeral ECDH key pair
  const ephem = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const ephemPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephem.publicKey));

  // Import receiver's public key
  const recvKey = await crypto.subtle.importKey('raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recvKey }, ephem.privateKey, 256));

  // HKDF-SHA256 PRK — RFC 8291: IKM=ecdh_secret, salt=auth_secret (не наоборот!)
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const prkInfo = concat([new TextEncoder().encode('WebPush: info\x00'), receiverPub, ephemPubRaw]);
  const prk = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: prkInfo }, hkdfKey, 256
  ));

  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\x00');
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128
  ));
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00');
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96
  ));

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // Padding: \x02 delimiter
  const padded = concat([enc, new Uint8Array([0x02])]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  return { ciphertext, salt, serverPublicKey: ephemPubRaw };
}

// ── Build aes128gcm content-encoding body ──────────────────────────
function buildBody(salt: Uint8Array, serverPub: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  // salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat([salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext]);
}

// ── Send one Web Push ──────────────────────────────────────────────
async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, title: string, body: string): Promise<boolean> {
  try {
    const url   = new URL(sub.endpoint);
    const aud   = `${url.protocol}//${url.host}`;
    const jwt   = await makeVapidJwt(aud);
    const payload = JSON.stringify({ title, body, icon: '/pwa-feather-192.png', badge: '/pwa-feather-192.png', tag: 'rz-reminder' });

    const { ciphertext, salt, serverPublicKey } = await encryptPayload(payload, sub.p256dh, sub.auth);
    const bodyBytes = buildBody(salt, serverPublicKey, ciphertext);

    const res = await fetch(sub.endpoint, {
      method:  'POST',
      headers: {
        'Authorization':     `vapid t=${jwt},k=${VAPID_PUBLIC}`,
        'Content-Type':      'application/octet-stream',
        'Content-Encoding':  'aes128gcm',
        'TTL':               '86400',
        'Urgency':           'high',
      },
      body: bodyBytes,
    });
    const resText = await res.text().catch(() => '');
    console.log(`push → ${url.host} status=${res.status} body=${resText.slice(0,200)}`);
    return res.status === 201;
  } catch (e) {
    console.warn('push failed', e);
    return false;
  }
}

// ── Main handler ───────────────────────────────────────────────────
Deno.serve(async () => {
  if (!VAPID_PRIVATE || !VAPID_PUBLIC) {
    return new Response('VAPID keys not configured', { status: 500 });
  }

  const now = new Date().toISOString();

  // Найти все несрабатывавшие напоминания которые уже пора
  const { data: dueReminders, error } = await sb
    .from('reminders')
    .select('id, user_id, note_title, note_body')
    .eq('sent', false)
    .lte('remind_at', now)
    .limit(50);

  if (error || !dueReminders?.length) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  let sentCount = 0;
  const sentIds: string[] = [];

  for (const reminder of dueReminders) {
    // Найти все push-подписки пользователя
    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', reminder.user_id);

    if (!subs?.length) { sentIds.push(reminder.id); continue; }

    // Используем содержимое заметки как заголовок уведомления —
    // iOS показывает «[app name] + title», поэтому не дублируем «Разберёмся» в title
    const title = reminder.note_title || reminder.note_body?.slice(0, 80) || 'Напоминание';
    const body  = '';

    for (const sub of subs) {
      const ok = await sendPush(sub, title, body);
      if (ok) sentCount++;
    }
    sentIds.push(reminder.id);
  }

  // Пометить как отправленные
  if (sentIds.length) {
    await sb.from('reminders').update({ sent: true }).in('id', sentIds);
  }

  return new Response(JSON.stringify({ sent: sentCount, processed: sentIds.length }), { status: 200 });
});
