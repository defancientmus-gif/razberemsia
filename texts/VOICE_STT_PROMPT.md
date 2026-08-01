# Промт настройки голосового распознавания — «слышит как родной»

> Переносимый промт. Вставь в любую AI-сессию или новый проект (БУ.шка и далее) —
> описывает всю архитектуру STT «Разберёмся» с точными настройками и граблями,
> на которые мы реально наступили. Источники: `js/app.js` (клиент, 5 распознавателей +
> WAV-путь), `supabase/functions/ai/index.ts` action `transcribe` (сервер).

---

## Главный принцип (выстрадан на проде)

**Родной `SpeechRecognition` браузера слышит ЛУЧШЕ серверных движков** (и Yandex, и Whisper) —
он оптимизирован под диктовку, стримит на лету, бесплатный и не требует ни сети до нашего
сервера, ни токенов. Поэтому иерархия всегда такая:

```
1. window.SpeechRecognition / webkitSpeechRecognition  ← ПРИОРИТЕТ, если есть
2. getUserMedia → AudioContext → WAV → наш сервер:
   2a. Yandex SpeechKit  (основной серверный)
   2b. Groq Whisper      (резерв, два фолбэка модели)
3. Тост «Голосовой ввод не поддерживается»
```

Когда нужен путь 2: standalone-PWA на iOS (там SR бывает недоступен), некоторые
Android-браузеры. Проверка тривиальная: `const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(SR){...}`.

---

## Ярус 1 — родной SpeechRecognition (базовая настройка)

```js
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = new SR();
rec.lang = 'ru-RU';
rec.continuous = true;        // не останавливаться после первой фразы
rec.interimResults = false;   // только финальные куски (см. исключение ниже)
```

**Настройка под контекст использования** (у нас 5 экземпляров — каждому экрану свой):

| Где | interimResults | Почему |
|---|---|---|
| Блокнот на главной (надиктовка) | **true** | текст появляется в поле живьём, пока говоришь — вау-эффект диктовки |
| Лист заметки / быстрая голосовая | false | вставляем только финальные куски — меньше дёрганья текста |
| Голос агента | false + **`maxAlternatives=3`** | альтернативы распознавания шлём агенту — LLM сам выберет по смыслу, что ты имел в виду |

**Обязательные обработчики (все грабли проверены):**

```js
rec.onresult = e => {
  let fin = '';
  for (let i = e.resultIndex; i < e.results.length; i++)
    if (e.results[i].isFinal) fin += e.results[i][0].transcript;
  if (fin) appendToField(fin);   // ДОПИСЫВАТЬ, не заменять — continuous даёт куски
};
rec.onerror = e => {
  if (e.error === 'no-speech') return;  // НЕ ошибка — юзер просто молчал, не пугать тостом
  showToast('Ошибка голоса: ' + e.error);
  cleanup();
};
rec.onend = () => {
  // SR останавливается САМ (пауза в речи, таймаут ОС) — не только по нашей команде.
  // Здесь собираем накопленное и завершаем UI-состояние. Не забыть обнулить ссылку.
  finishAndCleanup();
};
```

Для агента дополнительно копим альтернативы:
```js
_alts = Array.from(e.results[i]).slice(1, 3).map(a => a.transcript).filter(Boolean);
// → уходят в payload agent_query как alternatives: LLM выбирает по смыслу
```

---

## Ярус 2 — WAV-запись (fallback, когда SR недоступен)

