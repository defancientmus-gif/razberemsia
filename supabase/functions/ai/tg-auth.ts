// supabase/functions/ai/tg-auth.ts
// Проверка входа через Telegram (Mini App initData) — серверная сторона.
// Секрет (токен бота) НИКОГДА не уходит в клиент: клиент присылает сырой initData,
// подпись сверяется здесь, и только потом выдаётся сессия Supabase.
//
// Спека: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
//   hash       = HMAC_SHA256(key=secret_key,  data=data_check_string)
//   data_check_string = "key=value", отсортированные по key, склеенные "\n", БЕЗ hash.
//   Поля, у которых пустое значение, в строку не входят (parse_qsl keep_blank_values=false).
//
// Отличие от третьей стороны (Ed25519 `signature`): там подпись проверяется публичным
// ключом Telegram и бот-токен не нужен. Нам он есть, поэтому берём HMAC — он проще и
// не тянет внешних ключей.
//
// ⚠ signature из строки НЕ выкидывать. Проза спеки читается двояко («без hash и без
// signature» относится к Ed25519-ветке), но по букве ломается живой вход: телеграм
// кладёт `signature` в initData и считает `hash` по строке, где `signature` УЖЕ есть.
// Проверено на живом образце соседа (`Телеграм/miniapp.py`, в проде с 05.11 — там
// выкидывается только `hash`); свой тест это не ловил, потому что подписывал данные
// без `signature` — то есть проверял сам себя. Эталон — initData с signature (тест ниже).

const ЖИВЁТ_С = 24 * 3600; // initData старше суток не принимаем (как в miniapp.py Телеграма)

export type ИтогВхода =
  | { ok: true; id: string; имя: string }
  | { ok: false; причина: string };

function изHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(ключ: Uint8Array | string, данные: string): Promise<ArrayBuffer> {
  // Копию кладём в свежий ArrayBuffer: так тип совпадает с BufferSource и
  // не зависит от того, каким буфером пришёл ключ (ArrayBuffer или Shared).
  const сырой = typeof ключ === 'string' ? new TextEncoder().encode(ключ) : ключ;
  const вБуфер = new Uint8Array(сырой).buffer;
  const k = await crypto.subtle.importKey('raw', вБуфер, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(данные));
}

/**
 * Проверяет initData телеграма. token — токен бота (из секретов), initData — сырая строка.
 * Возвращает id пользователя телеграма или причину отказа. Наружу ничего не шлёт.
 */
export async function проверитьInitData(
  initData: string,
  token: string,
  сейчас = Math.floor(Date.now() / 1000),
  максимумСекунд = ЖИВЁТ_С,
): Promise<ИтогВхода> {
  if (!initData || !token) return { ok: false, причина: 'пусто' };

  const поля = new Map<string, string>();
  for (const пара of initData.split('&')) {
    if (!пара) continue;
    const i = пара.indexOf('=');
    if (i < 0) continue;
    const к = decodeURIComponent(пара.slice(0, i));
    const з = decodeURIComponent(пара.slice(i + 1).replace(/\+/g, ' '));
    if (з !== '') поля.set(к, з); // пустые в подпись не входят
  }

  const присланный = поля.get('hash') ?? '';
  if (!присланный) return { ok: false, причина: 'нет hash' };
  поля.delete('hash'); // только hash: `signature` входит в подписанную строку (см. шапку)

  const строка = [...поля.keys()].sort().map((к) => `${к}=${поля.get(к)}`).join('\n');
  const секрет = await hmacSha256('WebAppData', token);
  const наш = изHex(await hmacSha256(new Uint8Array(секрет), строка));

  if (наш.length !== присланный.length) return { ok: false, причина: 'подпись не сходится' };
  // Сравнение с постоянным временем (не по раннему выходу)
  let разница = 0;
  for (let i = 0; i < наш.length; i++) разница |= наш.charCodeAt(i) ^ присланный.charCodeAt(i);
  if (разница !== 0) return { ok: false, причина: 'подпись не сходится' };

  const authDate = Number(поля.get('auth_date') ?? 0);
  if (!authDate) return { ok: false, причина: 'нет auth_date' };
  if (сейчас - authDate > максимумСекунд) return { ok: false, причина: 'просрочено' };

  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(поля.get('user') ?? '{}');
  } catch {
    return { ok: false, причина: 'битый user' };
  }
  const id = String(user.id ?? '');
  if (!id) return { ok: false, причина: 'нет id' };

  const имя = [user.first_name, user.last_name].filter((s) => typeof s === 'string' && s).join(' ');
  return { ok: true, id, имя: имя || (typeof user.username === 'string' ? user.username : '') };
}

/**
 * Почта-заглушка для такого человека: TG-id → стабильный адрес входа.
 * Одна и та же личность всегда даёт одну и ту же почту — заметки не разъедутся.
 */
export function почтаДляТг(tgId: string): string {
  return `tg${tgId}@tg.razberemsia.local`;
}

export function парольДляТг(tgId: string, token: string): Promise<string> {
  // Пароль выводим из токена бота и id: его не надо помнить и нельзя подобрать,
  // зная только id. Меняем токен бота — старые пароли становятся негодными.
  return hmacSha256(секретДляПароля(token), `pw:${tgId}`).then(изHex);
}

function секретДляПароля(token: string): string {
  return `rz-tg-pw:${token}`;
}
