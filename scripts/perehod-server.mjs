// scripts/perehod-server.mjs — щит переезда облака на свой сервер.
//
// Что ловит (зачем появился):
//   1) МЕТКА СЕРВЕРА. Прежний сервер выдавал человеку свой uuid; новый выдаст другой,
//      и заметки под старым ключом станут невидимыми (не пропадут, но телефон покажет
//      пусто). Метка в rz_last_user — единственное, что отличает «переехали» от «вход
//      по кэшу офлайн». Без неё человек молча остаётся под старым uuid навсегда.
//   2) МОСТ ПОЛКИ. При входе с новым uuid (та же почта) заметки/корзина/история/память
//      переносятся под новый ключ ДО показа приложения. Чужой аккаунт на том же телефоне
//      ничего не забирает: замок — почта.
//   3) ЧЕЛОВЕКА НЕ ЗАПИРАЮТ. Нет сети на новом сервере — работаем локально, метку не
//      затираем; на первом запуске с сетью попросим войти по коду.
//
// Щит держится за живой код js/app.js (вырезает функции и гоняет), а не за пересказ.
// Проверено на сломе: убрал метку/мост/строку на экране — красный.
//
// Запуск: node scripts/perehod-server.mjs [путь-к-app.js]   (код 1 — щит красный)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const путьApp = process.argv[2] ? resolve(process.argv[2]) : new URL('../js/app.js', import.meta.url);
const app = readFileSync(путьApp, 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');

let провалов = 0;
function проверка(условие, что) {
  console.log((условие ? '  ✓ ' : '  ✗ ') + что);
  if (!условие) провалов++;
}

/** Вырезаем настоящий кусок app.js между двумя якорями (как в tg-auth-client.mjs). */
function вырезать(начало, конец) {
  const a = app.indexOf(начало);
  const b = a < 0 ? -1 : app.indexOf(конец, a + начало.length);
  return a >= 0 && b > a ? app.slice(a, b) : '';
}

const блок = вырезать('function _lastUser(){', 'async function initAuth(){');
const initAuth = вырезать('async function initAuth(){', 'function showAuthErr(msg){');
const enterUser = вырезать('async function enterUser(user,opts){', '// ── ONBOARDING');

const адрес = (app.match(/^const SUPABASE_URL='([^']+)';/m) || [])[1] || '';
let host = '', ref = '';
try { host = new URL(адрес).host; ref = new URL(адрес).hostname.split('.')[0]; } catch (_) {}

console.log('Щит переезда облака: метка сервера и мост полки\n');

проверка(!!адрес && !!host && !!ref && блок.includes('_serverMoved'),
  'живой адрес базы и функции переезда найдены в js/app.js (щит за код, не за копию)');

if (!адрес || !блок || !initAuth || !enterUser) {
  console.log('\n❌ Щит не смог прочитать js/app.js — проверять нечего, это красное.');
  process.exit(1);
}

/** Память телефона: как localStorage, с length/key (иначе метку не проверить). */
function склад(начальные = {}) {
  const m = new Map(Object.entries(начальные));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    _m: m,
  };
}

/** Песочница с настоящими initAuth/enterUser из app.js и заглушками вокруг. */
function песочница({ store, online = true, session = null, tg = false, url = адрес } = {}) {
  const след = { показано: false, проверка: null, очередь: 0, ошибка: '', облако: false, tg: false };
  const элемент = { note: { style: {}, textContent: '' }, email: { value: '' } };
  const document = {
    getElementById: (id) => (id === 'auth-moved' ? элемент.note : id === 'email-input' ? элемент.email : null),
  };
  const sb = { auth: { getSession: async () => ({ data: { session } }), onAuthStateChange() {} } };
  const window = { rzTgAuth: tg ? { внутриТелеграма: () => true, войти: async () => { след.tg = true; return true; } } : undefined };
  const код = `
    let CU = null;
    const localStorage = __store, navigator = { onLine: __online }, document = __document, window = __window, sb = __sb;
    const SUPABASE_URL = __url;
    function setTimeout() { return 0; }
    function showAuthErr(m) { __след.ошибка = m; }
    function setAuthChecking(v) { __след.проверка = !!v; }
    function showApp() { __след.показано = true; }
    function updUI() {}
    function loadAll() {}
    function loadCloudData() { __след.облако = true; return Promise.resolve(); }
    function _maybeOnboard() {}
    function _subscribeRealtime() {}
    function _unsubscribeRealtime() {}
    function _ensurePushSubscription() {}
    function _maybeSharpenTagRules() {}
    function _backfillSense() {}
    function migrateLegacyLocal() {}
    function notifGranted() { return false; }
    function queueCloudSave() { __след.очередь++; }
    ${блок}
    ${initAuth}
    ${enterUser}
    return { initAuth, enterUser, _serverMoved, _bridgeAccount, _moveScope, _serverId, _lastUser, getCU: () => CU };
  `;
  const api = new Function('__store', '__online', '__document', '__window', '__sb', '__url', '__след', код)(
    store, online, document, window, sb, url, след);
  return { api, след, элемент };
}

