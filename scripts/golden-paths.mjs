#!/usr/bin/env node
// ЗОЛОТОЙ ЩИТ — регресс-защита пяти путей, ради которых «Разберёмся» существует.
// Условие продажи (Женя 25.08): продукт держится сам, поломку ловит машина, не пенсионер.
//
// Принцип (урок Космоса 24.08): зелёный тест, который ничего не проверил, ХУЖЕ красного.
// Поэтому здесь НЕТ тихих пропусков. Если функция не извлеклась из js/app.js —
// щит падает с объяснением, а не рапортует «ок». Что нельзя проверить без живого
// браузера/облака — честно перечислено в конце как НЕ покрытое, не выдаётся за зелёное.
//
// Метод: вырезаем реальные чистые функции из js/app.js (как smoke-agent-router.mjs)
// и гоняем их в песочнице с подставными хранилищами. Тестируется РАБОЧИЙ код, не копия.

import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('js/app.js', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`ЩИТ СЛОМАН: функция ${name} исчезла из js/app.js — путь больше не защищён`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`ЩИТ СЛОМАН: не удалось вырезать функцию ${name}`);
}

function extractConstLine(name) {
  const re = new RegExp(`^const ${name}=.*;$`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`ЩИТ СЛОМАН: константа ${name} исчезла из js/app.js`);
  return m[0];
}

// Подставные хранилища — тест сам задаёт данные, реальные функции их читают.
const state = { notes: [], trash: [], tagRules: null };
const context = vm.createContext({
  console,
  getNotes: () => state.notes,
  getTrash: () => state.trash,
  getTagRules: () => state.tagRules,
});

// Порядок важен: сначала константы и мелкие хелперы, потом то, что на них опирается.
const pieces = [
  extractConstLine('IDEA_TAG'),
  extractConstLine('IDEA_TAG_ALIASES'),
  extractConstLine('FILED_FOLDER_PREFIX'),
  extractFunction('_cleanTag'),
  extractFunction('_tagKey'),
  extractFunction('normalizeIdeaTag'),
  extractFunction('normalizeAiTags'),
  extractFunction('_isFiledFolderTag'),
  extractFunction('pad'),
  extractFunction('_mergeNoteArrays'),
  extractFunction('_mergeTrashArrays'),
  extractFunction('_searchNotes'),
  extractFunction('_localClassify'),
  extractFunction('parseDt'),
  extractFunction('_tsToIso'),
  extractFunction('_nextRecurringTime'),
  extractFunction('_applyTombs'),
];
vm.runInContext(pieces.join('\n'), context);
const run = (expr) => vm.runInContext(expr, context);

