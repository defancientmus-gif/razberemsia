// supabase/functions/ai/tg-auth.test.ts
// Щит входа через телеграм. Проверяем не «функция есть», а поведение:
// верная подпись → пускаем; подменённый id/токен/старое время → отказ.
// Гонять: deno test --allow-none supabase/functions/ai/tg-auth.test.ts
import { проверитьInitData, почтаДляТг, парольДляТг } from './tg-auth.ts';

const ТОКЕН = '123456:TEST-TOKEN';

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(ключ: Uint8Array | string, данные: string): Promise<ArrayBuffer> {
  const сырой = typeof ключ === 'string' ? new TextEncoder().encode(ключ) : ключ;
  const вБуфер = new Uint8Array(сырой).buffer;
  const k = await crypto.subtle.importKey('raw', вБуфер, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(данные));
}

/** Подписываем так, как велит спека: key="WebAppData", message=токен. */
async function подписать(поля: Record<string, string>, токен = ТОКЕН): Promise<string> {
  const строка = Object.keys(поля).sort().map((к) => `${к}=${поля[к]}`).join('\n');
  const секрет = await hmac('WebAppData', токен);
  const хеш = hex(await hmac(new Uint8Array(секрет), строка));
  return Object.entries({ ...поля, hash: хеш }).map(([к, з]) => `${к}=${encodeURIComponent(з)}`).join('&');
}

const СЕЙЧАС = 1_700_000_000;
function свежие(): Record<string, string> {
  return {
    auth_date: String(СЕЙЧАС),
    query_id: 'AAA',
    user: JSON.stringify({ id: 42, first_name: 'Евгений', last_name: 'К' }),
  };
}

let провалов = 0;
function проверка(условие: boolean, что: string) {
  console.log((условие ? '  ✓ ' : '  ✗ ') + что);
  if (!условие) провалов++;
}
// Красный щит должен ронять прогон, а не просто печатать ✗: иначе деплой
// пропустит сломанный вход. Проверяем в конце каждого теста.
function щит() {
  if (провалов) throw new Error(`Щит входа через телеграм красный: провалов ${провалов}`);
}

Deno.test('вход через телеграм: подпись и отказы', async () => {
  const ок = await проверитьInitData(await подписать(свежие()), ТОКЕН, СЕЙЧАС);
  проверка(ок.ok && ок.id === '42', 'верная подпись — пускаем, id 42');
  проверка(ок.ok && ок.имя === 'Евгений К', 'имя собрано из first/last');

  const чужой = await проверитьInitData(await подписать(свежие(), '999:ЧУЖОЙ'), ТОКЕН, СЕЙЧАС);
  проверка(!чужой.ok, 'чужая подпись — отказ');

  const подмена = await подписать(свежие());
  const переделанный = подмена.replace('42', '43');
  const подм = await проверитьInitData(переделанный, ТОКЕН, СЕЙЧАС);
  проверка(!подм.ok, 'подменённый id в user — отказ');

  const старые = await подписать({ ...свежие(), auth_date: String(СЕЙЧАС - 90000) });
  const стар = await проверитьInitData(старые, ТОКЕН, СЕЙЧАС);
  проверка(!стар.ok && стар.причина === 'просрочено', 'сутки прошли — отказ «просрочено»');

  проверка(!(await проверитьInitData('', ТОКЕН, СЕЙЧАС)).ok, 'пусто — отказ');
  проверка(!(await проверитьInitData('user=%7B%22id%22%3A42%7D', ТОКЕН, СЕЙЧАС)).ok, 'без hash — отказ');
  проверка(!(await проверитьInitData(await подписать(свежие()), '', СЕЙЧАС)).ok, 'без токена бота — отказ');
  щит();
});

Deno.test('вход через телеграм: одна личность — одна почта', async () => {
  проверка(почтаДляТг('42') === почтаДляТг('42'), 'та же личность — та же почта');
  проверка(почтаДляТг('42') !== почтаДляТг('43'), 'разные люди — разные почты');
  const п1 = await парольДляТг('42', ТОКЕН);
  const п2 = await парольДляТг('42', ТОКЕН);
  проверка(п1 === п2, 'пароль устойчив при том же токене');
  проверка(п1 !== (await парольДляТг('42', '123456:ДРУГОЙ')), 'сменили токен бота — пароль другой');
  проверка(!/TEST-TOKEN/.test(п1), 'в пароле нет токена бота открытым текстом');
  щит();
});

Deno.test('вход через телеграм: signature не ломает HMAC', async () => {
  const с = свежие();
  const подпись = await подписать(с);
  const сSignature = подпись + '&signature=ЧУЖАЯ_ПОДПИСЬ';
  const итог = await проверитьInitData(сSignature, ТОКЕН, СЕЙЧАС);
  проверка(итог.ok && итог.id === '42', 'поле signature в подпись не входит и не мешает');
  щит();
});