// ── 1. Метка сервера ─────────────────────────────────────────────────────────
{
  const п = песочница({
    store: склад({ rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: 'old.example.co' }) }),
  });
  проверка(п.api._serverMoved(п.api._lastUser()) === true,
    'метка прежнего сервера → переезд замечен');
}
{
  const п = песочница({
    store: склад({ rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: host }) }),
  });
  проверка(п.api._serverMoved(п.api._lastUser()) === false,
    'метка текущего сервера → переезда нет (обычный офлайн-вход не ломаем)');
}
{
  // Человек входил до этой сборки: метки нет, но в памяти остался ключ сессии
  // ПРЕЖНЕГО адреса этого приложения, а база уже новая.
  const п = песочница({
    store: склад({
      rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x' }),
      ['sb-' + ref + '-auth-token']: '{"access_token":"старый"}',
    }),
    url: 'https://newproj.supabase.co',
  });
  проверка(п.api._serverMoved(п.api._lastUser()) === true,
    'метки нет, но ключ сессии прежнего адреса нашего приложения → переезд замечен');
}
{
  // Ловушка живого дома: GitHub Pages делит localStorage со всеми сайтами аккаунта.
  // Рядом живёт «БУ.шка» со своим Supabase — её ключ сессии НЕ наш переезд.
  const п = песочница({
    store: склад({
      rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x' }),
      ['sb-vnylpvmhelzlxusvydab-auth-token']: '{"access_token":"соседний"}',
    }),
    url: 'https://newproj.supabase.co',
  });
  проверка(п.api._serverMoved(п.api._lastUser()) === false,
    'ключ сессии ЧУЖОГО приложения на том же домене (БУ.шка) → не переезд');
}
{
  const п = песочница({
    store: склад({
      rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x' }),
      ['sb-' + ref + '-auth-token']: '{"access_token":"свой"}',
    }),
  });
  проверка(п.api._serverMoved(п.api._lastUser()) === false,
    'метки нет, сессия текущего проекта → ложной тревоги нет');
}
{
  const п = песочница({ store: склад({}) });
  проверка(п.api._serverMoved(null) === false,
    'первый запуск без кэша → переезда нет');
}

// ── 2. Мост полки ────────────────────────────────────────────────────────────
const старое = {
  rz_u1_notes: JSON.stringify([{ id: 'n1', text: 'молоко' }]),
  rz_u1_trash: JSON.stringify([{ id: 't1', text: 'старьё' }]),
  rz_u1_ai_memory: JSON.stringify([{ q: 'а' }]),
  rz_u1_name: 'Женя',
  rz_onboarded_u1: '1',
};
{
  const store = склад(старое);
  const п = песочница({ store });
  const moved = п.api._bridgeAccount({ id: 'u1', email: 'A@X' }, { id: 'u2', email: ' a@x ' });
  проверка(moved === 4, 'мост переносит всю полку (4 ключа) при той же почте, регистр/пробелы не мешают');
  проверка(store.getItem('rz_u2_notes') === старое.rz_u1_notes, 'заметки легли под новый ключ');
  проверка(store.getItem('rz_u2_name') === 'Женя', 'имя легло под новый ключ');
  проверка(store.getItem('rz_u1_notes') !== null, 'старый ключ не тронут (данные не удаляем)');
  проверка(store.getItem('rz_onboarded_u2') === '1', 'метка «онбординг пройден» переехала');
}
{
  const store = склад(старое);
  const п = песочница({ store });
  проверка(п.api._bridgeAccount({ id: 'u1', email: 'a@x' }, { id: 'u2', email: 'b@x' }) === 0,
    'другая почта → ничего не переносим (чужой аккаунт на телефоне)');
  проверка(store.getItem('rz_u2_notes') === null, 'и чужая полка не появилась');
}
{
  const store = склад(старое);
  const п = песочница({ store });
  проверка(п.api._bridgeAccount({ id: 'u1', email: 'a@x' }, { id: 'u1', email: 'a@x' }) === 0,
    'тот же uuid → мост молчит');
}
{
  const store = склад({ ...старое, rz_u2_notes: JSON.stringify([{ id: 'n9', text: 'новое' }]) });
  const п = песочница({ store });
  const moved = п.api._bridgeAccount({ id: 'u1', email: 'a@x' }, { id: 'u2', email: 'a@x' });
  проверка(moved === 3, 'на новом ключе уже есть данные → их не затираем, переносим остальное');
  проверка(store.getItem('rz_u2_notes') === JSON.stringify([{ id: 'n9', text: 'новое' }]),
    'свежие заметки нового ключа остались своими');
}
{
  const store = склад({ ...старое, rz_u2_notes: '[]' });
  const п = песочница({ store });
  п.api._bridgeAccount({ id: 'u1', email: 'a@x' }, { id: 'u2', email: 'a@x' });
  проверка(store.getItem('rz_u2_notes') === старое.rz_u1_notes,
    'пустой список на новом ключе не считается данными — старые заметки не теряются');
}