let failed = 0;
let passed = 0;
function check(desc, cond) {
  if (cond) { passed += 1; console.log(`  ok  ${desc}`); }
  else { failed += 1; console.log(`  BAD ${desc}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── ПУТЬ 1 + 5: запись не теряется при синхронизации/офлайн-догоне ──
// Сердце бага rz-v407: устройство B не должно стирать заметку устройства A при слепом push,
// а офлайн-догон = тот же merge. Если этот блок красный — пользователь теряет данные молча.
section('ПУТЬ 1+5 · слияние заметок не теряет и не воскрешает (ядро rz-v407)');
{
  state.trash = [];
  // локальная заметка, которой нет в облаке — выживает (офлайн-запись догнала облако)
  run('globalThis.__m = _mergeNoteArrays([{id:"a",updatedAt:5}], [])');
  check('локальная-только заметка выживает после merge', run('__m.length===1 && __m[0].id==="a"'));

  // облачная заметка, которой нет локально — выживает (заметка с другого устройства)
  run('globalThis.__m = _mergeNoteArrays([], [{id:"b",updatedAt:5}])');
  check('облачная-только заметка выживает после merge', run('__m.length===1 && __m[0].id==="b"'));

  // конфликт: новее по updatedAt побеждает
  run('globalThis.__m = _mergeNoteArrays([{id:"c",body:"new",updatedAt:20}], [{id:"c",body:"old",updatedAt:10}])');
  check('новее по updatedAt перезаписывает старое', run('__m.length===1 && __m[0].body==="new"'));

  // конфликт: старее локально НЕ затирает свежее облачное (иначе теряем правку с др. устройства)
  run('globalThis.__m = _mergeNoteArrays([{id:"d",body:"stale",updatedAt:5}], [{id:"d",body:"fresh",updatedAt:30}])');
  check('старое локально НЕ затирает свежее облачное', run('__m.length===1 && __m[0].body==="fresh"'));

  // локально удалённую заметку облако НЕ воскрешает
  state.trash = [{ id: 'z' }];
  run('globalThis.__m = _mergeNoteArrays([], [{id:"z",body:"zombie",updatedAt:99}])');
  check('удалённая заметка НЕ воскресает из облака', run('__m.length===0'));
  state.trash = [];
}

// ── ПУТЬ 1 (удаление) + корзина ──
section('ПУТЬ 1 · корзина не теряет удаления при pull-до-push');
{
  run('globalThis.__t = _mergeTrashArrays([{id:"x",_deletedAt:10}], [])');
  check('локальное удаление выживает в merged корзине', run('__t.length===1 && __t[0].id==="x"'));
  run('globalThis.__t = _mergeTrashArrays([{id:"y",_deletedAt:50}], [{id:"y",_deletedAt:20}])');
  check('позднее удаление побеждает раннее', run('__t.length===1 && __t[0]._deletedAt===50'));
}

// ── ПУТЬ 3: «вспомнил когда надо» — поиск по смыслу, не только по буквам ──
// Сердце продукта. Заметка находится по разбору агента (aiSummary/aiTags),
// даже если в теле нет дословного слова запроса.
section('ПУТЬ 3 · поиск находит по смыслу (aiSummary/тег), не только по телу');
{
  state.trash = [];
  state.notes = [
    { id: 'p1', title: 'Код от домофона', body: '4729', aiSummary: 'пароль код доступ подъезд', aiTags: ['дом'], updatedAt: 3 },
    { id: 'p2', title: 'Молоко', body: 'купить 2 пачки', aiTags: ['покупки'], updatedAt: 2 },
  ];
  // запрос «пароль» — в теле p1 его НЕТ, есть в aiSummary разбора → должен найтись
  run('globalThis.__s = _searchNotes("пароль")');
  check('находит по смыслу из aiSummary (слова нет в теле)', run('__s.active.some(n=>n.id==="p1")'));
  // запрос по тегу
  run('globalThis.__s = _searchNotes("покупки")');
  check('находит по AI-тегу', run('__s.active.some(n=>n.id==="p2")'));
  // дословный поиск по телу тоже работает
  run('globalThis.__s = _searchNotes("молоко")');
  check('находит по дословному телу', run('__s.active.some(n=>n.id==="p2")'));
  // слишком короткий запрос — пусто (не заваливаем весь список)
  run('globalThis.__s = _searchNotes("п")');
  check('запрос <2 символов не возвращает мусор', run('__s.active.length===0 && __s.trash.length===0'));
  state.notes = [];
}

// ── ПУТЬ 1 (авто-тег) + 3 (findability): локальный классификатор по началу слова ──
// Урок соседа-Гили: маркер сверяется с началом слова, не подстрокой —
// «выкупались»/«записаться» не должны падать в покупки/api.
section('ПУТЬ 1/3 · классификатор ловит по началу слова, не подстрокой (урок Гили)');
{
  state.tagRules = { tags: { покупки: { kw: ['куп', 'магазин'] }, дом: { kw: ['домофон', 'квартир'] } } };
  run('globalThis.__c = _localClassify("купить хлеб в магазине")');
  check('«купить … магазине» → покупки, уверенно', run('__c.sure===true && __c.tags.includes("покупки")'));
  run('globalThis.__c = _localClassify("выкупались в море")');
  check('«выкупались» НЕ покупки (началось не с «куп»)', run('!__c.tags.includes("покупки")'));
  state.tagRules = null;
  run('globalThis.__c = _localClassify("что угодно")');
  check('без правил классификатор молчит, не падает', run('__c.sure===false && __c.tags.length===0'));
}

// ── ПУТЬ 4: напоминание срабатывает в срок — верный разбор времени ──
// Если parseDt врёт — напоминание молчит или бьёт не вовремя. Это тихая поломка.
section('ПУТЬ 4 · время напоминания разбирается точно (parseDt)');
{
  run('globalThis.__d = parseDt("2026-08-27T09:30")');
  check('ISO-строка → верные дата/часы/минуты', run('__d && __d.getFullYear()===2026 && __d.getMonth()===7 && __d.getDate()===27 && __d.getHours()===9 && __d.getMinutes()===30'));
  run('globalThis.__d = parseDt("1735730400000")');
  check('числовой timestamp разбирается', run('__d && !isNaN(__d.getTime())'));
  check('мусор → null (не мнимое срабатывание)', run('parseDt("завтра")===null && parseDt("")===null && parseDt(null)===null'));
  // окно «в срок»: за advance-минуты до времени попадаем в диапазон, задолго — нет
  run('globalThis.__due = (()=>{const t=parseDt("2026-08-27T09:30").getTime();const adv=30*60*1000;const at5min=t-5*60*1000;const at2h=t-2*60*60*1000;return {near:(t-at5min>=0&&t-at5min<=adv),far:(t-at2h>=0&&t-at2h<=adv)};})()');
  check('за 5 мин — в окне срабатывания', run('__due.near===true'));
  check('за 2 часа — ещё рано, не срабатывает', run('__due.far===false'));
}

// ── ПУТЬ 4 (повтор): напоминание гаснет и перепланируется ──
section('ПУТЬ 4 · повторяющееся напоминание находит следующее время');
{
  run('globalThis.__n = _nextRecurringTime(["09:00","21:00"])');
  check('следующее время в будущем, валидное', run('typeof __n==="number" && __n>Date.now()-1000'));
}

// ── ПУТЬ 1 (удаление папок) + мультидевайс: надгробия не воскрешают удалённое ──
// Тот же класс, что rz-v407: папка, удалённая на одном устройстве, не должна ожить
// из облака на другом. И наоборот — пересозданная позже удаления папка должна выжить.
// Раньше это стерегли 6 разовых юнит-тестов вне щита (BAG 4); теперь — на каждой сборке.
section('ПУТЬ 1 · надгробия папок: удалённое не воскресает, пересозданное живёт (BAG 4)');
{
  const key = 'f=>f.name';
  run(`globalThis.__kf = ${key}`);
  // папка удалена (метка 100) позже создания (10) → выкидывается при merge с облаком
  run('globalThis.__f = _applyTombs([{name:"старое",createdAt:10}], {"старое":100}, __kf)');
  check('удалённая папка НЕ воскресает из облака', run('__f.length===0'));
  // та же папка пересоздана (createdAt 200) уже ПОСЛЕ удаления (100) → остаётся
  run('globalThis.__f = _applyTombs([{name:"старое",createdAt:200}], {"старое":100}, __kf)');
  check('пересозданная после удаления папка выживает (строгое >)', run('__f.length===1'));
  // папка без надгробия — не трогаем
  run('globalThis.__f = _applyTombs([{name:"живое",createdAt:10}], {"другое":100}, __kf)');
  check('папка без метки удаления остаётся', run('__f.length===1 && __f[0].name==="живое"'));
  // порча входа (не массив) — graceful, не роняет синхронизацию
  run('globalThis.__f = _applyTombs(null, {}, __kf)');
  check('битый вход (не массив) не роняет merge', run('__f===null'));
}

// ── ИТОГ ──
console.log(`\n${'─'.repeat(48)}`);
console.log(`Проверок пройдено: ${passed}, провалено: ${failed}`);

console.log(`\nЧЕСТНО НЕ ПОКРЫТО здесь (нужен живой браузер/облако — не выдаём за зелёное):`);
console.log(`  · фактическая запись в localStorage и выживание после перезагрузки (path 1 — DOM/PWA)`);
console.log(`  · расшифровка голоса SpeechRecognition → заметка (path 2 — только на устройстве)`);
console.log(`  · реальный офлайн-догон: flush очереди при возврате сети (path 5 — сеть+Supabase)`);
console.log(`  · настоящее срабатывание уведомления/VAPID-пуша (path 4 — служба ОС)`);
console.log(`  Это проверяется руками по texts/TEST_GRID.md. Здесь — только чистая логика ядра.`);

if (failed) {
  console.error(`\n❌ ЗОЛОТОЙ ЩИТ ПРОБИТ: ${failed} провал(ов). НЕ деплоить — путь пользователя под угрозой.`);
  process.exit(1);
}
console.log(`\n✅ Золотой щит цел: ядро пяти путей держится.`);
