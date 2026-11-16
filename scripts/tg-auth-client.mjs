// scripts/tg-auth-client.mjs — щит клиентской части входа через телеграм.
// Проверяем поведение js/tg-auth.js в трёх мирах:
//   1) обычный браузер (нет Telegram) — вход через телеграм молчит, почта работает;
//   2) телеграм, сервер принял подпись — сессия встаёт;
//   3) телеграм, сервер отказал — тихо возвращаемся на вход по почте, без падения.
// Плюс ловушка, на которой уже спотыкались: адрес сервера лежит в app.js (const),
// который грузится ПОЗЖЕ — обращение к нему на загрузке бросает ReferenceError.
//
// Запуск: node scripts/tg-auth-client.mjs   (код 1 — щит красный)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const код = readFileSync(new URL('../js/tg-auth.js', import.meta.url), 'utf8');

let провалов = 0;
function проверка(условие, что) {
  console.log((условие ? '  ✓ ' : '  ✗ ') + что);
  if (!условие) провалов++;
}

/** Собираем песочницу: window, fetch-заглушка, sb-заглушка. */
function мир({ telegram = null, ответ = null } = {}) {
  const вызовы = { fetch: 0, setSession: null };
  const setSessionИтог = [];
  const sandbox = {
    console,
    TextEncoder,
    Promise,
    window: {},
    fetch: async (url, opts) => {
      вызовы.fetch++;
      вызовы.url = url;
      вызовы.body = opts && opts.body;
      if (ответ === 'throw') throw new Error('сеть недоступна');
      return {
        ok: ответ && ответ.ok !== false,
        json: async () => ответ && ответ.body ? ответ.body : {}
      };
    }
  };
  sandbox.window.Telegram = telegram === null ? undefined : { WebApp: telegram };
  sandbox.sb = {
    auth: {
      setSession: async (s) => {
        вызовы.setSession = s;
        setSessionИтог.push(s);
        return { error: null };
      }
    }
  };
  // app.js ещё не загружен: SUPABASE_EDGE_URL не существует (мёртвая зона const).
  const контекст = vm.createContext(sandbox);
  vm.runInContext(код, контекст, { filename: 'tg-auth.js' });
  return { sandbox, вызовы };
}

console.log('Щит клиента: вход через телеграм\n');

// 1. Обычный браузер — молчим
{
  const { sandbox, вызовы } = мир({ telegram: null });
  проверка(sandbox.window.rzTgAuth && typeof sandbox.window.rzTgAuth.войти === 'function',
    'витрина rzTgAuth появилась (загрузка не упала без app.js)');
  проверка(sandbox.window.rzTgAuth.внутриТелеграма() === false,
    'обычный браузер: «внутри телеграма» — нет');
  const вошёл = await sandbox.window.rzTgAuth.войти();
  проверка(вошёл === false && вызовы.fetch === 0,
    'обычный браузер: входа через телеграм нет и запроса нет');
}

// 2. Телеграм, сервер принял
{
  const { sandbox, вызовы } = мир({
    telegram: { initData: 'auth_date=1&hash=abc&user=%7B%22id%22%3A7%7D' },
    ответ: { ok: true, body: { session: { access_token: 'AT', refresh_token: 'RT' } } }
  });
  проверка(sandbox.window.rzTgAuth.внутриТелеграма() === true, 'телеграм: initData виден');
  const вошёл = await sandbox.window.rzTgAuth.войти();
  проверка(вошёл === true, 'телеграм + верная подпись: вошли');
  проверка(вызовы.setSession && вызовы.setSession.access_token === 'AT',
    'сессия поставлена в Supabase');
  проверка(/tg_auth/.test(String(вызовы.body)) && /initData/.test(String(вызовы.body)),
    'на сервер ушло действие tg_auth с initData');
  проверка(!/hash=abc/.test(String(вызовы.url || '')),
    'подпись не ушла в адресе строкой (только телом запроса)');
}

// 3. Телеграм, сервер отказал / сеть упала — не падаем
{
  const { sandbox, вызовы } = мир({
    telegram: { initData: 'auth_date=1&hash=плохой' },
    ответ: { ok: false, body: { error: 'не принят', reason: 'подпись не сходится' } }
  });
  const вошёл = await sandbox.window.rzTgAuth.войти();
  проверка(вошёл === false && вызовы.setSession === null,
    'подпись не сошлась: не вошли и сессию не тронули');
}
{
  const { sandbox } = мир({
    telegram: { initData: 'auth_date=1&hash=abc' },
    ответ: 'throw'
  });
  let упало = false;
  try { await sandbox.window.rzTgAuth.войти(); } catch (e) { упало = true; }
  проверка(!упало, 'сервер недоступен: наружу не бросило (человек войдёт почтой)');
}

// 4. initDataUnsafe не годится как источник (его телеграм не подписывает)
{
  const { sandbox, вызовы } = мир({
    telegram: { initData: '', initDataUnsafe: { user: { id: 7 } } }
  });
  проверка(sandbox.window.rzTgAuth.внутриТелеграма() === false,
    'пустой initData: за вход не считаем, даже если есть initDataUnsafe');
  await sandbox.window.rzTgAuth.войти();
  проверка(вызовы.fetch === 0, 'на пустом initData запроса на сервер нет');
}

// 5. Порядок файлов. Этот файл грузится ДО app.js, где SUPABASE_EDGE_URL — const.
// Обращение к чужой const на загрузке = ReferenceError (мёртвая зона). Поэтому адрес
// должен быть свой и читаться при вызове. Ловушку не «проверяем», а снимаем: адреса
// из app.js в модуле быть не должно вовсе.
{
  // Комментарии не вырезаем: наивное «// до конца строки» съедает сам адрес
  // (в https:// тоже есть //) — на этом щит уже соврал один раз.
  проверка(!/SUPABASE_EDGE_URL/.test(код),
    'модуль не зависит от app.js: чужой адрес сервера в нём не упомянут');
  проверка(/const АДРЕС = 'https:\/\/[^']+\/functions\/v1\/ai'/.test(код),
    'свой адрес сервера объявлен в модуле (вход знает, куда стучаться)');
}

// 6. SDK телеграма подключён на странице и РАНЬШЕ нашего кода.
// Именно эту дыру щит не видел: в песочнице window.Telegram подставлялся руками,
// а на живой странице его никто не создавал — вход молча пропускался. Проверяем
// не «файл существует», а порядок: SDK обязан идти до js/tg-auth.js.
{
  const страница = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const местоSDK = страница.indexOf('telegram-web-app.js');
  const местоНаше = страница.indexOf('js/tg-auth.js');
  проверка(местоНаше >= 0, 'страница подключает js/tg-auth.js');
  проверка(местоSDK >= 0,
    'страница подключает SDK телеграма (иначе window.Telegram не создаётся вовсе)');
  проверка(местоSDK >= 0 && местоНаше >= 0 && местоSDK < местоНаше,
    'SDK телеграма стоит ДО js/tg-auth.js (порядок — часть работы)');
}

console.log('');
if (провалов) {
  console.error(`❌ Щит клиента красный: провалов ${провалов}`);
  process.exit(1);
}
console.log('✓ Щит клиента цел');