// ── 3. Боевой enterUser ──────────────────────────────────────────────────────
{
  const store = склад({
    rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: 'old.example.co' }),
    rz_u1_notes: JSON.stringify([{ id: 'n1', text: 'молоко' }]),
  });
  const п = песочница({ store });
  await п.api.enterUser({ id: 'u2', email: 'a@x' });
  const запись = JSON.parse(store.getItem('rz_last_user'));
  проверка(store.getItem('rz_u2_notes') !== null, 'enterUser: новый uuid получает полку прежнего');
  проверка(запись.server === host, 'enterUser: метка сервера записана');
  проверка(п.след.показано === true, 'enterUser: приложение показано');
  проверка(п.след.очередь === 1, 'enterUser: перенесённая полка поставлена в очередь на облако');
}
{
  const store = склад({ rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: 'old.example.co' }) });
  const п = песочница({ store });
  await п.api.enterUser({ id: 'u1', email: 'a@x' }, { keepServer: true });
  проверка(JSON.parse(store.getItem('rz_last_user')).server === 'old.example.co',
    'офлайн-вход на новом сервере НЕ затирает метку переезда (иначе переезд потеряется)');
}

// ── 4. Боевой initAuth ───────────────────────────────────────────────────────
{
  const store = склад({ rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: 'old.example.co' }) });
  const п = песочница({ store, session: null });
  await п.api.initAuth();
  проверка(п.след.показано === false, 'initAuth: при переезде вход по кэшу не пускает мимо нового облака');
  проверка(п.элемент.note.textContent.includes('переехали'), 'initAuth: объясняет человеку, что случилось');
  проверка(п.элемент.note.style.display === 'block', 'initAuth: объяснение видно, а не спрятано');
  проверка(п.элемент.email.value === 'a@x', 'initAuth: почта подставлена, набирать заново не надо');
  проверка(п.след.проверка === false, 'initAuth: крутилка снята, поле почты живо');
}
{
  const store = склад({ rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: host }) });
  const п = песочница({ store, session: { user: { id: 'u1', email: 'a@x' } } });
  await п.api.initAuth();
  проверка(п.след.показано === true, 'initAuth: тот же сервер — вход по кэшу как раньше (нет регрессии)');
  проверка(п.элемент.note.textContent === '', 'initAuth: и никакого «переехали» на своём сервере');
}
{
  const store = склад({
    rz_last_user: JSON.stringify({ id: 'u1', email: 'tg42@tg.razberemsia.local', server: 'old.example.co' }),
  });
  const п = песочница({ store, tg: true });
  await п.api.initAuth();
  проверка(п.след.tg === true, 'initAuth: внутри телеграма при переезде вход по подписи пробуется');
  проверка(п.элемент.email.value === '', 'initAuth: служебную почту телеграма человеку не подставляем');
}
{
  const store = склад({
    rz_last_user: JSON.stringify({ id: 'u1', email: 'a@x', server: 'old.example.co' }),
    rz_u1_notes: JSON.stringify([{ id: 'n1', text: 'молоко' }]),
  });
  const п = песочница({ store, online: false, session: null });
  await п.api.initAuth();
  проверка(п.след.показано === true, 'initAuth: без сети при переезде человек работает локально, не заперт');
  проверка(JSON.parse(store.getItem('rz_last_user')).server === 'old.example.co',
    'initAuth: и метка переезда цела к следующему запуску');
}

// ── 5. Вшито в путь сборки, а не в текст ─────────────────────────────────────
проверка(enterUser.includes('server:_serverId()'), 'app.js: enterUser пишет метку сервера');
проверка(enterUser.includes('_bridgeAccount(prev,user)'), 'app.js: enterUser зовёт мост полки');
проверка(enterUser.indexOf('_bridgeAccount(prev,user)') < enterUser.indexOf('showApp()'),
  'app.js: мост стоит ДО показа приложения (иначе телефон мигнёт пустотой)');
проверка(initAuth.includes('_serverMoved(cached)'), 'app.js: initAuth спрашивает про переезд');
проверка(initAuth.includes('keepServer:moved'), 'app.js: вход по кэшу на новом сервере не затирает метку');
{
  const место = indexHtml.indexOf('id="auth-moved"');
  проверка(место > 0 && место < indexHtml.indexOf('id="email-input"') && место > indexHtml.indexOf('id="step-email"'),
    'index.html: объяснение стоит на шаге почты, до кнопки входа');
}
проверка(deploy.includes('"$NODE_BIN" scripts/perehod-server.mjs'),
  'deploy.sh: щит переезда запускается до коммита');
{
  const addСписок = deploy.slice(deploy.indexOf('for F in'));
  проверка(addСписок.includes('scripts/perehod-server.mjs'),
    'deploy.sh: правка щита попадает в коммит (add-список), а не уезжает мимо');
}

console.log('');
if (провалов) {
  console.log(`❌ Щит переезда красный: ${провалов} провал(ов). Деплой остановлен бы.`);
  process.exit(1);
}
console.log('✅ Переезд облака: метка сервера, мост полки и объяснение на входе держатся.');