### Захват микрофона — ровно эти constraints:

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: {
  channelCount: 1,          // моно — серверу больше не нужно, трафик ×2 меньше
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true     // тихий голос вытягивается сам
}});
const ctx = new AudioContext({ sampleRate: 16000 });  // ПРОСИМ 16к…
if (ctx.state === 'suspended') await ctx.resume();     // iOS: контекст спит до жеста
const actualRate = ctx.sampleRate;                     // …но ВЕРИМ только реальному
```

**⚠️ ГЛАВНАЯ ГРАБЛЯ (rz-v398, полдня дебага):** iOS игнорирует запрошенный `sampleRate`
и пишет на 48000. Если сервер думает, что пришло 16000 — движок получает «кашу»
(речь в 3 раза быстрее). **Всегда слать на сервер `actualRate`, не запрошенный.**

### Сбор PCM:

```js
const src  = ctx.createMediaStreamSource(stream);
const proc = ctx.createScriptProcessor(4096, 1, 1);
const gain = ctx.createGain(); gain.gain.value = 0;  // без фидбека в колонки,
src.connect(proc); proc.connect(gain); gain.connect(ctx.destination); // но цепь до destination обязательна — иначе proc не тикает
const chunks = [];
proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
```

### Остановка — три числа, без которых режутся слова:

```js
const LEAD_SILENCE_MS  = 250;  // тишина ДО речи (вклеивается в WAV)
const TAIL_RECORD_MS   = 320;  // после отпускания кнопки дозаписываем хвост
const TRAIL_SILENCE_MS = 450;  // тишина ПОСЛЕ речи (вклеивается в WAV)
```
Без паддинга Yandex/Whisper глотают первое и последнее слово. Без дозаписи хвоста
юзер отпускает кнопку на последнем слоге — и слог пропадает.

**Мин-длина:** суммарно `< 0.3 сек` аудио → не слать, тост «Не услышал — попробуйте ещё раз».

### WAV-энкодер: руками, 44-байтовый заголовок + PCM 16-bit LE

Никаких MediaRecorder/webm — codec-зоопарк между браузерами убивает совместимость.
Float32 → Int16 (`s < 0 ? s*0x8000 : s*0x7FFF`), заголовок RIFF/WAVE/fmt/data,
моно, 16 бит. Дальше `btoa` → base64 → JSON на Edge Function.

---

## Ярус 3 — сервер (Edge Function, action `transcribe`)

Порядок провайдеров и почему такой:

### 1. Yandex SpeechKit — основной (лучше слышит русский, дешёвый)
```
POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize
     ?lang=ru-RU&format=lpcm&sampleRateHertz=<РЕАЛЬНЫЙ rate с клиента>
Authorization: Api-Key <YANDEX_STT_KEY>
Content-Type: application/octet-stream
body: wavBytes.slice(44)   ← ⚠️ lpcm = сырой PCM, WAV-заголовок ОБРЕЗАТЬ
```
Пустой `result` или не-200 → тихо падаем на Groq (`console.warn`, юзеру не показываем).

### 2. Groq Whisper — резерв (быстрый, бесплатный тир)
```
POST https://api.groq.com/openai/v1/audio/transcriptions
FormData: file=audio.wav (тут WAV ЦЕЛИКОМ, с заголовком), language=ru, response_format=json
model: 'whisper-large-v3-turbo' → при 400/404 пробуем 'whisper-large-v3'
```
Фолбэк модели только на 400/404 (проблема модели); другие статусы — сразу наружу
с диагностикой `{error, groq_status, groq_detail}` — клиент покажет её в тосте,
чтобы дебажить прод без доступа к логам.

Секреты в Supabase Edge Secrets: `YANDEX_STT_KEY`, `GROQ_API_KEY`. Нет обоих → 500.

---

## Телеметрия (обязательно — иначе прод не отладить)

Клиент после каждой транскрипции пишет в консоль одну строку:
```js
console.info('[rz] agent voice timing', {
  encode_ms,          // сколько жали WAV
  stt_roundtrip_ms,   // полный круг до сервера и назад
  provider,           // 'yandex' | 'groq' — кто реально распознал
  provider_ms,        // время внутри провайдера
  audio_sec,          // длина записи
  wav_kb              // вес payload
});
```
По ней мы поймали и sample_rate-кашу, и медленный Groq.

---

## UX-состояния (пользователь всегда знает, что происходит)

`Слушаю…` (запись) → `Записываю…` (кодирование+отправка) → `Разбираюсь…` (LLM думает)
→ `Говорю…` (TTS-ответ). Ответ голосом: `SpeechSynthesisUtterance`, `lang='ru-RU'`,
`rate=0.92` (чуть медленнее — теплее), `pitch=1.05`.

---

## Чек-лист переноса в новый проект

1. SR-путь первым, WAV-путь фолбэком, сервер двухпровайдерный — скелет выше.
2. `actualRate` с клиента → `sampleRateHertz` в Yandex. Никогда не хардкодить 16000.
3. Yandex ест PCM без заголовка (`slice(44)`), Groq — WAV целиком.
4. Паддинг 250/450 + дозапись 320 мс.
5. `no-speech` — не ошибка. `onend` стреляет сам — собирать там.
6. `gain=0` в цепи, иначе либо фидбек, либо мёртвый ScriptProcessor.
7. Телеметрия-строка с первого дня.
8. Для агентских сценариев — `maxAlternatives=3` и слать альтернативы LLM.

Связано: [[TECH_PROMPT.md]] (весь переносимый промт системы), [[SNAPSHOT.md]] (rz-v397/v398 — история приоритета SR и sample_rate фикса), [[GLASS_STYLE_PROMPT.md]] (промт визуала).
