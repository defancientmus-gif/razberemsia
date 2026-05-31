#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('js/app.js', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
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
  throw new Error(`Cannot extract function ${name}`);
}

const context = vm.createContext({ _agentHistory: [] });
vm.runInContext([
  extractFunction('_agentRouteWord'),
  extractFunction('_agentRouteStarts'),
  extractFunction('_agentRoutingPlan'),
].join('\n'), context);

const cases = [
  ['запиши купить молоко', 'none'],
  ['запомни позвонить маме', 'none'],
  ['напомни купить фильтры завтра', 'none'],
  ['напоминай пить воду каждый день', 'none'],
  ['найди про страховку', 'notes'],
  ['разбери эту заметку', 'notes'],
  ['прочитай последнюю заметку', 'notes'],
  ['удали это', 'notes'],
  ['добавь тег идея к этой заметке', 'notes'],
  ['что у меня сегодня', 'deep'],
  ['составь план по заметкам', 'deep'],
  ['что такое diff', 'light'],
];

let failed = 0;
for (const [text, expected] of cases) {
  const actual = vm.runInContext(`_agentRoutingPlan(${JSON.stringify(text)}).profile`, context);
  const ok = actual === expected;
  console.log(`${ok ? 'ok ' : 'BAD'} ${actual.padEnd(5)} <- ${JSON.stringify(text)}`);
  if (!ok) {
    console.log(`    expected: ${expected}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\nAgent router smoke failed: ${failed}`);
  process.exit(1);
}

console.log('\nAgent router smoke passed.');
