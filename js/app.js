const SUPABASE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co';
const SUPABASE_ANON_KEY='sb_publishable_YtwehFnevo4R3UpmOnTTXQ_j4PQY21D';
const sbConfigured=/^https:\/\//.test(SUPABASE_URL)&&SUPABASE_ANON_KEY&&!SUPABASE_ANON_KEY.startsWith('PASTE_');
const sb=sbConfigured&&window.supabase?window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
  auth:{detectSessionInUrl:true,persistSession:true,autoRefreshToken:true,flowType:'pkce'}
}):null;

let CU=null,ST=null,EI=null;
let CLOUD_READY_UID=null,CLOUD_SAVE_TIMER=null,CLOUD_LOADING=false;
let _cardSwiping=false; // флаг: карточка перехватила свайп, подавить навигацию

function userScope(){return CU&&CU.id?CU.id:'signed-out';}
function scopedKey(key){return key.startsWith('rz_')?'rz_'+userScope()+'_'+key.slice(3):key;}
function readJson(key,fallback){try{const raw=localStorage.getItem(scopedKey(key));return raw?JSON.parse(raw):fallback;}catch(e){return fallback;}}
function writeJson(key,value){localStorage.setItem(scopedKey(key),JSON.stringify(value));queueCloudSave();}
function readText(key){return localStorage.getItem(scopedKey(key))||'';}
function writeText(key,value){localStorage.setItem(scopedKey(key),String(value||''));queueCloudSave();}
function migrateLegacyLocal(){['rz_notes','rz_trash','rz_history','rz_name'].forEach(key=>{const target=scopedKey(key);if(localStorage.getItem(target)!==null)return;const legacy=localStorage.getItem(key);if(legacy!==null)localStorage.setItem(target,legacy);});}
function getNotes(){return readJson('rz_notes',[]);}
function saveNotes(notes){writeJson('rz_notes',notes);}
function getTrash(){return readJson('rz_trash',[]);}
function saveTrash(trash){writeJson('rz_trash',trash);}
function getHistory(){return readJson('rz_history',[]);}
function saveHistory(hist){writeJson('rz_history',hist);}
function getAiMemory(){try{const raw=localStorage.getItem(scopedKey('rz_ai_memory'));return raw?JSON.parse(raw):[];}catch(e){return[];}}
function _saveAiMemoryRaw(mem){try{localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(mem));}catch(e){}}
function getSheetDraft(){try{const raw=localStorage.getItem(scopedKey('rz_sheet_draft'));return raw?JSON.parse(raw):null;}catch(e){return null;}}
function saveSheetDraft(){
  const f=document.getElementById('sh1');
  if(!f||!(ST==='note'||ST==='list'))return;
  const text=f.value||'';
  const key=scopedKey('rz_sheet_draft');
  if(!text.trim()){localStorage.removeItem(key);return;}
  const cat=document.getElementById('sheet-cat-btn')?.dataset.label||'заметка';
  const reminder=document.getElementById('sheet-reminder-in')?.value||'';
  localStorage.setItem(key,JSON.stringify({st:ST,ei:EI||null,body:text,label:cat,reminder,updatedAt:Date.now()}));
}
function clearSheetDraft(){try{localStorage.removeItem(scopedKey('rz_sheet_draft'));}catch(e){}}
function maybeRestoreSheetDraft(){
  const d=getSheetDraft();
  if(!d||d.st!==ST||(d.ei||null)!==(EI||null)||Date.now()-(d.updatedAt||0)>7*24*3600*1000)return;
  const f=document.getElementById('sh1');
  if(!f||!d.body||f.value===d.body)return;
  f.value=d.body;
  if(d.label)showSheetCat(safeLabel(d.label));
  initSheetReminder(d.reminder||'');
  initSheetUndo(d.body);
  autoGrowTA(f);updCharCount(f);
  showToast('Вернул черновик');
}
function addToAiMemory(summary,tags,noteId){
  if(!summary||summary.length<5)return;
  const mem=getAiMemory();
  mem.push({id:'mem_'+Date.now(),note_id:noteId||null,cluster:'personal',summary:summary.slice(0,200),importance:3,accepted:true,tags:Array.isArray(tags)?tags:[],created_at:new Date().toISOString()});
  if(mem.length>30)mem.shift();
  _saveAiMemoryRaw(mem);
}
function getAiMemoryContext(){
  const mem=getAiMemory().slice(-7).reverse().map(m=>m.summary).filter(Boolean);
  if(mem.length<4){
    const extra=getNotes().filter(n=>n.id!==EI&&n.aiSummary).slice(0,5).map(n=>n.aiSummary);
    extra.forEach(s=>{if(!mem.includes(s))mem.push(s);});
  }
  return mem.slice(0,7);
}
function cloudAllowed(){return !!(sb&&CU&&CU.id);}
function isMissingAiMemoryColumn(error){
  const msg=String(error?.message||error?.details||error?.hint||error||'').toLowerCase();
  return msg.includes('ai_memory')&&(msg.includes('column')||msg.includes('schema cache')||msg.includes('does not exist')||msg.includes('could not find'));
}
async function loadCloudData(){
  if(!cloudAllowed()||CLOUD_READY_UID===CU.id)return;
  CLOUD_LOADING=true;
  try{
    let {data,error}=await sb.from('user_state').select('notes,trash,history,ai_memory,name').eq('user_id',CU.id).maybeSingle();
    if(error&&isMissingAiMemoryColumn(error)){
      console.warn('ai_memory column is not ready yet, loading cloud state without it');
      const fallback=await sb.from('user_state').select('notes,trash,history,name').eq('user_id',CU.id).maybeSingle();
      data=fallback.data;error=fallback.error;
    }
    if(error)throw error;
    if(data){
      if(Array.isArray(data.notes))localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(data.notes));
      if(Array.isArray(data.trash))localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(data.trash));
      if(Array.isArray(data.history))localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
      if(Array.isArray(data.ai_memory))localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
      if(typeof data.name==='string')localStorage.setItem(scopedKey('rz_name'),data.name);
    } else if(getNotes().length||getTrash().length||getHistory().length||getAiMemory().length||readText('rz_name')){
      await saveCloudNow();
    }
    CLOUD_READY_UID=CU.id;
  }catch(e){
    console.warn('cloud load failed (attempt 1)',e);
    CLOUD_LOADING=false;
    // Сеть при старте PWA может ещё не быть готова — ждём 3 сек и тихо пробуем снова
    setTimeout(async()=>{
      if(CLOUD_READY_UID===CU?.id)return; // уже загрузилось
      try{
        CLOUD_LOADING=true;
        let {data,error}=await sb.from('user_state').select('notes,trash,history,ai_memory,name').eq('user_id',CU.id).maybeSingle();
        if(error&&isMissingAiMemoryColumn(error)){
          const fallback=await sb.from('user_state').select('notes,trash,history,name').eq('user_id',CU.id).maybeSingle();
          data=fallback.data;error=fallback.error;
        }
        if(error)throw error;
        if(data){
          if(Array.isArray(data.notes))localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(data.notes));
          if(Array.isArray(data.trash))localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(data.trash));
          if(Array.isArray(data.history))localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
          if(Array.isArray(data.ai_memory))localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
          if(typeof data.name==='string')localStorage.setItem(scopedKey('rz_name'),data.name);
          loadAll(); // обновляем UI с данными из облака
        }
        CLOUD_READY_UID=CU?.id;
      }catch(e2){
        console.warn('cloud load failed (attempt 2)',e2);
        // Только теперь говорим пользователю — и то без тоста, данные есть локально
      }finally{CLOUD_LOADING=false;}
    },3000);
    return; // данные локальные уже в localStorage — приложение работает
  }
  finally{CLOUD_LOADING=false;}
}
function queueCloudSave(){if(CLOUD_LOADING||!cloudAllowed())return;clearTimeout(CLOUD_SAVE_TIMER);CLOUD_SAVE_TIMER=setTimeout(saveCloudNow,700);}
async function saveCloudNow(){
  if(!cloudAllowed())return;
  try{
    const payload={user_id:CU.id,notes:getNotes(),trash:getTrash(),history:getHistory(),ai_memory:getAiMemory(),name:readText('rz_name'),updated_at:new Date().toISOString()};
    let {error}=await sb.from('user_state').upsert(payload,{onConflict:'user_id'});
    if(error&&isMissingAiMemoryColumn(error)){
      console.warn('ai_memory column is not ready yet, saving cloud state without it');
      const {ai_memory,...fallbackPayload}=payload;
      const fallback=await sb.from('user_state').upsert(fallbackPayload,{onConflict:'user_id'});
      error=fallback.error;
    }
    if(error)throw error;
  }catch(e){console.warn('cloud save failed',e);showToast('Не удалось сохранить в облако');}
}
function setAuthChecking(checking){
  const card=document.querySelector('#auth-screen .auth-card');
  if(card)card.classList.toggle('checking',!!checking);
}
let _vpTimer=null;
function syncViewportForKeyboard(){
  // Дебаунс 40ms — убирает дрожание при анимации клавиатуры
  clearTimeout(_vpTimer);
  _vpTimer=setTimeout(_doSyncViewport,40);
}
function _doSyncViewport(){
  const vv=window.visualViewport;
  const h=vv?vv.height:window.innerHeight;
  const top=vv?vv.offsetTop:0;
  const kb=vv?Math.max(0,window.innerHeight-vv.height-vv.offsetTop):0;
  document.documentElement.style.setProperty('--vvh',h+'px');
  document.documentElement.style.setProperty('--vvtop',top+'px');
  document.documentElement.style.setProperty('--kb',kb+'px');
  document.documentElement.classList.toggle('keyboard-open',kb>80);
}
syncViewportForKeyboard();
if(window.visualViewport){
  visualViewport.addEventListener('resize',syncViewportForKeyboard);
  visualViewport.addEventListener('scroll',syncViewportForKeyboard);
}
window.addEventListener('resize',syncViewportForKeyboard);

// ── CLOCK ──
(function(){
  const D=['вс','пн','вт','ср','чт','пт','сб'];
  const MG=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  function upd(){
    const n=new Date();
    const hd=document.getElementById('hdate');
    if(hd)hd.textContent=D[n.getDay()]+', '+n.getDate()+' '+MG[n.getMonth()];
    // Часы без секунд — обновляем раз в минуту (было каждую секунду)
    const el=document.getElementById('hclock');
    if(el)el.textContent=pad(n.getHours())+':'+pad(n.getMinutes());
  }
  upd();
  // Синхронизируем с началом следующей минуты, потом раз в 60с
  const now=new Date();
  setTimeout(()=>{upd();setInterval(upd,60000);}, (60-now.getSeconds())*1000);
})();

// ── AUTH ──
// Splash удалён — auth-screen является заставкой. Он виден сразу при загрузке.
async function initAuth(){
  if(!sb){
    setAuthChecking(false);
    showAuthErr(sbConfigured?'Не удалось загрузить облачное подключение. Проверьте интернет и обновите страницу.':'Supabase ещё не настроен. Добавьте URL и anon key.');
    return;
  }
  // auth-card уже в checking-состоянии по HTML — ждём сессию
  try{
    const {data}=await sb.auth.getSession();
    if(data?.session?.user){
      await enterUser(data.session.user);
    } else {
      setAuthChecking(false); // показываем поле почты
    }
  }catch(e){console.warn('session check failed',e);setAuthChecking(false);}
  // Регистрируем после getSession — избегаем двойного enterUser через INITIAL_SESSION
  sb.auth.onAuthStateChange(async(event,session)=>{
    if(session?.user){
      if(CU&&CU.id===session.user.id)return;
      await enterUser(session.user);
    } else {
      if(!CU)return;
      CU=null;CLOUD_READY_UID=null;
      const m=document.getElementById('main-app');
      if(m)m.style.display='none';
      showAuthScr();
    }
  });
}

function showAuthErr(msg){
  // Показываем ошибку в том шаге который сейчас активен
  const emailErr=document.getElementById('email-err');
  const otpErr=document.getElementById('otp-err');
  const codeActive=document.getElementById('step-code')?.classList.contains('active');
  const errEl=codeActive?otpErr:emailErr;
  if(errEl){errEl.textContent=msg;errEl.style.display='block';}
}
async function enterUser(user){
  CU=user;migrateLegacyLocal();await loadCloudData();
  showApp();updUI(user);loadAll();
  _maybeOnboard();
}

// ── ONBOARDING — один раз при первом входе ──
function _onbKey(){return'rz_onboarded_'+(CU?.id||'guest');}
function _maybeOnboard(){
  if(localStorage.getItem(_onbKey()))return;
  // Пропускаем если оба разрешения уже есть
  const notifOk=notifGranted();
  const micOk=localStorage.getItem('rz_mic_granted')==='1';
  if(notifOk&&micOk){localStorage.setItem(_onbKey(),'1');return;}
  // Показываем нужный шаг первым
  setTimeout(()=>{
    const ov=document.getElementById('onboard-overlay');
    if(!ov)return;
    ov.style.display='flex';
    if(notifOk){onbNext(1);}// уведомления есть — сразу микрофон
  },600);
}
function onbNext(step){
  document.getElementById('onb-step-0').style.display=step===0?'flex':'none';
  document.getElementById('onb-step-1').style.display=step===1?'flex':'none';
}
function onbNotif(){
  if(!notifSupp()){onbNext(1);return;}
  Notification.requestPermission().then(p=>{
    renderNotifBanner();
    if(p==='granted')scheduleAll();
    onbNext(1);
  });
}
function onbMic(){
  navigator.mediaDevices?.getUserMedia({audio:true}).then(stream=>{
    stream.getTracks().forEach(t=>t.stop());
    localStorage.setItem('rz_mic_granted','1');
    onbDone();
  }).catch(()=>onbDone());
}
function onbDone(){
  localStorage.setItem(_onbKey(),'1');
  const ov=document.getElementById('onboard-overlay');
  if(!ov)return;
  ov.style.opacity='0';
  ov.style.transition='opacity .3s';
  setTimeout(()=>{ov.style.display='none';ov.style.opacity='';ov.style.transition='';},320);
}
function showApp(){
  const a=document.getElementById('auth-screen');
  if(a){
    a.classList.add('hidden');
    setTimeout(()=>a.classList.add('gone'),420);
  }
  const m=document.getElementById('main-app');
  if(m)m.style.display='flex';
}
function showAuthScr(){
  // auth-screen всегда виден — просто снимаем checking с карточки
  setAuthChecking(false);
  const a=document.getElementById('auth-screen');
  if(a){a.classList.remove('hidden','gone');a.style.opacity='1';}
}
function updUI(u){
  const email=u&&u.email?u.email:'—';
  const name=readText('rz_name');
  document.getElementById('hmenu-phone').textContent=email;
  document.getElementById('hmenu-name').textContent=name||'Добро пожаловать';
  document.getElementById('set-account-disp').textContent=email;
  document.getElementById('set-name-disp').textContent=name||'—';
  const ni=document.getElementById('name-input');if(ni)ni.value=name;
}
let _otpEmail='';
let _resendTimer=null;

async function sendEmailLink(){
  const email=(document.getElementById('email-input')?.value||'').trim().toLowerCase();
  const eEl=document.getElementById('email-err'),btn=document.getElementById('email-btn');
  if(eEl){eEl.style.display='none';eEl.textContent='';}
  if(!sb){showAuthErr(sbConfigured?'Не удалось загрузить облачное подключение. Обновите страницу.':'Supabase ещё не настроен');return;}
  if(!/^\S+@\S+\.\S{2,}$/.test(email)){showAuthErr('Введите почту полностью, например: name@gmail.com');return;}
  btn.disabled=true;

  // Анимация ожидания на кнопке
  let dots=0;
  const ticker=setInterval(()=>{
    dots=(dots+1)%4;
    btn.textContent='Отправляем'+'.'.repeat(dots||1);
  },400);

  try{
    // Таймаут 10 секунд — если Supabase не ответил, показываем ошибку
    const withTimeout=Promise.race([
      sb.auth.signInWithOtp({email,options:{shouldCreateUser:true}}),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),10000))
    ]);
    const {error}=await withTimeout;
    if(error)throw error;
    _otpEmail=email;
    localStorage.setItem('rz_last_email',email);
    const disp=document.getElementById('sent-email-disp');
    if(disp)disp.textContent=email;
    document.getElementById('step-email').classList.remove('active');
    document.getElementById('step-code').classList.add('active');
    const oi=document.getElementById('otp-input');
    if(oi){oi.value='';setTimeout(()=>oi.focus(),120);}
    startResendTimer();
  }catch(e){
    console.warn('otp send failed',e);
    const msg=String(e?.message||e?.error_description||e?.error||'').toLowerCase();
    const dbg=new URLSearchParams(location.search).has('debug');
    let text='Не удалось отправить код — попробуйте ещё раз.';
    if(/timeout/i.test(msg)){
      text='Сервер не ответил. Проверьте интернет и попробуйте ещё раз.';
    } else if(/rate|security|seconds|minute|limit/i.test(msg)){
      text='Код уже отправлялся. Подождите минуту и попробуйте ещё раз.';
    } else if(/not allowed|disabled|enable|provider/i.test(msg)){
      text='Вход по почте временно недоступен.';
    } else if(/invalid.*email|email.*invalid|format/i.test(msg)){
      text='Проверьте адрес почты — кажется, он введён неправильно.';
    }
    if(dbg)text+=' ['+String(e?.message||e).slice(0,120)+']';
    showAuthErr(text);
  }finally{
    clearInterval(ticker);
    btn.disabled=false;
    btn.textContent='Получить код';
  }
}

async function verifyOtpCode(){
  const code=(document.getElementById('otp-input')?.value||'').trim().replace(/\D/g,'');
  const eEl=document.getElementById('otp-err'),btn=document.getElementById('otp-btn');
  if(eEl){eEl.style.display='none';eEl.textContent='';}
  if(code.length!==6){
    if(eEl){eEl.textContent='Введите 6-значный код из письма';eEl.style.display='block';}
    return;
  }
  btn.disabled=true;btn.textContent='Проверяем...';
  try{
    const {data,error}=await sb.auth.verifyOtp({email:_otpEmail,token:code,type:'email'});
    if(error)throw error;
    if(data?.session?.user)await enterUser(data.session.user);
  }catch(e){
    console.warn('otp verify failed',e);
    const msg=String(e?.message||'').toLowerCase();
    let text='Неверный или устаревший код. Запросите новый.';
    if(/expired/i.test(msg))text='Код устарел — запросите новый ниже.';
    if(/invalid/i.test(msg))text='Неверный код. Проверьте письмо и попробуйте ещё раз.';
    if(eEl){eEl.textContent=text;eEl.style.display='block';}
  }finally{btn.disabled=false;btn.textContent='Войти';}
}

function onOtpInput(el){
  el.value=el.value.replace(/\D/g,'').slice(0,6);
  if(el.value.length>=6)verifyOtpCode();
}

async function resendCode(){
  const btn=document.getElementById('resend-btn');
  btn.disabled=true;
  const eEl=document.getElementById('otp-err');
  if(eEl){eEl.style.display='none';}
  try{
    const {error}=await sb.auth.signInWithOtp({email:_otpEmail,options:{shouldCreateUser:true}});
    if(error)throw error;
    const oi=document.getElementById('otp-input');
    if(oi){oi.value='';oi.focus();}
    startResendTimer();
  }catch(e){
    if(eEl){eEl.textContent='Не удалось отправить код. Подождите и попробуйте ещё раз.';eEl.style.display='block';}
    btn.disabled=false;
  }
}

function startResendTimer(){
  clearInterval(_resendTimer);
  const btn=document.getElementById('resend-btn');
  const timerEl=document.getElementById('resend-timer');
  const secEl=document.getElementById('resend-sec');
  if(btn)btn.disabled=true;
  if(timerEl)timerEl.classList.remove('hidden');
  let sec=60;
  if(secEl)secEl.textContent=sec;
  _resendTimer=setInterval(()=>{
    sec--;
    if(secEl)secEl.textContent=sec;
    if(sec<=0){
      clearInterval(_resendTimer);
      if(btn)btn.disabled=false;
      if(timerEl)timerEl.classList.add('hidden');
    }
  },1000);
}

function backToEmail(){
  clearInterval(_resendTimer);
  document.getElementById('step-code').classList.remove('active');
  document.getElementById('step-email').classList.add('active');
  const eEl=document.getElementById('email-err');
  if(eEl){eEl.style.display='none';}
}
function skipToCode(){
  const email=(document.getElementById('email-input')?.value||'').trim();
  if(!email){
    const eEl=document.getElementById('email-err');
    if(eEl){eEl.textContent='Введите почту, потом нажмите «Уже есть код»';eEl.style.display='block';}
    return;
  }
  _otpEmail=email;
  const disp=document.getElementById('sent-email-disp');
  if(disp)disp.textContent=email;
  const eErr=document.getElementById('email-err');if(eErr){eErr.style.display='none';}
  const oErr=document.getElementById('otp-err');if(oErr){oErr.style.display='none';}
  document.getElementById('step-email').classList.remove('active');
  document.getElementById('step-code').classList.add('active');
  const oi=document.getElementById('otp-input');
  if(oi){oi.value='';oi.focus();}
}

// ── DARK THEME ──
(function initTheme(){
  if(localStorage.getItem('rz_dark')==='1')document.documentElement.classList.add('dark');
  updateThemeMeta();
})();

function toggleTheme(){
  const isDark=document.documentElement.classList.toggle('dark');
  localStorage.setItem('rz_dark',isDark?'1':'0');
  updateThemeMeta();
  syncThemeMenu();
}

function updateThemeMeta(){
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta)meta.setAttribute('content',document.documentElement.classList.contains('dark')?'#111515':'#f0ede6');
}

function syncThemeMenu(){
  const isDark=document.documentElement.classList.contains('dark');
  const ico=document.getElementById('theme-menu-ico');
  const lbl=document.getElementById('theme-menu-t');
  if(ico)ico.innerHTML=isDark
    ?'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    :'<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  if(lbl)lbl.textContent=isDark?'Светлая тема':'Тёмная тема';
}

// ── MENU ──
function toggleMenu(e){
  e.stopPropagation();
  const m=document.getElementById('hmenu'),b=document.getElementById('hbtn');
  m.classList.contains('open')?closeMenu():(syncThemeMenu(),m.classList.add('open'),b.classList.add('open'));
}
function closeMenu(){
  document.getElementById('hmenu').classList.remove('open');
  document.getElementById('hbtn').classList.remove('open');
}
document.addEventListener('click',e=>{
  const m=document.getElementById('hmenu');
  if(m.classList.contains('open')&&!m.contains(e.target))closeMenu();
});

// ── SETTINGS ──
function saveName(){
  const v=document.getElementById('name-input').value.trim();if(!v)return;
  writeText('rz_name',v);
  document.getElementById('set-name-disp').textContent=v;
  document.getElementById('hmenu-name').textContent=v;
  showToast('Имя сохранено ✓');
}

// ── SIGN OUT ──
async function doSignOut(e){
  if(e)e.preventDefault();
  if(!confirm('Выйти из аккаунта?'))return;
  try{if(sb)await sb.auth.signOut();}catch(err){console.warn('sign out failed',err);}
  CU=null;CLOUD_READY_UID=null;closeMenu();go('home');
  const m=document.getElementById('main-app');if(m)m.style.display='none';
  showAuthScr();setAuthChecking(false);
}

// ── NAVIGATION ──
let cur='home';
function go(id){
  closeMenu();
  const p=document.getElementById('s-'+cur),n=document.getElementById('s-'+id);
  if(!p||!n||p===n)return;
  p.classList.add(id==='home'?'sr':'sl');p.classList.remove('active');
  setTimeout(()=>p.classList.remove('sl','sr'),280);
  n.classList.remove('sl','sr');n.classList.add('active');
  cur=id;n.scrollTop=0;
  if(id==='home')loadHomeFeed();
  if(id==='notes'){renderNotifBanner();loadNotes();}
  if(id==='notepad')loadNotepad();
  if(id==='trash')loadTrash();
}

// ── AI PANEL ──
const SUPABASE_EDGE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co/functions/v1/ai';
let _aiOn=false;

function toggleAiPanel(){
  const btn=document.getElementById('sheet-ai-btn');
  const panel=document.getElementById('ai-panel');
  if(!btn||!panel)return;
  _aiOn=!_aiOn;
  btn.classList.toggle('ai-on',_aiOn);
  if(!_aiOn){panel.style.display='none';return;}
  const f=document.getElementById('sh1');
  const text=(f?.value||'').trim();
  panel.style.display='block';
  const bodyEl=document.getElementById('ai-panel-body');
  if(text.length<15){
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">Напишите немного больше — тогда AI сможет помочь.</div></div>`;
    _scrollToAiPanel();
    return;
  }
  runAiAnalysis(text,panel);
}
function toggleAiCollapse(){
  const panel=document.getElementById('ai-panel');
  if(!panel)return;
  const body=document.getElementById('ai-panel-body');
  const btn=document.getElementById('ai-collapse-btn');
  const isCollapsed=panel.classList.contains('collapsed');
  if(!isCollapsed&&body){
    body.style.maxHeight=body.scrollHeight+'px';
    requestAnimationFrame(()=>{body.style.maxHeight='0px';});
  }
  panel.classList.toggle('collapsed');
  if(btn)btn.style.transform=isCollapsed?'rotate(0deg)':'rotate(180deg)';
  if(isCollapsed&&body){
    requestAnimationFrame(()=>{
      body.style.maxHeight=body.scrollHeight+'px';
      setTimeout(()=>{body.style.maxHeight='';},320);
    });
  }
}

// ── ИСПРАВЛЕНИЕ ТЕКСТА (кнопка-карандаш в шапке) ──
// Первое нажатие: отправляет rewrite, применяет результат, подсвечивает кнопку
// Повторное нажатие: возвращает исходный текст, гасит кнопку
let _spellOriginal=null;   // оригинальный текст до исправления
let _spellLoading=false;   // идёт запрос

async function toggleSpellFix(){
  if(_spellLoading)return;
  const btn=document.getElementById('sheet-spell-btn');
  const f=document.getElementById('sh1');
  if(!f)return;

  // ── Если исправление уже активно — откатываем ──
  if(_spellOriginal!==null){
    f.value=_spellOriginal;
    _spellOriginal=null;
    autoGrowTA(f);onSheetInput();
    if(btn){btn.classList.remove('spell-on');btn.title='Исправить орфографию и пунктуацию';}
    showToast('Вернули исходный текст');
    return;
  }

  const text=f.value.trim();
  if(text.length<15){showToast('Напишите больше текста');return;}

  // ── Запрос ──
  _spellLoading=true;
  if(btn){btn.classList.add('spell-loading');btn.disabled=true;}
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)throw new Error('Войдите в аккаунт');
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'rewrite',payload:{text}})
    });
    if(!res.ok)throw new Error(await readErrorText(res));
    const {rewritten}=await res.json();
    if(!rewritten)throw new Error('Пустой ответ от AI');
    _spellOriginal=f.value;          // сохраняем оригинал
    f.value=rewritten;
    autoGrowTA(f);onSheetInput();
    if(btn){btn.classList.add('spell-on');btn.title='Нажми ещё раз — вернуть исходный текст';}
    showToast('✓ Текст исправлен — нажми ✏️ снова чтобы вернуть');
  }catch(e){
    showToast('Не получилось: '+String(e?.message||''));
  }finally{
    _spellLoading=false;
    if(btn){btn.classList.remove('spell-loading');btn.disabled=false;}
  }
}
function _scrollToAiPanel(){
  const sa=document.getElementById('sheet-scroll-area');
  if(sa)sa.scrollTo({top:sa.scrollHeight,behavior:'smooth'});
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function isAiOverloaded(message){
  const raw=String(message||'').toLowerCase();
  return raw.includes('overloaded')||raw.includes('529')||raw.includes('rate limit');
}
function friendlyAiError(message,status){
  const raw=String(message||'').trim();
  if(raw==='no session')return 'Войдите в аккаунт для AI-функций.';
  if(isAiOverloaded(raw)||status===529)return 'AI сейчас перегружен. Попробуйте ещё раз через минуту.';
  if(/api key|key не настроен/i.test(raw))return 'AI-ключ не настроен на сервере.';
  if(/unknown action/i.test(raw))return 'Неизвестное действие — проверь версию Edge Function.';
  if(/invalid json/i.test(raw))return 'AI ответил в неправильном формате. Попробуйте ещё раз.';
  if(status===401||status===403)return 'Не получилось подтвердить вход. Выйдите и войдите снова.';
  if(status>=500)return 'AI-сервер временно недоступен. Попробуйте чуть позже.';
  return raw?'Ошибка AI: '+raw:'Ошибка AI. Попробуйте ещё раз.';
}
async function readErrorText(res){
  const text=await res.text().catch(()=>'');
  if(!text)return res.statusText;
  try{
    const data=JSON.parse(text);
    const err=data?.error;
    if(typeof err==='string')return err;
    if(err&&typeof err==='object')return err.message||JSON.stringify(err);
    return data?.message||text;
  }catch(e){
    return text;
  }
}
async function runAiAnalysis(text,panel,attempt=0){
  let autoLabel=null;
  const bodyEl=document.getElementById('ai-panel-body');
  if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-loading"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-dasharray="40" stroke-dashoffset="40"><animate attributeName="stroke-dashoffset" values="40;0;40" dur=".8s" repeatCount="indefinite"/></path></svg>${attempt?'AI занят, пробую ещё раз...':'Анализирую...'}</div></div>`;
  _scrollToAiPanel();
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)throw new Error('no session');
    const memoryContext=getAiMemoryContext();
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'analyze',payload:{text,memoryContext}})
    });
    if(!res.ok){
      const errText=await readErrorText(res);
      if(attempt<1&&(isAiOverloaded(errText)||res.status===502||res.status===529)){
        await sleep(1400);
        return runAiAnalysis(text,panel,attempt+1);
      }
      throw new Error(friendlyAiError(errText,res.status));
    }
    const {summary,tags,actions}=await res.json();
    autoLabel=tagsToPrimaryLabel(tags||[]);
    if(autoLabel){
      const curCat=document.getElementById('sheet-cat-btn')?.dataset.label||'заметка';
      if(curCat==='заметка'){showSheetCat(autoLabel);showCatHint(autoLabel);}
    }
    let html='<div class="ai-panel-inner">';
    if(summary){html+=`<div class="ai-section"><div class="ai-label">Суть</div><div class="ai-text">${esc(summary)}</div></div>`;}
    if(tags?.length){
      const tagBtns=tags.map(t=>{
        const exists=typeof tagFolderExists==='function'&&tagFolderExists(t);
        return `<button type="button" class="ai-tag${exists?' ai-tag--active':''}" data-tag="${esc(t)}" onclick="toggleTagFolder(${jsAttr(t)})" title="${exists?'Открыть папку':'Создать папку в Заметках'}">${esc(t)}</button>`;
      }).join('');
      html+=`<div class="ai-section"><div class="ai-label-row"><span class="ai-label">Теги — нажми чтобы создать папку</span><button type="button" class="ai-tag-add-btn" onclick="promptNewTag()">+ тег</button></div><div class="ai-tags">${tagBtns}</div></div>`;
    }
    const activeCat=autoLabel||'заметка';
    if(actions?.length){html+=`<div class="ai-section ai-actions-section"><button type="button" class="ai-actions-toggle" onclick="(function(btn){const s=btn.closest('.ai-actions-section');const b=s.querySelector('.ai-actions-body');const open=s.classList.toggle('open');if(open){b.style.maxHeight='none';const h=b.scrollHeight;b.style.maxHeight='0';requestAnimationFrame(()=>{b.style.maxHeight=h+'px';setTimeout(()=>{b.style.maxHeight='none';},320);});}else{b.style.maxHeight=b.scrollHeight+'px';requestAnimationFrame(()=>{b.style.maxHeight='0';});}})(this)"><span class="ai-label">Можно сделать <span class="ai-actions-hint">(${actions.length})</span></span><svg class="ai-actions-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></button><div class="ai-actions-body"><div class="ai-actions" style="margin-top:8px;">${actions.map((a,i)=>`<div class="ai-action-card"><div class="ai-action-text">${esc(a)}</div><div class="ai-action-btns"><button class="ai-accept-btn" onclick="acceptAiAction(${i})">✓ Сделаю</button><button class="ai-reject-btn" onclick="rejectAiAction(${i})">Не надо</button></div></div>`).join('')}</div></div></div>`;}
    const settings=getReminderSettings();
    const reminderAlreadySet=!!(document.getElementById('sheet-reminder-in')?.value);
    if(settings.aiSuggest&&hasTimeHint(text)&&!reminderAlreadySet){
      html+=`<div class="ai-section"><button class="ai-remind-btn" onclick="applyAiReminder()"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>AI замечает время — поставить напоминание?</button></div>`;
    }
    html+='</div>';
    if(bodyEl){bodyEl.innerHTML=html;bodyEl.style.maxHeight=bodyEl.scrollHeight+'px';}
    panel.dataset.aiTags=JSON.stringify(Array.isArray(tags)?tags:[]);
    panel.dataset.aiSummary=summary||'';
    // ── Авто-сохранение идей в репозиторий ──
    // \b не работает с кириллицей — проверяем: после "идея" не идёт буква
    const isIdea=(tags||[]).some(t=>/^идеи?$|^ideas?$/i.test(t.trim()))
      || /^идея([^а-яёА-ЯЁa-zA-Z]|$)/i.test(text.trim());
    if(isIdea){
      const nid=document.getElementById('sheet-wrap')?.dataset.noteId||'';
      _saveIdeaToRepo({text,summary:summary||'',tags:tags||[],actions:actions||[],noteId:nid})
        .catch(e=>console.warn('save_idea failed',e));
    }
    // editBtn removed
    _scrollToAiPanel();
  }catch(e){
    console.warn('AI error',e);
    const msg=String(e?.message||'').startsWith('Ошибка AI:')||String(e?.message||'').startsWith('AI ')||String(e?.message||'').startsWith('Войдите')||String(e?.message||'').startsWith('Не получилось')?String(e?.message):friendlyAiError(e?.message);
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">${esc(msg)}</div></div>`;
    // editBtn removed
    _scrollToAiPanel();
  }
}

// ── SAVE IDEA TO REPO ──
async function _saveIdeaToRepo({text,summary,tags,actions,noteId}){
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)return;
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'save_idea',payload:{text,summary,tags,actions,noteId}})
    });
    if(!res.ok){
      const err=await res.text();
      console.warn('save_idea error',res.status,err);
      return;
    }
    const {saved,file}=await res.json();
    if(saved){showToast('✦ Идея сохранена в репозиторий');}
    console.info('idea saved:',file);
  }catch(e){
    console.warn('_saveIdeaToRepo failed',e);
  }
}

// ── FEEDBACK / ПОМОЧЬ РАЗРАБОТЧИКУ ──
function openFeedbackSheet(){
  const ov=document.getElementById('feedback-overlay');
  const pn=document.getElementById('feedback-panel');
  const ta=document.getElementById('feedback-ta');
  if(!ov||!pn)return;
  // Без rAF — классы сразу, иначе первый тап уходит в оверлей во время анимации
  ov.classList.add('fb-open');
  pn.classList.add('fb-open');
  if(ta){ta.value='';setTimeout(()=>ta.focus(),320);}
}
function closeFeedbackSheet(){
  const ov=document.getElementById('feedback-overlay');
  const pn=document.getElementById('feedback-panel');
  if(ov)ov.classList.remove('fb-open');
  if(pn)pn.classList.remove('fb-open');
}
async function submitFeedback(){
  const ta=document.getElementById('feedback-ta');
  const text=(ta?.value||'').trim();
  if(text.length<5){showToast('Напиши хоть немного :)');return;}
  const name=readText('rz_name')||'Друг';
  const fullText=`Фидбек от ${name}:\n\n${text}`;
  const summary=`Фидбек: ${text.slice(0,80)}`;
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token){showToast('Нужно войти в аккаунт');return;}
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'save_idea',payload:{
        text:fullText,
        summary,
        tags:['фидбек','от-друга'],
        actions:[],
        noteId:'fb_'+Date.now().toString(36)
      }})
    });
    if(res.ok){
      showToast('💌 Спасибо! Я обязательно прочитаю');
      closeFeedbackSheet();
    } else {
      showToast('Не получилось отправить, попробуй позже');
    }
  }catch(e){
    showToast('Ошибка: '+String(e?.message||''));
  }
}

// ── AI CHAT REPLY ──
async function _fetchChatReply(noteId, text){
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)return;
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'chat_reply',payload:{text}})
    });
    if(!res.ok)return;
    const {reply}=await res.json();
    if(!reply)return;
    const notes=getNotes();
    const n=notes.find(x=>x.id===noteId);
    if(!n)return;
    // Сохраняем в aiChat-массив (микроблог)
    if(!Array.isArray(n.aiChat))n.aiChat=[];
    n.aiChat.push({role:'ai',text:reply,ts:Date.now()});
    n.aiReplyLike=n.aiReplyLike||0;
    // Обратная совместимость
    n.aiReply=reply;
    saveNotes(notes);
    _renderReplyBubble(noteId);
  }catch(e){console.warn('chat reply failed',e);}
}

function _firstAiMsg(n){
  // Первое AI-сообщение из aiChat или старый aiReply
  if(Array.isArray(n.aiChat)&&n.aiChat.length){
    const m=n.aiChat.find(m=>m.role==='ai');
    if(m)return m.text;
  }
  return n.aiReply||null;
}

function _renderReplyBubble(noteId){
  const el=document.getElementById('ai-reply-'+noteId);
  if(!el)return;
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  const firstMsg=n?_firstAiMsg(n):null;
  if(!firstMsg){el.style.display='none';return;}
  el.style.display='block';
  el.innerHTML=_buildReplyHTML(n,firstMsg);
  const feed=document.getElementById('home-feed');
  if(feed)requestAnimationFrame(()=>{feed.scrollTop=feed.scrollHeight;});
}

function _buildReplyHTML(n,firstMsg){
  const like=n.aiReplyLike||0;
  const nId=esc(n.id);
  const text=firstMsg||_firstAiMsg(n)||'';
  const chatCount=Array.isArray(n.aiChat)?n.aiChat.length:0;
  const liked=like===1;
  return `<div class="ai-reply-bubble" onclick="openNoteSheetById('${nId}')" title="Открыть — продолжить диалог">
    <div class="ai-reply-icon">✦</div>
    <div class="ai-reply-content">
      <div class="ai-reply-text">${esc(text)}</div>
      <div class="ai-reply-actions">
        ${chatCount>1?`<span class="ai-reply-thread">${chatCount} сообщ.</span>`:''}
        <button class="ai-reply-heart ${liked?'liked':''}" onclick="event.stopPropagation();rateReply('${nId}',${liked?0:1})" title="${liked?'Убрать лайк':'Нравится'}">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="${liked?'currentColor':'none'}"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        </button>
      </div>
    </div>
  </div>`;
}

function rateReply(noteId, val){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  n.aiReplyLike=val;
  saveNotes(notes);
  _renderReplyBubble(noteId);
}

// ── ЧАТ ВНУТРИ ЗАМЕТКИ ──
let _chatNoteId=null;
let _chatSending=false;

function renderNoteChat(n){
  const wrap=document.getElementById('note-chat');
  const inputRow=document.getElementById('note-chat-input-row');
  if(!wrap)return;
  const msgs=Array.isArray(n.aiChat)?n.aiChat:[];
  _chatNoteId=n.id;
  if(!msgs.length){wrap.style.display='none';if(inputRow)inputRow.style.display='none';return;}
  wrap.style.display='block';
  if(inputRow)inputRow.style.display='flex';
  wrap.innerHTML=msgs.map(m=>{
    const isAi=m.role==='ai';
    return `<div class="nc-msg nc-msg-${isAi?'ai':'user'}">
      ${isAi?'<div class="nc-icon">✦</div>':''}
      <div class="nc-text">${esc(m.text)}</div>
    </div>`;
  }).join('');
  // Прокрутить к последнему сообщению
  requestAnimationFrame(()=>{wrap.scrollTop=wrap.scrollHeight;});
}

async function sendNoteChat(){
  if(_chatSending)return;
  const inp=document.getElementById('note-chat-in');
  const text=(inp?.value||'').trim();
  if(!text){inp?.focus();return;}
  const notes=getNotes();
  const n=notes.find(x=>x.id===_chatNoteId);
  if(!n)return;
  if(!Array.isArray(n.aiChat))n.aiChat=[];
  // Добавляем сообщение пользователя
  n.aiChat.push({role:'user',text,ts:Date.now()});
  saveNotes(notes);
  if(inp)inp.value='';
  renderNoteChat(n);
  // Блокируем кнопку
  _chatSending=true;
  const btn=document.getElementById('note-chat-send');
  if(btn){btn.disabled=true;btn.style.opacity='.4';}
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)throw new Error('no token');
    // Строим контекст: последние 6 сообщений для более умного ответа
    const ctx=n.aiChat.slice(-6).map(m=>(m.role==='user'?'Пользователь: ':'AI: ')+m.text).join('\n');
    const prompt=n.body+'\n\n---\n'+ctx+'\n\nПользователь: '+text;
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'chat_reply',payload:{text:prompt}})
    });
    if(res.ok){
      const {reply}=await res.json();
      if(reply){
        const notes2=getNotes();
        const n2=notes2.find(x=>x.id===_chatNoteId);
        if(n2){
          if(!Array.isArray(n2.aiChat))n2.aiChat=[];
          n2.aiChat.push({role:'ai',text:reply,ts:Date.now()});
          saveNotes(notes2);
          renderNoteChat(n2);
          // Обновить счётчик на главном экране
          _renderReplyBubble(_chatNoteId);
        }
      }
    }
  }catch(e){showToast('Не удалось отправить');}
  finally{
    _chatSending=false;
    if(btn){btn.disabled=false;btn.style.opacity='';}
  }
}

// ── SWIPE BACK ──
(function(){
  let sx=0,sy=0,st=0;
  document.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY;st=Date.now();},{passive:true});
  document.addEventListener('touchend',e=>{
    if(Date.now()-st>280)return;
    if(_cardSwiping){_cardSwiping=false;return;} // карточка перехватила свайп
    const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dy)>55)return;
    // Навигация: только от левого края (sx<44px), правый свайп ≥90px
    if(dx>90&&sx<44&&cur!=='home')go('home');
    if(dx<-90&&sx<44&&cur==='home'){go('notes');return;}
    if(dx>90&&sx<44&&cur==='notes'){go('home');return;}
  },{passive:true});
})();

// ── LIST NOTES ──
function openListSheet(noteId){
  // Убираем category и reminder через класс
  const overlay=document.getElementById('overlay');
  if(overlay)overlay.classList.add('list-mode');
  EI=noteId||null;
  document.getElementById('sheet-title').textContent='Список';
  if(noteId){
    const n=getNotes().find(x=>x.id===noteId);
    const txt=(n?.items||[]).map(it=>it.t).join('\n');
    document.getElementById('sheet-body').innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Каждый пункт с новой строки">${esc(txt)}</textarea>`;
  } else {
    document.getElementById('sheet-body').innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Молоко&#10;Хлеб&#10;Яйца&#10;&#10;Вставьте или напишите — каждый пункт с новой строки"></textarea>`;
  }
  document.getElementById('sheet-char-count').textContent='';
  ST='list';
  _openSheet();
  setTimeout(()=>{
    const ta=document.getElementById('sh1');
    if(ta){ta.focus();if(!noteId)ta.select();}
  },120);
}

function saveListSheet(){
  const f=document.getElementById('sh1');
  const raw=f?f.value:'';
  const items=raw.split('\n').map(t=>t.trim()).filter(Boolean);
  if(!items.length){showToast('Список пустой');return;}
  const ts=Date.now();
  const notes=getNotes();
  if(EI){
    // Редактирование: сохраняем состояния галочек если текст совпадает
    const old=notes.find(n=>n.id===EI);
    const oldItems=old?.items||[];
    const merged=items.map(t=>{
      const prev=oldItems.find(o=>o.t===t);
      return {t,d:prev?prev.d:false};
    });
    const idx=notes.findIndex(n=>n.id===EI);
    if(idx>=0){notes[idx]={...notes[idx],items:merged,updatedAt:ts};}
  } else {
    const note={id:genId(),type:'list',items:items.map(t=>({t,d:false})),createdAt:ts,updatedAt:ts};
    notes.push(note);
  }
  saveNotes(notes);
  clearSheetDraft();
  loadHomeFeed();loadNotes();
  closeSheet();
  showToast(EI?'Список обновлён ✓':'Список сохранён ✓');
}

function toggleListItem(noteId,idx){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n||!n.items)return;
  n.items[idx].d=!n.items[idx].d;
  n.updatedAt=Date.now();
  saveNotes(notes);
  // Перерисовываем только этот пузырь
  renderListBubble(noteId);
}

function renderListBubble(noteId){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  const el=document.getElementById('list-inner-'+noteId);
  if(!el)return;
  el.innerHTML=buildListInner(n);
}

function buildListInner(n){
  const items=n.items||[];
  const done=items.filter(i=>i.d).length;
  const progress=items.length>1?`<div class="list-progress">${done} из ${items.length}</div>`:'';
  const rows=items.map((it,idx)=>`
    <div class="list-item${it.d?' done':''}" onclick="event.stopPropagation();toggleListItem('${esc(n.id)}',${idx})">
      <div class="list-cb"></div>
      <span class="list-item-text">${esc(it.t)}</span>
    </div>`).join('');
  return progress+`<div class="list-items">${rows}</div>`;
}


let _toastT=null;
function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(_toastT);_toastT=setTimeout(()=>t.classList.remove('show'),2600);
}

// ── ESC ──
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function jsAttr(s){return esc(JSON.stringify(String(s||'')));}
function safeLabel(label){
  return CATS.includes(label)?label:'заметка';
}

// ── NOTIFICATIONS ──
function notifGranted(){try{return'Notification'in window&&Notification.permission==='granted';}catch(e){return false;}}
function notifSupp(){try{return'Notification'in window;}catch(e){return false;}}

function renderNotifBanner(){
  const el=document.getElementById('notif-banner-el');if(!el)return;
  if(!notifSupp()||Notification.permission==='granted'){el.innerHTML='';return;}
  if(Notification.permission==='denied'){
    el.innerHTML='<div class="notif-banner"><div class="notif-text">Уведомления заблокированы. Разрешите в настройках телефона.</div></div>';return;
  }
  el.innerHTML=`<div class="notif-banner"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg><div class="notif-text">Разрешите уведомления — напоминания будут приходить вовремя.</div><button class="notif-allow-btn" onclick="reqNotif()">Разрешить</button></div>`;
}
function reqNotif(){
  if(!notifSupp())return;
  Notification.requestPermission().then(p=>{showToast('Статус: '+p);renderNotifBanner();if(p==='granted')scheduleAll();});
}

let _NT=[];
function scheduleAll(){
  _NT.forEach(t=>clearTimeout(t));_NT=[];
  if(!notifGranted())return;
  const notes=getNotes();

  // ── 1. SW — системные уведомления (работает в фоне, без сети) ──
  // SW показывает системный попап. Страница его НЕ дублирует.
  const swNotes=notes.filter(n=>n.reminder&&n.title).map(n=>({
    id:n.id,title:n.title,body:n.body?.slice(0,100)||'',reminder:n.reminder
  }));
  if('serviceWorker'in navigator&&navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage({type:'SCHEDULE',notes:swNotes});
  }

  // ── 2. setTimeout в странице — только внутренний баннер (без system Notification) ──
  // Если страница открыта в момент напоминания — показываем карточку поверх контента
  notes.forEach(n=>{
    if(!n.reminder||!n.title)return;
    const dt=parseDt(n.reminder);if(!dt)return;
    const delay=dt.getTime()-Date.now();
    if(delay<=0||delay>7*24*3600*1000)return;
    const tid=setTimeout(()=>{
      showInAppReminder(n); // только внутренний баннер, SW уже показал системное
      updateReminderDot();
    },delay);
    _NT.push(tid);
  });

  updateReminderDot();
}

// Пересылаем в SW при каждом возвращении в приложение
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&notifGranted())scheduleAll();
});

// ── Умная обработка напоминания после сохранения заметки ──
function _handleReminderAfterSave(reminderVal){
  if(notifGranted()){
    scheduleAll(); // тихо — пользователь уже разрешил на онбординге
    return;
  }
  if(!notifSupp()||Notification.permission==='denied'){
    // Уведомления заблокированы системно — тихо показываем скрытую кнопку-запасник
    const calBtn=document.getElementById('sheet-cal-btn');
    if(calBtn)calBtn.style.display='flex';
    setTimeout(()=>showToast('Уведомления недоступны — зайди в Настройки → Разберёмся'),800);
    return;
  }
  // Разрешение не выдано — запрашиваем (если онбординг был пропущен)
  Notification.requestPermission().then(p=>{
    renderNotifBanner();
    if(p==='granted'){scheduleAll();}
  });
}

// ── REMINDER SETTINGS ──
function getReminderSettings(){
  try{const r=localStorage.getItem(scopedKey('rz_remind_settings'));return r?JSON.parse(r):{advanceMinutes:60,aiSuggest:true};}catch(e){return{advanceMinutes:60,aiSuggest:true};}
}
function saveReminderSettings(s){
  try{localStorage.setItem(scopedKey('rz_remind_settings'),JSON.stringify(s));}catch(e){}
}

// ── REMINDER DOT ──
function updateReminderDot(){
  const dot=document.getElementById('remind-dot');if(!dot)return;
  const now=Date.now();
  const has=getNotes().some(n=>{
    if(!n.reminder)return false;
    const dt=parseDt(n.reminder);if(!dt)return false;
    return dt.getTime()>now&&dt.getTime()-now<7*24*3600*1000;
  });
  dot.style.display=has?'block':'none';
}

// ── IN-APP REMINDER BANNER ──
let _inappDismissTimer=null;
function showInAppReminder(note){
  const wrap=document.getElementById('inapp-remind');
  const title=document.getElementById('inapp-remind-title');
  const sub=document.getElementById('inapp-remind-sub');
  const card=document.getElementById('inapp-remind-card');
  if(!wrap||!title||!sub||!card)return;
  title.textContent=note.title||'Напоминание';
  sub.textContent=note.reminder?fmtDt(note.reminder):(note.body||'').slice(0,60);
  card.classList.remove('hiding');
  // Re-trigger drop animation
  card.style.animation='none';
  void card.offsetHeight;
  card.style.animation='';
  wrap.style.display='flex';
  clearTimeout(_inappDismissTimer);
  _inappDismissTimer=setTimeout(()=>dismissInAppReminder(),8000);
}
function dismissInAppReminder(){
  clearTimeout(_inappDismissTimer);
  const card=document.getElementById('inapp-remind-card');
  if(!card)return;
  card.classList.add('hiding');
  setTimeout(()=>{const w=document.getElementById('inapp-remind');if(w)w.style.display='none';card.classList.remove('hiding');},280);
}

// ── PERIODIC IN-APP CHECK ──
let _shownReminders={};
function checkDueReminders(){
  const settings=getReminderSettings();
  const advMs=settings.advanceMinutes*60*1000;
  const now=Date.now();
  getNotes().forEach(n=>{
    if(!n.reminder)return;
    const dt=parseDt(n.reminder);if(!dt)return;
    const diff=dt.getTime()-now;
    const key=n.id+'_'+n.reminder;
    if(diff>=0&&diff<=advMs&&!_shownReminders[key]){
      _shownReminders[key]=true;
      showInAppReminder(n);
    }
    // Clean shown cache for past reminders
    if(diff<-3600000)delete _shownReminders[key];
  });
}
setInterval(checkDueReminders,60000);

// ── ADVANCE TIME LABEL ──
function advanceLabel(min){
  if(min<60)return min+' мин';
  if(min===60)return '1 час';
  if(min<1440)return(min/60|0)+' ч';
  return(min/1440|0)+' д';
}
const ADVANCE_OPTIONS=[15,30,60,120,360,1440];

// ── REMINDER PANEL ──
function openReminderPanel(){
  const overlay=document.getElementById('remind-overlay');
  if(overlay)overlay.classList.add('open');
  renderReminderPanel();
}
function closeReminderPanel(){
  const overlay=document.getElementById('remind-overlay');
  if(overlay)overlay.classList.remove('open');
}
function renderReminderPanel(){
  const scroll=document.getElementById('remind-scroll');if(!scroll)return;
  const notes=getNotes();
  const now=Date.now();
  const upcoming=notes.filter(n=>{
    if(!n.reminder)return false;
    const dt=parseDt(n.reminder);if(!dt)return false;
    return dt.getTime()>now-3600000;
  }).sort((a,b)=>{
    const da=parseDt(a.reminder),db=parseDt(b.reminder);
    return(da?da.getTime():0)-(db?db.getTime():0);
  });
  const settings=getReminderSettings();
  let html='';
  if(upcoming.length){
    html+='<div class="remind-section-label">Предстоящие</div>';
    upcoming.forEach(n=>{
      const dt=parseDt(n.reminder);
      const isPast=dt&&dt.getTime()<now;
      const whenTxt=dt?(isPast?'Было: ':'Через '+(relativeTime(dt.getTime()-now)+' — '))+fmtDt(n.reminder):fmtDt(n.reminder);
      html+=`<div class="remind-item">
        <div class="remind-bell-icon"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></div>
        <div class="remind-item-body">
          <div class="remind-item-title">${esc(n.title||n.body||'Заметка')}</div>
          <div class="remind-item-when" style="${isPast?'color:oklch(0.58 0.16 25);':''}">${esc(whenTxt)}</div>
        </div>
        <button class="remind-item-del" onclick="removeNoteReminder('${n.id}')" title="Удалить напоминание"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
  } else {
    html+=`<div class="remind-empty">🔔<br>Нет активных напоминаний.<br><span style="font-size:12px;">Откройте заметку и нажмите ✦ AI — помощник предложит поставить напоминание.</span></div>`;
  }
  html+='<div class="remind-section-label" style="margin-top:20px;">Настройки</div>';
  html+=`<div class="remind-settings">
    <div class="remind-set-row">
      <span class="remind-set-lbl">Напомнить заранее</span>
      <button class="remind-set-val" id="remind-adv-btn" onclick="cycleAdvance()">${advanceLabel(settings.advanceMinutes)}</button>
    </div>
    <div class="remind-set-row" style="border-top:1px solid oklch(0.88 0.02 210/0.25);margin-top:4px;padding-top:10px;">
      <span class="remind-set-lbl">AI предлагает время</span>
      <label class="remind-toggle">
        <input type="checkbox" id="remind-ai-toggle" ${settings.aiSuggest?'checked':''} onchange="toggleAiSuggest(this.checked)">
        <div class="remind-toggle-track"></div>
        <div class="remind-toggle-thumb"></div>
      </label>
    </div>
  </div>`;
  scroll.innerHTML=html;
}
function relativeTime(ms){
  if(ms<0)return'';
  const m=Math.round(ms/60000);
  if(m<2)return'скоро';
  if(m<60)return m+' мин';
  if(m<1440)return(m/60|0)+' ч';
  return(m/1440|0)+' д';
}
function cycleAdvance(){
  const s=getReminderSettings();
  const idx=ADVANCE_OPTIONS.indexOf(s.advanceMinutes);
  s.advanceMinutes=ADVANCE_OPTIONS[(idx+1)%ADVANCE_OPTIONS.length];
  saveReminderSettings(s);
  const btn=document.getElementById('remind-adv-btn');
  if(btn)btn.textContent=advanceLabel(s.advanceMinutes);
}
function toggleAiSuggest(val){
  const s=getReminderSettings();s.aiSuggest=val;saveReminderSettings(s);
}
function removeNoteReminder(id){
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===id);
  if(idx<0)return;
  notes[idx]={...notes[idx],reminder:null};
  saveNotes(notes);
  scheduleAll();
  loadNotes();loadHomeFeed();
  renderReminderPanel();
  showToast('Напоминание удалено');
}

// ── AI REMINDER SUGGESTION ──
const TIME_WORDS=/завтра|сегодня|вечер|утром|ночью?|понедельник|вторник|среду?|четверг|пятниц|суббот|воскресень|напомни|не забыть|нужно|надо|до \d|через/i;
function hasTimeHint(text){return TIME_WORDS.test(text||'');}
function suggestReminderTime(){
  const d=new Date();d.setDate(d.getDate()+1);d.setHours(10,0,0,0);
  return _fmtIso(d);
}
function applyAiReminder(){
  const suggested=suggestReminderTime();
  const row=document.getElementById('sheet-reminder-row');
  const inp=document.getElementById('sheet-reminder-in');
  const calBtn=document.getElementById('sheet-cal-btn');
  if(row)row.style.display='flex';
  if(inp){inp.value=suggested;inp.focus();}
  showToast('Выберите удобное время 🔔');
}

// ── КНОПКА «Установить напоминание» в панели колокольчика ──
function openInputSheetWithReminder(){
  closeReminderPanel();
  setTimeout(()=>{
    openInputSheet();
    setTimeout(()=>{
      const r=document.getElementById('home-input-reminder');
      if(r){r.focus();r.click();}
    },400);
  },200);
}

// ── УМНЫЙ ПАРСЕР ВРЕМЕНИ ИЗ ГОЛОСА ──
// Понимает: "завтра в три", "через час", "в пятницу вечером", "сегодня в 18:00", "напомни в понедельник"
function _fmtIso(d){
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}
const _WNUM={один:1,одну:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10,одиннадцать:11,двенадцать:12,тринадцать:13,четырнадцать:14,пятнадцать:15,шестнадцать:16,семнадцать:17,восемнадцать:18,девятнадцать:19,двадцать:20,полдень:12,полночь:0};
const _DAYS={понедельник:1,вторник:2,среда:2,среду:3,четверг:4,пятница:5,пятницу:5,суббота:6,субботу:6,воскресенье:0,воскресенью:0};
// Убирает команду напоминания из текста заметки
function stripReminderCommand(text){
  if(!text)return text;
  // Фразы вида "поставь/поставить уведомление/напоминание на ..."
  // "напомни в ...", "напомни через ..."
  // Удаляем всё что идёт после ключевого слова напоминания до конца или до точки
  return text
    .replace(/[,.]?\s*(?:поставь|поставить|поставь мне|добавь|создай)\s+(?:уведомление|напоминание|напомни?)\s+(?:на|в|через)[^\n.]*/gi,'')
    .replace(/[,.]?\s*напомни(?:те)?\s+(?:мне\s+)?(?:в|на|через|завтра|сегодня|послезавтра)[^\n.]*/gi,'')
    .replace(/[,.]?\s*(?:поставь|поставить)\s+напоминание[^\n.]*/gi,'')
    .replace(/\s{2,}/g,' ')
    .trim();
}

function parseVoiceReminder(text){
  if(!text)return null;
  const t=text.toLowerCase();
  const now=new Date();
  let base=null; // base date (без времени)
  let h=null,m=0; // час и минуты

  // ── «через N часов/минут» ──
  const thruM=t.match(/через\s+(\d+|полчаса|час|[\wа-яё]+)\s*(часа?|час(ов)?|минут[ыа]?|мин\.?)?/);
  if(thruM){
    const raw=thruM[1];const unit=thruM[2]||'';
    let amount=parseInt(raw)||_WNUM[raw]||(raw==='полчаса'?0.5:1);
    const d=new Date(now);
    if(raw==='полчаса'||unit.startsWith('мин')){d.setMinutes(d.getMinutes()+Math.round(amount*60));}
    else{d.setHours(d.getHours()+amount);}
    // Округляем до 5 минут
    d.setSeconds(0);d.setMinutes(Math.ceil(d.getMinutes()/5)*5);
    return _fmtIso(d);
  }

  // ── День недели ──
  for(const[word,dow]of Object.entries(_DAYS)){
    if(t.includes(word)){
      const today=now.getDay();
      let diff=(dow-today+7)%7||7; // следующий такой день (не сегодня)
      base=new Date(now);base.setDate(base.getDate()+diff);base.setHours(10,0,0,0);
      break;
    }
  }

  // ── Сегодня / завтра / послезавтра ──
  if(!base){
    if(t.includes('послезавтра')){base=new Date(now);base.setDate(base.getDate()+2);base.setHours(10,0,0,0);}
    else if(t.includes('завтра')){base=new Date(now);base.setDate(base.getDate()+1);base.setHours(10,0,0,0);}
    else if(t.includes('сегодня')){base=new Date(now);base.setHours(20,0,0,0);}
  }

  // ── «утром» «днём» «вечером» «ночью» ──
  if(t.match(/\bутром\b/)){h=8;}
  else if(t.match(/\bднём\b|в обед/)){h=13;}
  else if(t.match(/\bвечером\b/)){h=19;}
  else if(t.match(/\bночью\b/)){h=22;}

  // ── «в/на N:MM» или «в/на N часов» числом ──
  const digitM=t.match(/(?:в|на)\s+(\d{1,2})(?::(\d{2}))?\s*(?:час|утра|дня|вечера|ночи)?/);
  if(digitM){
    let hh=parseInt(digitM[1]);const mm=parseInt(digitM[2]||'0');
    if(hh<8)hh+=12; // «на 3» → 15:00
    h=hh;m=mm;
  }
  // ── Голое HH:MM без предлога (напр. «14:30») ──
  if(h===null){
    const bareM=t.match(/\b(\d{1,2}):(\d{2})\b/);
    if(bareM){let hh=parseInt(bareM[1]);if(hh<8)hh+=12;h=hh;m=parseInt(bareM[2]);}
  }

  // ── «в/на [слово] часов» ──
  const wordM=t.match(/(?:в|на)\s+(один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|полдень|полночь)/);
  if(wordM&&h===null){
    let hh=_WNUM[wordM[1]]||10;
    if(hh<8)hh+=12;
    h=hh;
  }

  if(!base&&h===null)return null; // ничего не нашли

  // Если день не определён, но время есть — сегодня если ещё не прошло, иначе завтра
  if(!base){
    base=new Date(now);
    base.setHours(h,m,0,0);
    if(base<=now){base.setDate(base.getDate()+1);}
  } else if(h!==null){
    base.setHours(h,m,0,0);
    // Если «сегодня» + время уже прошло — сдвигаем на следующий день
    if(base<=now&&t.includes('сегодня')){base.setDate(base.getDate()+1);}
  }

  return _fmtIso(base);
}

// ── DATE UTILS ──
function parseDt(s){
  const p=s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if(!p)return null;
  return new Date(+p[1],+p[2]-1,+p[3],+p[4],+p[5],0);
}
function fmtDt(s){
  const dt=parseDt(s);if(!dt)return s;
  const M=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return dt.getDate()+' '+M[dt.getMonth()]+' в '+pad(dt.getHours())+':'+pad(dt.getMinutes());
}
function fmtMeta(ts){
  if(!ts)return'';
  const d=new Date(ts);
  const M=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  return d.getDate()+' '+M[d.getMonth()]+', '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function pad(x){return String(x).padStart(2,'0');}
function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7);}

// ── CALENDAR ──
let CY=new Date().getFullYear(),CM=new Date().getMonth(),CS=null,YP=false;
let calSwipeX=0;
const MRU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MGN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function openCal(){
  YP=false;
  document.getElementById('year-picker').classList.remove('open');
  calRender();
  document.getElementById('cal-overlay').classList.add('open');
}
function closeCal(){
  document.getElementById('cal-overlay').classList.remove('open');
  updCalTrigger();loadNotes();
}
function calPrev(){CM--;if(CM<0){CM=11;CY--;}CS=null;calRender();}
function calNext(){CM++;if(CM>11){CM=0;CY++;}CS=null;calRender();}

function toggleYearPicker(){
  YP=!YP;
  const yp=document.getElementById('year-picker');
  if(YP){
    yp.innerHTML='';
    const cur=new Date().getFullYear();
    for(let y=cur-2;y<=cur+5;y++){
      const b=document.createElement('button');b.className='year-btn'+(y===CY?' cur':'');
      b.textContent=y;b.onclick=()=>{CY=y;CS=null;YP=false;yp.classList.remove('open');calRender();};
      yp.appendChild(b);
    }
    yp.classList.add('open');
  } else {
    yp.classList.remove('open');
  }
}

function updCalTrigger(){
  const tv=document.getElementById('cal-trigger-val');
  if(tv)tv.textContent=CS?CS.split('-')[2]+' '+MGN[CM]:MRU[CM]+' '+CY;
}

(function(){
  const popup=document.getElementById('cal-popup');
  if(!popup)return;
  popup.addEventListener('touchstart',e=>{calSwipeX=e.touches[0].clientX;},{passive:true});
  popup.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-calSwipeX;
    if(Math.abs(dx)>60){dx<0?calNext():calPrev();}
  },{passive:true});
})();

function calRender(){
  const notes=getNotes();
  const dots=new Set();
  notes.forEach(n=>{
    // Точки на датах создания И напоминания
    const dates=[n.reminder, n.createdAt?new Date(n.createdAt).toISOString().slice(0,10):null].filter(Boolean);
    dates.forEach(s=>{
      const p=s.slice(0,10).split('-').map(Number);
      if(p[0]===CY&&p[1]-1===CM)dots.add(p[2]);
    });
  });
  document.getElementById('cal-month-label').textContent=MRU[CM]+' '+CY;
  const grid=document.getElementById('cal-days');grid.innerHTML='';
  const today=new Date();
  let dow=new Date(CY,CM,1).getDay();if(dow===0)dow=7;
  const dim=new Date(CY,CM+1,0).getDate();
  const dip=new Date(CY,CM,0).getDate();
  for(let i=dow-1;i>0;i--){
    const b=mkDay(dip-i+1,null,true);b.disabled=true;grid.appendChild(b);
  }
  for(let d=1;d<=dim;d++){
    const ds=CY+'-'+pad(CM+1)+'-'+pad(d);
    const isT=d===today.getDate()&&CM===today.getMonth()&&CY===today.getFullYear();
    const b=mkDay(d,ds,false,isT,CS===ds,dots.has(d));
    b.onclick=()=>{CS=CS===ds?null:ds;calRender();};
    grid.appendChild(b);
  }
  updCalTrigger();
}
function mkDay(num,ds,other,isT,isSel,hasDot){
  const b=document.createElement('button');
  b.className='cal-day'+(other?' other':'')+(isT?' today':'')+(isSel?' sel':'');
  b.innerHTML='<span>'+num+'</span>'+(hasDot?'<span class="cal-dot"></span>':'');
  return b;
}

// ── STRIPES (oklch) ──
const STRIPES={
  здоровье:'oklch(0.62 0.14 25)',
  покупки:'oklch(0.58 0.10 250)',
  контакт:'oklch(0.58 0.10 210)',
  событие:'oklch(0.65 0.12 80)',
  идея:'oklch(0.55 0.12 290)',
  рецепт:'oklch(0.62 0.10 60)',
  адрес:'oklch(0.60 0.10 195)',
  заметка:'oklch(0.70 0.04 210)'
};
const CATS=Object.keys(STRIPES);
const ICONS={
  здоровье:'🏥',
  покупки:'🛒',
  контакт:'👤',
  событие:'📅',
  идея:'💡',
  рецепт:'🍽️',
  адрес:'📍',
  заметка:'📝'
};
function catIcon(label){return ICONS[safeLabel(label||'заметка')]||'📄';}

const TAG_TO_CAT={
  здоровье:'здоровье',врач:'здоровье',доктор:'здоровье',давление:'здоровье',
  таблетки:'здоровье',лекарства:'здоровье',аптека:'здоровье',больница:'здоровье',
  анализы:'здоровье',поликлиника:'здоровье',симптом:'здоровье',лечение:'здоровье',
  медицина:'здоровье',диагноз:'здоровье',температура:'здоровье',процедура:'здоровье',
  покупки:'покупки',магазин:'покупки',список:'покупки',продукты:'покупки',
  еда:'покупки',заказ:'покупки',доставка:'покупки',рынок:'покупки',
  семья:'контакт',мама:'контакт',папа:'контакт',дети:'контакт',внуки:'контакт',
  родители:'контакт',позвонить:'контакт',написать:'контакт',связаться:'контакт',
  контакт:'контакт',друг:'контакт',родственник:'контакт',перезвонить:'контакт',
  событие:'событие',встреча:'событие',собрание:'событие',поездка:'событие',
  праздник:'событие',день_рождения:'событие',отпуск:'событие',дата:'событие',
  расписание:'событие',запись:'событие',планирование:'событие',
  идея:'идея',мысль:'идея',план:'идея',желание:'идея',
  мечта:'идея',проект:'идея',концепция:'идея',придумал:'идея',
  рецепт:'рецепт',готовить:'рецепт',блюдо:'рецепт',кулинария:'рецепт',
  ингредиенты:'рецепт',приготовить:'рецепт',
  адрес:'адрес',улица:'адрес',место:'адрес',навигатор:'адрес',маршрут:'адрес'
};

function tagsToPrimaryLabel(tags){
  if(!Array.isArray(tags)||!tags.length)return null;
  const score={};
  tags.forEach(rawTag=>{
    const t=String(rawTag).replace(/^#/,'').toLowerCase().trim().replace(/\s+/g,'_');
    const cat=TAG_TO_CAT[t];
    if(cat)score[cat]=(score[cat]||0)+1;
  });
  if(!Object.keys(score).length)return null;
  return Object.entries(score).sort((a,b)=>b[1]-a[1])[0][0];
}

// ── NOTES ──
let noteFilter=null;
let noteViewMode=localStorage.getItem('rz_note_view')||'list';
let foldersCollapsed=localStorage.getItem('rz_folders_col')==='1';

function toggleNoteView(){
  noteViewMode=noteViewMode==='list'?'grid':'list';
  localStorage.setItem('rz_note_view',noteViewMode);
  animateNoteViewSwitch();
  syncNoteViewBtn();
  loadNotes();
}

function syncNoteViewBtn(){
  const btn=document.getElementById('view-toggle-btn');
  const ico=document.getElementById('vtb-ico');
  const lbl=document.getElementById('vtb-lbl');
  if(!btn)return;
  if(noteViewMode==='grid'){
    btn.classList.add('grid-on');
    if(lbl)lbl.textContent='Список';
    if(ico){
      ico.setAttribute('viewBox','0 0 24 24');
      ico.innerHTML='<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6" stroke-width="2.5"/><line x1="3" y1="12" x2="3.01" y2="12" stroke-width="2.5"/><line x1="3" y1="18" x2="3.01" y2="18" stroke-width="2.5"/>';
    }
  } else {
    btn.classList.remove('grid-on');
    if(lbl)lbl.textContent='Сетка';
    if(ico){
      ico.setAttribute('viewBox','0 0 24 24');
      ico.innerHTML='<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>';
    }
  }
}

function animateNoteViewSwitch(){
  const el=document.getElementById('note-list');if(!el)return;
  el.classList.remove('drop-anim');
  void el.offsetWidth;
  el.classList.add('drop-anim');
  el.addEventListener('animationend',()=>el.classList.remove('drop-anim'),{once:true});
}

function loadNotes(){
  const all=getNotes();
  syncNoteViewBtn();
  const el=document.getElementById('note-list');if(!el)return;
  el.innerHTML='';
  if(noteViewMode==='grid')el.classList.add('note-grid-mode');
  else el.classList.remove('note-grid-mode');
  let filtered=all;
  if(CS){
    // Фильтруем по дате создания ИЛИ напоминанию — не только по напоминанию
    filtered=all.filter(n=>{
      const remMatch=n.reminder&&n.reminder.slice(0,10)===CS;
      const createdMatch=n.createdAt&&new Date(n.createdAt).toISOString().slice(0,10)===CS;
      const updatedMatch=n.updatedAt&&new Date(n.updatedAt).toISOString().slice(0,10)===CS;
      return remMatch||createdMatch||updatedMatch;
    });
  }
  // Передаём уже cs-отфильтрованный список в чипы — счётчики папок будут точными
  renderStatChips(filtered,!!CS);
  if(noteFilter)filtered=filtered.filter(n=>safeLabel(n.label||'заметка')===noteFilter);
  if(!filtered.length){
    const hasFilter=CS||noteFilter;
    el.innerHTML=`<div style="text-align:center;color:var(--fg-l);font-size:15px;padding:28px 0;">
      ${hasFilter?'Нет заметок за этот день':'Заметок пока нет'}
      <br><span style="font-size:13px;display:block;margin-top:5px;">${hasFilter?'':'Нажмите «＋» чтобы добавить'}</span>
      ${CS?`<button onclick="CS=null;loadNotes();calRender();" style="margin-top:12px;padding:8px 18px;border-radius:10px;border:1px solid oklch(0.85 0.03 260);background:none;font-size:13px;color:var(--fg-m);cursor:pointer;font-family:var(--sys);">Показать все заметки</button>`:''}
    </div>`;
    return;
  }
  const sorted=[...filtered].sort((a,b)=>(b.createdAt||b.updatedAt||0)-(a.createdAt||a.updatedAt||0));
  sorted.forEach(n=>{
    const nid=n.id;const i=all.indexOf(n);
    const displayNum=i>=0?i+1:sorted.indexOf(n)+1;
    const stripe=STRIPES[safeLabel(n.label||'заметка')]||STRIPES.заметка;
    const wrap=document.createElement('div');
    wrap.setAttribute('data-nwrap','1');
    const delBg=buildNoteSwipePanel('list', 16, ()=>nid?delNoteById(nid):delNote(i), ()=>shareNote(n));
    const d=document.createElement('div');d.className='item-card';d.style.margin='0';
    const dBtn=document.createElement('button');dBtn.className='desk-del';
    dBtn.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="oklch(0.45 0.15 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    dBtn.onclick=(e)=>{e.stopPropagation();nid?delNoteById(nid):delNote(i);};
    if(noteViewMode==='grid'){
      wrap.style.cssText='position:relative;overflow:hidden;border-radius:16px;';
      const gRem=n.reminder?`<div class="grid-reminder">🔔 ${esc(fmtDt(n.reminder))}</div>`:'';
      d.innerHTML=`<div class="note-stripe-top" style="background:${stripe};"></div>
        <span class="grid-ico">${catIcon(n.label)}</span>
        <div class="grid-cat">#${displayNum} · ${esc(safeLabel(n.label||'заметка'))}</div>
        <div class="grid-title">${esc(n.title)}</div>
        ${gRem}
        <div class="grid-meta">${esc(fmtMeta(n.updatedAt||n.createdAt))}</div>`;
    } else {
      wrap.style.cssText='position:relative;overflow:hidden;border-radius:16px;margin-bottom:8px;';
      let rHtml='';
      if(n.reminder){
        rHtml=`<div style="margin-top:6px;"><span class="reminder-tag"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>${esc(fmtDt(n.reminder))}</span></div>`;
      }
      const tagsHtml=Array.isArray(n.aiTags)&&n.aiTags.length
        ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px;">${n.aiTags.slice(0,2).map(t=>`<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:oklch(0.55 0.12 290 / 0.09);color:oklch(0.40 0.12 290);border:1px solid oklch(0.55 0.12 290 / 0.16);">${esc(t)}</span>`).join('')}</div>`
        : '';
      d.innerHTML=`<div class="note-stripe" style="background:${stripe};"></div>
        <div class="note-num">#${displayNum}</div>
        <div class="note-cat"><span style="font-size:11px;margin-right:4px;">${catIcon(n.label)}</span>${esc(safeLabel(n.label||'заметка'))}</div>
        <div class="item-title">${esc(n.title)}</div>
        ${rHtml}${tagsHtml}
        <div class="item-meta">${esc(fmtMeta(n.updatedAt||n.createdAt))}</div>`;
    }
    d.onclick=()=>nid?openNoteSheetById(nid):openNoteSheet(i);
    attachSwipeDelete(d,delBg,null,116);
    wrap.appendChild(delBg);wrap.appendChild(d);wrap.appendChild(dBtn);el.appendChild(wrap);
  });
}

function renderStatChips(all,csActive){
  const el=document.getElementById('notes-stat');if(!el)return;
  const counts={};
  all.forEach(n=>{const l=safeLabel(n.label||'заметка');counts[l]=(counts[l]||0)+1;});
  const activeL=noteFilter||null;
  const activeIco=activeL?catIcon(activeL):'📋';
  const activeName=activeL?activeL:'Все заметки';
  const activeCount=activeL?(counts[activeL]||0):all.length;
  // Если активен фильтр по дате — баннер с крестиком над папками
  let dateBanner='';
  if(csActive&&CS){
    const d=new Date(CS+'T12:00');
    const dateStr=d.getDate()+' '+MGN[d.getMonth()];
    dateBanner=`<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;margin-bottom:8px;border-radius:10px;background:oklch(0.52 0.10 210 / 0.08);border:1px solid oklch(0.52 0.10 210 / 0.20);font-size:12px;color:oklch(0.40 0.10 210);">
      <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span>Заметки за ${dateStr}</span>
      <button onclick="CS=null;loadNotes();calRender();" style="margin-left:auto;background:none;border:none;cursor:pointer;color:inherit;font-size:16px;line-height:1;padding:0 4px;opacity:.6;">×</button>
    </div>`;
  }
  const totalGroups=Object.keys(counts).length;
  let html=`<div class="folders-hdr${foldersCollapsed?' folders-collapsed':''}" id="folders-hdr" onclick="toggleFolders()">
    <span class="folders-lbl">
      <span class="folders-lbl-feather">𓅭</span>
      Разделы
    </span>
    <span class="folders-chev">
      ${foldersCollapsed?totalGroups+' папок':'свернуть'}
      <svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>
    </span>
  </div>
  <div class="folders-peek" onclick="toggleFolders()">
    <span class="peek-ico">${activeIco}</span>
    <span class="peek-name">${esc(activeName)}</span>
    <span class="peek-count">${activeCount}</span>
    <span class="peek-expand">↓ показать</span>
  </div>
  <div class="folders-grid${foldersCollapsed?'':' unfolding'}" id="folders-grid">`;
  html+=`<button class="folder-card folder-all${!noteFilter?' active':''}" onclick="setFilter(null)">
    <span class="folder-ico">📋</span>
    <div class="folder-body">
      <span class="folder-name">Все заметки</span>
      <span class="folder-pill">${all.length}</span>
    </div>
  </button>`;
  Object.entries(counts).forEach(([l,c])=>{
    html+=`<button class="folder-card${noteFilter===l?' active':''}" onclick="setFilter(${jsAttr(l)})">
      <span class="folder-ico">${catIcon(l)}</span>
      <span class="folder-name">${esc(l)}</span>
      <span class="folder-pill">${c}</span>
    </button>`;
  });
  html+='</div>';
  el.innerHTML=dateBanner+html;
}

function toggleFolders(){
  const grid=document.getElementById('folders-grid');
  if(!foldersCollapsed&&grid){
    const cards=grid.querySelectorAll('.folder-card');
    cards.forEach((c,i)=>{c.style.animation=`featherUp .24s cubic-bezier(.4,0,1,1) ${i*0.04}s both`;});
    setTimeout(()=>{
      foldersCollapsed=true;
      localStorage.setItem('rz_folders_col','1');
      renderStatChips(getNotes(),!!CS);
    },cards.length*40+220);
    return;
  }
  foldersCollapsed=false;
  localStorage.setItem('rz_folders_col','0');
  renderStatChips(getNotes());
  setTimeout(()=>{
    const g=document.getElementById('folders-grid');
    if(g){g.classList.add('unfolding');setTimeout(()=>g.classList.remove('unfolding'),600);}
  },10);
}
function setFilter(f){noteFilter=f?safeLabel(f):null;loadNotes();}

// ── SWIPE HELPERS ──
function buildNoteSwipePanel(shape, radius, onDelete){
  const r=(radius||16)+'px';
  const el=document.createElement('div');
  el.style.cssText=`position:absolute;right:0;top:0;bottom:0;width:64px;display:flex;align-items:center;justify-content:center;border-radius:0 ${r} ${r} 0;opacity:0;transition:opacity .15s;pointer-events:none;`;
  el.innerHTML=`<div class="del-x-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="oklch(0.45 0.20 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>`;
  el._onDelete=onDelete;
  return el;
}

function buildBubbleSwipePanel(onDelete){
  const el=document.createElement('div');
  el.className='bubble-swipe-panel';
  el.style.cssText='position:absolute;right:0;top:0;bottom:0;width:64px;display:flex;align-items:center;justify-content:center;border-radius:0 22px 5px 0;opacity:0;transition:opacity .15s;pointer-events:none;';
  el.innerHTML=`<div class="del-x-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="oklch(0.45 0.20 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>`;
  el._onDelete=onDelete;
  return el;
}

function _makeSwipeAttach(card,xEl){
  const W=64;
  const onDelete=xEl?._onDelete;
  let isOpen=false;
  const reset=()=>{
    isOpen=false;
    card.style.transition='transform .22s cubic-bezier(.4,0,.2,1)';
    card.style.transform='';
    card.style.pointerEvents='';
    if(xEl){xEl.style.opacity='0';xEl.style.pointerEvents='none';}
  };
  const openConfirm=()=>{
    isOpen=true;
    card.style.transition='transform .22s cubic-bezier(.4,0,.2,1)';
    card.style.transform=`translateX(-${W}px)`;
    if(xEl){xEl.style.opacity='1';xEl.style.pointerEvents='auto';xEl.style.cursor='pointer';}
  };
  if(xEl) xEl.onclick=(e)=>{
    e.stopPropagation();
    xEl.style.pointerEvents='none';
    card.classList.add('bubble-popping');
    card.style.pointerEvents='none';
    setTimeout(()=>onDelete?.(),280);
  };
  let sx=0,triggered=false;
  card.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;triggered=false;card.style.transition='none';},{passive:true});
  card.addEventListener('touchmove',e=>{
    const dx=e.touches[0].clientX-sx;
    if(dx<-6){_cardSwiping=true;const shift=Math.max(dx,-W*1.4);card.style.transform=`translateX(${shift}px)`;if(xEl)xEl.style.opacity=String(Math.min(-shift/(W*0.5),1));triggered=-shift>W*0.55;}
  },{passive:true});
  card.addEventListener('touchend',()=>{if(triggered)openConfirm();else reset();},{passive:true});
  card.addEventListener('click',e=>{if(isOpen&&!e.target.closest('.del-x-btn')){e.stopPropagation();reset();}});
}
function attachSwipeDelete(card,xEl){_makeSwipeAttach(card,xEl);}
function attachSwipeBubble(card,xEl){_makeSwipeAttach(card,xEl);}


function shareNote(n){
  const text=(n.title||'')+(n.body&&n.body!==n.title?'\n\n'+(n.body):'');
  if(navigator.share){
    navigator.share({title:'Разберёмся',text:text.trim()}).catch(()=>{});
  } else {
    navigator.clipboard&&navigator.clipboard.writeText(text.trim()).then(()=>showToast('Скопировано ✓')).catch(()=>showToast('Нет доступа к буферу'));
  }
}

// ── BUBBLE EXPAND ──
const expandedBubbles=new Set();
function toggleBubble(id,btn){
  const el=document.getElementById('bt-'+id);if(!el)return;
  if(expandedBubbles.has(id)){
    expandedBubbles.delete(id);el.classList.remove('expanded');
    if(btn)btn.textContent='ещё';
  } else {
    expandedBubbles.add(id);el.classList.add('expanded');
    if(btn)btn.textContent='свернуть';
  }
}

// ── NOTE SHEET ──
let sheetUndoStack=[],sheetRedoStack=[];

let sheetListMode=false;
function noteForm(body=''){
  return`<textarea class="sheet-in" id="sh1" rows="10" placeholder="Что важно запомнить...">${esc(body)}</textarea>`;
}
function autoGrowTA(el){
  if(!el)return;
  el.style.height='auto';
  el.style.height=Math.max(el.scrollHeight,180)+'px';
}

function openNoteSheet(i){
  const notes=getNotes();
  const n=notes[i];if(!n)return;
  _openNoteWith(n);
}
function openNoteSheetById(id){
  const notes=getNotes();
  const n=notes.find(x=>x.id===id);
  if(!n)return;
  _openNoteWith(n);
}
function _openNoteWith(n){
  if(n.type==='list'){openListSheet(n.id);return;}
  ST='note';EI=n.id||null;
  document.getElementById('sheet-title').textContent='Заметка';
  document.getElementById('sheet-body').innerHTML=noteForm(n.body||n.title||'');
  document.getElementById('sheet-char-count').textContent=(n.body||n.title||'').length+' символов';
  showSheetCat(safeLabel(n.label||'заметка'));
  initSheetReminder(n.reminder||'');
  initSheetUndo(n.body||n.title||'');
  // Рендерим чат внутри заметки
  renderNoteChat(n);
  _openSheet();
}

function openSheet(type){
  ST=type;EI=null;_chatNoteId=null;
  document.getElementById('sheet-title').textContent='Новая заметка';
  document.getElementById('sheet-body').innerHTML=noteForm('');
  document.getElementById('sheet-char-count').textContent='0 символов';
  showSheetCat('заметка');
  initSheetReminder('');
  initSheetUndo('');
  const cw=document.getElementById('note-chat');if(cw)cw.style.display='none';
  const cr=document.getElementById('note-chat-input-row');if(cr)cr.style.display='none';
  _openSheet();
}

function _openSheet(){
  syncViewportForKeyboard();
  sheetListMode=false;
  // ── Сбросить AI-панель и spell-fix при открытии нового листа ──
  _aiOn=false;
  _spellOriginal=null;
  const spellBtn=document.getElementById('sheet-spell-btn');
  if(spellBtn){spellBtn.classList.remove('spell-on','spell-loading');spellBtn.disabled=false;}
  const aiBtn=document.getElementById('sheet-ai-btn');
  if(aiBtn)aiBtn.classList.remove('ai-on');
  const aiPanel=document.getElementById('ai-panel');
  if(aiPanel){
    aiPanel.style.display='none';
    aiPanel.classList.remove('collapsed');
    aiPanel.dataset.aiTags='';
    aiPanel.dataset.aiSummary='';
  }
  const aiBody=document.getElementById('ai-panel-body');
  if(aiBody)aiBody.innerHTML='';
  document.getElementById('ai-edit-area')?.remove();
  const panel=document.getElementById('sheet-panel');
  if(panel){panel.style.transform='';panel.style.transition='';}
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>{
    const f=document.getElementById('sh1');
    if(f){
      const fresh=f.cloneNode(true);
      f.parentNode.replaceChild(fresh,f);
      fresh.addEventListener('input',onSheetInput);
      fresh.addEventListener('keydown',onSheetKeydown);
      fresh.addEventListener('paste',onSheetPaste);
      autoGrowTA(fresh);
      maybeRestoreSheetDraft();
      fresh.focus();
    }
    const rem=document.getElementById('sheet-reminder-in');
    if(rem)rem.onchange=saveSheetDraft;
    const bw=document.getElementById('sheet-body');
    if(bw)bw.onclick=(e)=>{if(e.target===bw){const ta=document.getElementById('sh1');if(ta)ta.focus();}};
    const sa=document.getElementById('sheet-scroll-area');
    if(sa)sa.onclick=(e)=>{if(e.target===sa){const ta=document.getElementById('sh1');if(ta)ta.focus();}};
  },120);
}

/* toggleListMode removed — auto-detection handles it */

function onSheetKeydown(e){
  const f=document.getElementById('sh1');if(!f)return;
  const val=f.value,pos=f.selectionStart;
  const lineStart=val.lastIndexOf('\n',pos-1)+1;
  const lineText=val.slice(lineStart,pos);

  if(e.key==='Enter'){
    // ── Numbered list: "1. text" / "1.text" / "1) text" ──
    const numMatch=lineText.match(/^(\d+)[.)]\s*/);
    if(numMatch){
      const rest=lineText.slice(numMatch[0].length).trim();
      if(!rest){
        // Пустой пункт → выход из списка
        e.preventDefault();
        const b=val.slice(0,lineStart).trimEnd();
        f.value=b+'\n'+val.slice(pos);
        f.selectionStart=f.selectionEnd=b.length+1;
        onSheetInput();return;
      }
      e.preventDefault();
      const ins='\n'+(parseInt(numMatch[1])+1)+'. ';
      f.value=val.slice(0,pos)+ins+val.slice(pos);
      f.selectionStart=f.selectionEnd=pos+ins.length;
      onSheetInput();return;
    }
    // ── Bullet list: "- text" / "• text" / "* text" ──
    const bulMatch=lineText.match(/^([•\-\*])\s/);
    if(bulMatch){
      const rest=lineText.slice(bulMatch[0].length).trim();
      if(!rest){
        e.preventDefault();
        const b=val.slice(0,lineStart).trimEnd();
        f.value=b+'\n'+val.slice(pos);
        f.selectionStart=f.selectionEnd=b.length+1;
        onSheetInput();return;
      }
      e.preventDefault();
      const bullet=bulMatch[1]==='*'?'•':bulMatch[1];
      const ins='\n'+bullet+' ';
      f.value=val.slice(0,pos)+ins+val.slice(pos);
      f.selectionStart=f.selectionEnd=pos+ins.length;
      onSheetInput();return;
    }
    return; // обычный Enter
  }

  // ── Apple Notes: автоактивация при вводе "1. " / "- " / "* " ──
  // Срабатывает на Space после маркера в начале строки
  if(e.key===' '){
    const trigger=lineText.match(/^(\d+[.)]|[-\*])$/);
    if(trigger){
      // Дать браузеру напечатать пробел, потом трансформируем
      setTimeout(()=>{
        const f2=document.getElementById('sh1');if(!f2)return;
        const v2=f2.value,p2=f2.selectionStart;
        const ls2=v2.lastIndexOf('\n',p2-1)+1;
        const lt2=v2.slice(ls2,p2);
        // "1. " → уже правильный формат, просто продолжаем
        // "-  " или "*  " → нормализуем в "• "
        if(lt2.match(/^[-\*]\s$/)){
          const b2=v2.slice(0,ls2);const a2=v2.slice(p2);
          f2.value=b2+'• '+a2;
          f2.selectionStart=f2.selectionEnd=ls2+2;
          onSheetInput();
        }
      },0);
    }
    return;
  }

  // ── Tab → два пробела ──
  if(e.key==='Tab'){
    e.preventDefault();
    f.value=val.slice(0,pos)+'  '+val.slice(pos);
    f.selectionStart=f.selectionEnd=pos+2;
  }
}

function onSheetInput(){
  const f=document.getElementById('sh1');if(!f)return;
  autoGrowTA(f);
  sheetUndoStack.push(f.value);
  sheetRedoStack=[];
  updUndoBtns();
  updCharCount(f);
  saveSheetDraft();
}

function onSheetPaste(e){
  const text=e.clipboardData?.getData('text');
  if(!text)return;
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  if(lines.length<2)return; // одна строка — вставляем как обычно
  const f=document.getElementById('sh1');if(!f)return;

  // Заметка уже непустая → вставляем как bullet-строки в текст
  if(f.value.trim()){
    e.preventDefault();
    const bullets=lines.map(l=>'• '+l.replace(/^[•\-\*]\s*/,'').replace(/^\d+[.)]\s*/,'')).join('\n');
    const pos=f.selectionStart;const val=f.value;
    f.value=val.slice(0,pos)+bullets+val.slice(f.selectionEnd);
    f.selectionStart=f.selectionEnd=pos+bullets.length;
    onSheetInput();return;
  }

  // Заметка пустая → переключаем в режим списка с галочками
  e.preventDefault();
  const clean=lines.map(l=>l.replace(/^[•\-\*]\s*/,'').replace(/^\d+[.)]\s*/,''));
  const overlay=document.getElementById('overlay');
  const body=document.getElementById('sheet-body');
  if(!overlay||!body)return;
  overlay.classList.add('list-mode');
  body.innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Каждый пункт с новой строки">${esc(clean.join('\n'))}</textarea>`;
  const ta=body.querySelector('#sh1');
  if(ta){
    ta.addEventListener('input',onSheetInput);
    ta.addEventListener('keydown',onSheetKeydown);
    ta.addEventListener('paste',onSheetPaste);
    ta.focus();
  }
  ST='list';
  showToast('Список с галочками готов ✓');
}

function closeSheet(){
  stopNoteSheetVoice();
  stopSheetVoice();
  stopSheetAudioNote();
  document.querySelector('.ai-transcript-block')?.remove();
  document.getElementById('overlay')?.classList.remove('list-mode');
  const dd=document.getElementById('cat-dropdown');
  if(dd)dd.classList.remove('open');
  const panel=document.getElementById('sheet-panel');
  if(panel){
    panel.classList.add('closing');
    setTimeout(()=>{
      document.getElementById('overlay').classList.remove('open');
      panel.classList.remove('closing');
    },220);
  } else {
    document.getElementById('overlay').classList.remove('open');
  }
  ST=null;EI=null;
}

function initSheetUndo(text){
  sheetUndoStack=[text];sheetRedoStack=[];updUndoBtns();
}
function refocusSheetInput(f){
  if(!f)return;
  try{f.focus({preventScroll:true});}catch(e){f.focus();}
}
function sheetUndo(){
  const f=document.getElementById('sh1');if(!f)return;
  if(sheetUndoStack.length>1){sheetRedoStack.push(sheetUndoStack.pop());f.value=sheetUndoStack[sheetUndoStack.length-1];updUndoBtns();updCharCount(f);}
  refocusSheetInput(f);
}
function sheetRedo(){
  const f=document.getElementById('sh1');if(!f)return;
  if(sheetRedoStack.length){const v=sheetRedoStack.pop();sheetUndoStack.push(v);f.value=v;updUndoBtns();updCharCount(f);}
  refocusSheetInput(f);
}
function updUndoBtns(){
  const u=document.getElementById('sheet-undo-btn');
  if(u){const off=sheetUndoStack.length<=1;u.classList.toggle('is-disabled',off);u.setAttribute('aria-disabled',off?'true':'false');}
  const r=document.getElementById('sheet-redo-btn');
  if(r){const off=!sheetRedoStack.length;r.classList.toggle('is-disabled',off);r.setAttribute('aria-disabled',off?'true':'false');}
}
function updCharCount(f){
  const el=document.getElementById('sheet-char-count');if(el)el.textContent=f.value.length+' символов';
}

const SHEET_HUES={здоровье:'25',покупки:'250',контакт:'150',событие:'80',идея:'290',рецепт:'60',адрес:'195',заметка:'150'};
const SHEET_CHROMAS={здоровье:'0.028',покупки:'0.022',контакт:'0.014',событие:'0.026',идея:'0.024',рецепт:'0.024',адрес:'0.020',заметка:'0.010'};

function acceptAiAction(idx){
  const cards=document.querySelectorAll('.ai-action-card');
  const card=cards[idx];if(!card)return;
  const text=card.querySelector('.ai-action-text')?.textContent?.trim()||'';
  const btns=card.querySelector('.ai-action-btns');
  if(btns)btns.innerHTML='<span class="ai-action-done"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>Отмечено</span>';
  card.classList.add('accepted');
  recordActionFeedback(text,true);
}
function rejectAiAction(idx){
  const cards=document.querySelectorAll('.ai-action-card');
  const card=cards[idx];if(!card)return;
  const text=card.querySelector('.ai-action-text')?.textContent?.trim()||'';
  card.style.maxHeight=card.scrollHeight+'px';
  requestAnimationFrame(()=>{
    card.style.maxHeight='0';card.style.opacity='0';
    card.style.paddingTop='0';card.style.paddingBottom='0';
  });
  recordActionFeedback(text,false);
}
function recordActionFeedback(actionText,accepted){
  const mem=getAiMemory();
  mem.push({id:'mem_'+Date.now(),note_id:EI||null,cluster:'feedback',summary:(accepted?'[принято] ':'[отклонено] ')+actionText.slice(0,150),importance:accepted?3:2,accepted,tags:[],created_at:new Date().toISOString()});
  if(mem.length>30)mem.shift();
  _saveAiMemoryRaw(mem);
}
function applyAiTagCat(tag){
  const cat=tagsToPrimaryLabel([tag]);
  document.querySelectorAll('.ai-tag').forEach(el=>{
    if(el.textContent.trim()===tag){
      el.classList.add('applied');
      el.style.transform='scale(.88)';
      setTimeout(()=>el.style.transform='',160);
    }
  });
  if(cat)pickAiCat(cat);
}
function pickAiCat(cat){
  showSheetCat(cat);
  document.querySelectorAll('.ai-cat-chip').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.cat===cat);
  });
}
function showSheetCat(label){
  const btn=document.getElementById('sheet-cat-btn');
  const dot=document.getElementById('sheet-cat-dot');
  const lbl=document.getElementById('sheet-cat-label');
  if(!btn)return;
  btn.style.display='inline-flex';
  const col=STRIPES[label||'заметка']||STRIPES.заметка;
  if(dot)dot.style.background=col;
  if(lbl)lbl.textContent=label||'заметка';
  btn.dataset.label=label||'заметка';
  // Тонируем фон заметки в цвет категории
  const sheet=document.querySelector('#overlay .sheet');
  if(sheet){
    const h=SHEET_HUES[label]||'150';
    const c=SHEET_CHROMAS[label]||'0.010';
    const chroma2=parseFloat(c)*2.5;
    sheet.style.background=`radial-gradient(ellipse 100% 45% at 50% 0%, oklch(0.84 ${chroma2.toFixed(3)} ${h} / 0.22), transparent 55%), radial-gradient(circle at 8% 8%, oklch(1 0 0 / 0.60) 0%, transparent 36%), oklch(0.974 ${c} ${h} / 0.96)`;
  }
}

function toggleCatDropdown(){
  const dd=document.getElementById('cat-dropdown');if(!dd)return;
  if(dd.classList.contains('open')){dd.classList.remove('open');return;}
  const cur=document.getElementById('sheet-cat-btn')?.dataset.label||'заметка';
  dd.innerHTML=Object.keys(STRIPES).map(l=>`
    <div class="cat-opt" onclick="selectCat('${l}')">
      <div class="cat-opt-dot" style="background:${STRIPES[l]};"></div>${l}
      ${l===cur?'<svg viewBox="0 0 24 24" width="12" height="12" stroke="var(--accent-d)" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':''}
    </div>`).join('');
  dd.classList.add('open');
  setTimeout(()=>document.addEventListener('click',closeCatOnClick,{once:true}),10);
}
function closeCatOnClick(e){
  const dd=document.getElementById('cat-dropdown');
  if(dd&&!dd.contains(e.target))dd.classList.remove('open');
}
function selectCat(label){
  showSheetCat(label);
  document.getElementById('cat-dropdown').classList.remove('open');
  saveSheetDraft();
}

function initSheetReminder(val){
  const row=document.getElementById('sheet-reminder-row');
  const inp=document.getElementById('sheet-reminder-in');
  const calBtn=document.getElementById('sheet-cal-btn');
  if(row)row.style.display=val?'flex':'none';
  if(inp)inp.value=val||'';
  if(calBtn)calBtn.style.display=val?'flex':'none';
}

function onReminderChange(){
  const inp=document.getElementById('sheet-reminder-in');
  const calBtn=document.getElementById('sheet-cal-btn');
  if(calBtn)calBtn.style.display=inp&&inp.value?'flex':'none';
}

function exportToCalendar(){
  const inp=document.getElementById('sheet-reminder-in');
  if(!inp||!inp.value){showToast('Сначала укажите дату напоминания');return;}

  // Собираем данные текущей заметки
  const f=document.getElementById('sh1');
  const rawText=f?f.value.trim():'';
  const words=rawText.split(/\s+/);
  const title=words.slice(0,8).join(' ')+(words.length>8?'…':'');
  const desc=rawText.slice(0,200).replace(/\n/g,' ');
  const noteId=EI||('rz-'+Date.now().toString(36));

  // Парсим дату из datetime-local (локальное время)
  const dt=new Date(inp.value);
  if(isNaN(dt.getTime())){showToast('Некорректная дата');return;}
  const dtEnd=new Date(dt.getTime()+60000); // +1 минута

  function icsDate(d){
    const pad=n=>String(n).padStart(2,'0');
    return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+'00Z';
  }
  function icsEscape(s){return(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');}

  const now=new Date();
  const ics=[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Разберёмся//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${noteId}@razberemsia`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(dt)}`,
    `DTEND:${icsDate(dtEnd)}`,
    `SUMMARY:${icsEscape(title||'Напоминание')}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Напоминание',
    'TRIGGER:PT0S',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const a=document.createElement('a');
  a.download=`razberemsia-${noteId}.ics`;
  if(isIOS){
    // iOS Safari не поддерживает download у blob — используем data URI
    a.href='data:text/calendar;charset=utf-8,'+encodeURIComponent(ics);
    document.body.appendChild(a);a.click();document.body.removeChild(a);
  }else{
    const blob=new Blob([ics],{type:'text/calendar;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    a.href=url;
    document.body.appendChild(a);a.click();
    setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},1000);
  }
  showToast('📅 Открой скачанный файл');
}

// Tap on overlay-bg to close (not on sheet itself)
document.getElementById('overlay-bg').addEventListener('click',()=>{
  if(document.documentElement.classList.contains('keyboard-open')){
    const f=document.getElementById('sh1');
    refocusSheetInput(f);
    return;
  }
  closeSheet();
});

function showCatHint(label){
  const wrap=document.getElementById('sheet-cat-wrap');if(!wrap)return;
  const old=document.getElementById('ai-cat-hint');if(old)old.remove();
  const hint=document.createElement('div');
  hint.id='ai-cat-hint';
  hint.style.cssText='font-size:11px;color:oklch(0.55 0.12 290);margin-top:4px;padding:0 2px;animation:splashFadeIn .2s ease;display:flex;align-items:center;gap:4px;';
  hint.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>✦ AI предложил: ${esc(catIcon(label))} ${esc(label)}`;
  wrap.appendChild(hint);
  setTimeout(()=>hint.remove(),5000);
}

function saveSheet(){
  if(ST==='list'){saveListSheet();return;}
  const f=document.getElementById('sh1');
  const v1=f?f.value:'';
  const catBtn=document.getElementById('sheet-cat-btn');
  const v3=safeLabel(catBtn?catBtn.dataset.label||'заметка':'заметка');
  const reminderEl=document.getElementById('sheet-reminder-in');
  const v2=reminderEl?reminderEl.value:'';
  if(!v1.trim()){showToast('Напишите текст');return;}
  const list=getNotes();
  const existingIdx=EI!==null?list.findIndex(n=>n.id===EI):-1;
  const prev=existingIdx>=0?list[existingIdx]:null;
  const aiPanel=document.getElementById('ai-panel');
  let aiTags=Array.isArray(prev?.aiTags)?prev.aiTags:[];
  let aiSummary=prev?.aiSummary||'';
  if(aiPanel?.dataset.aiTags){
    try{const parsed=JSON.parse(aiPanel.dataset.aiTags);if(Array.isArray(parsed))aiTags=parsed.filter(t=>typeof t==='string').slice(0,8);}catch(e){}
  }
  if(aiPanel?.dataset.aiSummary)aiSummary=aiPanel.dataset.aiSummary;
  const words=v1.trim().split(/\s+/);
  const title=words.slice(0,6).join(' ')+(words.length>6?'...':'');
  const ts=Date.now();
  const item={id:existingIdx>=0?EI:genId(),title,body:v1.trim(),label:v3,reminder:v2||null,updatedAt:ts,aiTags,aiSummary};
  if(existingIdx>=0){
    item.createdAt=list[existingIdx].createdAt||ts;
    // Save version history
    const oldSnap={...list[existingIdx]};
    const hist=getHistory();
    hist.unshift({hid:genId(),noteId:oldSnap.id,snapshot:oldSnap,savedAt:ts});
    if(hist.length>150)hist.pop();
    saveHistory(hist);
    list[existingIdx]=item;
  }
  else{item.createdAt=ts;list.push(item);}
  saveNotes(list);
  if(aiSummary)addToAiMemory(aiSummary,aiTags,item.id);
  clearSheetDraft();
  loadNotes();loadHomeFeed();loadNotepad();
  closeSheet();
  showToast(EI!==null?'Изменено ✓':'Сохранено ✓');
  if(v2) _handleReminderAfterSave(v2);
  // AI-ответ в чат — только для новых заметок (не редактирование)
  if(EI===null&&v1.trim().length>=15){
    _fetchChatReply(item.id, v1.trim());
  }
}

function editNote(i){openNoteSheet(i);}
function editNoteById(id){openNoteSheetById(id);}

// ── TRASH (мягкое удаление) ──
function delNoteById(id){
  const notes=getNotes();
  const i=notes.findIndex(n=>n.id===id);
  if(i>=0)delNote(i);
}
function delNote(i){
  const notes=getNotes();
  const deleted=notes.splice(i,1)[0];
  if(deleted){
    deleted._deletedAt=Date.now();
    const trash=getTrash();
    trash.unshift(deleted);
    // Держим корзину не более 50 записей
    if(trash.length>50)trash.pop();
    saveTrash(trash);
  }
  saveNotes(notes);
  loadNotes();loadHomeFeed();loadNotepad();
  showToast('В корзину · можно восстановить');
  updTrashBadge();
}

function loadTrash(){
  const trash=getTrash();
  const el=document.getElementById('trash-list');
  const cnt=document.getElementById('trash-count');
  const clearBtn=document.getElementById('trash-clear-btn');
  if(!el)return;
  if(cnt)cnt.textContent=trash.length?`${trash.length} ${trash.length===1?'заметка':trash.length<5?'заметки':'заметок'}` :'';
  if(clearBtn)clearBtn.style.display=trash.length?'block':'none';
  el.innerHTML='';
  if(!trash.length){
    el.innerHTML=`<div class="trash-empty"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>Корзина пуста</div>`;
    return;
  }
  trash.forEach((n,i)=>{
    const stripe=STRIPES[safeLabel(n.label||'заметка')]||STRIPES.заметка;
    const d=document.createElement('div');d.className='trash-item';
    const when=n._deletedAt?fmtMeta(n._deletedAt):'';
    d.innerHTML=`<div class="note-stripe" style="background:${stripe};opacity:0.5;"></div>
      <div class="note-cat"><span style="font-size:11px;margin-right:4px;">${catIcon(n.label)}</span>${esc(safeLabel(n.label||'заметка'))}</div>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div class="item-title" style="opacity:0.7;">${esc(n.title)}</div>
        <button class="trash-restore-btn" onclick="restoreNote(${i})">
          <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          Восстановить
        </button>
      </div>
      <div class="item-meta">Удалено ${esc(when)}</div>`;
    el.appendChild(d);
  });
  // История правок за последние 7 дней
  const hist=getHistory();
  const weekAgo=Date.now()-7*24*3600*1000;
  const recentHist=hist.filter(h=>h.savedAt>weekAgo);
  if(recentHist.length){
    const htitle=document.createElement('div');htitle.className='hist-section-title';htitle.textContent='История правок за неделю';
    el.appendChild(htitle);
    recentHist.forEach((h,hi)=>{
      const sn=h.snapshot||{};
      const stripe=STRIPES[safeLabel(sn.label||'заметка')]||STRIPES.заметка;
      const d=document.createElement('div');d.className='hist-item';
      const when=fmtMeta(h.savedAt);
      d.innerHTML=`<div class="note-stripe" style="background:${stripe};opacity:0.4;"></div>
        <div class="note-cat"><span style="font-size:11px;margin-right:4px;">${catIcon(sn.label)}</span>${esc(safeLabel(sn.label||'заметка'))}</div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="font-size:14px;color:var(--fg-m);opacity:.8;flex:1;">${esc(sn.title||'')} <span style="font-size:11px;color:var(--fg-l);">· была</span></div>
          <button class="hist-restore-btn" onclick="restoreHistory(${hi})">
            <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            Вернуть
          </button>
        </div>
        <div class="item-meta" style="font-size:10px;">Версия от ${esc(when)}</div>`;
      el.appendChild(d);
    });
  }
}

function restoreNote(i){
  const trash=getTrash();
  const n=trash.splice(i,1)[0];
  if(n){
    delete n._deletedAt;
    const notes=getNotes();
    notes.push(n);
    saveNotes(notes);
  }
  saveTrash(trash);
  loadTrash();loadNotes();loadHomeFeed();loadNotepad();
  showToast('Заметка восстановлена ✓');
  updTrashBadge();
}

function restoreHistory(hi){
  const hist=getHistory();
  const weekAgo=Date.now()-7*24*3600*1000;
  const recentHist=hist.filter(h=>h.savedAt>weekAgo);
  const h=recentHist[hi];if(!h)return;
  const sn=h.snapshot;if(!sn)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===sn.id);
  if(idx>=0){
    notes[idx]=sn;
    saveNotes(notes);
    showToast('Версия восстановлена ✓');
    loadTrash();loadNotes();loadHomeFeed();loadNotepad();
  } else {
    // Note was deleted — restore from history snapshot
    sn._restoredFromHistory=true;
    delete sn._deletedAt;
    notes.push(sn);
    saveNotes(notes);
    showToast('Заметка восстановлена из истории ✓');
    loadTrash();loadNotes();loadHomeFeed();loadNotepad();
  }
}

function clearTrash(){
  if(!confirm('Удалить всё из корзины навсегда?'))return;
  saveTrash([]);
  loadTrash();
  showToast('Корзина очищена');
  updTrashBadge();
}

function updTrashBadge(){
  const trash=getTrash();
  const btn=document.getElementById('trash-btn');
  if(!btn)return;
  if(trash.length){
    btn.style.opacity='1';
    btn.style.position='relative';
  } else {
    btn.style.opacity='0.55';
  }
}

// ── NOTE SHEET VOICE ──
let noteSheetRecog=null,noteSheetRec=false;
function toggleNoteSheetVoice(){noteSheetRec?stopNoteSheetVoice():startNoteSheetVoice();}
function startNoteSheetVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голос не поддерживается');return;}
  noteSheetRecog=new SR();noteSheetRecog.lang='ru-RU';noteSheetRecog.continuous=true;noteSheetRecog.interimResults=false;
  noteSheetRecog.onstart=()=>{noteSheetRec=true;const b=document.getElementById('snm-btn');if(b)b.classList.add('rec');};
  noteSheetRecog.onresult=e=>{
    let fin='';for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)fin+=e.results[i][0].transcript;
    if(fin){const f=document.getElementById('sh1');if(f){f.value+=(f.value?' ':'')+fin;onSheetInput();}}
  };
  noteSheetRecog.onerror=e=>{showToast('Ошибка: '+e.error);stopNoteSheetVoice();};
  noteSheetRecog.onend=()=>stopNoteSheetVoice();
  noteSheetRecog.start();
}
function stopNoteSheetVoice(){
  if(noteSheetRecog)try{noteSheetRecog.stop();}catch(e){}
  noteSheetRecog=null;noteSheetRec=false;
  const btn=document.getElementById('snm-btn');if(btn)btn.classList.remove('rec');
}

// ── NOTEPAD ──
let recog=null,isRec=false;

function loadNotepad(){
  const all=getNotes();
  const list=all.slice().reverse();
  const el=document.getElementById('notepad-list');if(!el)return;el.innerHTML='';
  if(!list.length){
    el.innerHTML='<div style="text-align:center;color:var(--fg-l);font-size:15px;padding:28px 0;">Записей пока нет<br><span style="font-size:13px;display:block;margin-top:5px;">Напишите или надиктуйте ниже</span></div>';return;
  }
  list.forEach((n,ri)=>{
    const i=all.length-1-ri;
    const stripe=STRIPES[safeLabel(n.label||'заметка')]||STRIPES.заметка;
    const wrap=document.createElement('div');wrap.style.cssText='position:relative;overflow:hidden;border-radius:16px;margin-bottom:8px;';
    const delBg=buildNoteSwipePanel('list', 16, ()=>n.id?delNoteById(n.id):delNote(i), ()=>shareNote(n));
    const d=document.createElement('div');d.className='pad-item';d.style.margin='0';
    d.innerHTML=`<div class="pad-stripe" style="background:${stripe};"></div>
      <div class="pad-cat">${esc(safeLabel(n.label||'заметка'))}</div>
      <div class="pad-title">${esc(n.title)}</div>
      <div class="pad-text">${esc(n.body||'')}</div>
      <div class="pad-meta">${esc(fmtMeta(n.updatedAt||n.createdAt))}</div>`;
    d.onclick=(e)=>{e.stopPropagation();n.id?openNoteSheetById(n.id):openNoteSheet(i);};
    attachSwipeDelete(d,delBg,null,116);
    const dBtn2=document.createElement('button');dBtn2.className='desk-del';
    dBtn2.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="oklch(0.45 0.15 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    dBtn2.onclick=(e)=>{e.stopPropagation();n.id?delNoteById(n.id):delNote(i);};
    wrap.setAttribute('data-nwrap','1');
    wrap.appendChild(delBg);wrap.appendChild(d);wrap.appendChild(dBtn2);el.appendChild(wrap);
  });
  // Тап на пустое место → новая заметка
  el.onclick=(e)=>{
    if(e.target.closest('.pad-item,.note-swipe-panel,.bubble-swipe-panel'))return;
    openSheet('note');
  };
}

function analyzeText(text){
  const t=text.toLowerCase();
  const rawTags=[];
  if(/таблетк|лекарств|врач|аптек|давлени|болит|больниц|анализ/.test(t))rawTags.push('здоровье');
  if(/купить|магазин|заказать|продукт|список/.test(t))rawTags.push('покупки');
  if(/позвонить|написать|связаться|перезвонить|мама|папа|семья|внук/.test(t))rawTags.push('позвонить');
  if(/встреча|собрание|поехать|праздник|запись/.test(t))rawTags.push('событие');
  if(/идея|думаю|мысль|план/.test(t))rawTags.push('идея');
  if(/рецепт|приготовить|варить/.test(t))rawTags.push('рецепт');
  if(/адрес|улица|дом №|маршрут/.test(t))rawTags.push('адрес');
  let label=tagsToPrimaryLabel(rawTags)||'заметка';
  let reminder=null;
  const now=new Date();
  const timeM=text.match(/в\s+(\d{1,2})[:\.](\d{2})/);
  const tomM=/завтра/i.test(text);
  if(timeM){
    const h=parseInt(timeM[1]),m=parseInt(timeM[2]);
    const dt=new Date(now);
    if(tomM)dt.setDate(dt.getDate()+1);
    dt.setHours(h,m,0,0);
    if(dt>now||tomM)reminder=dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate())+'T'+pad(h)+':'+pad(m);
  }
  const words=text.trim().split(/\s+/);
  const title=words.slice(0,6).join(' ')+(words.length>6?'...':'');
  return{title,label,reminder};
}

function saveNotepad(){
  const inp=document.getElementById('notepad-input');
  const text=inp.value.trim();if(!text){showToast('Напишите что-нибудь');return;}
  const{title,label,reminder}=analyzeText(text);
  const ts=Date.now();
  const notes=getNotes();
  notes.push({id:genId(),title,body:text,label,reminder,createdAt:ts,updatedAt:ts,fromPad:true});
  saveNotes(notes);
  inp.value='';inp.style.height='auto';
  loadNotepad();loadNotes();loadHomeFeed();
  showToast(reminder?`Сохранено · напомним ${fmtDt(reminder)}`:`Сохранено в «${label}» ✓`);
  if(reminder) _handleReminderAfterSave(reminder);
}

function npResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

function toggleVoice(){isRec?stopVoice():startVoice();}
function startVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голос не поддерживается');return;}
  recog=new SR();recog.lang='ru-RU';recog.continuous=true;recog.interimResults=true;
  recog.onstart=()=>{isRec=true;document.getElementById('mic-btn').classList.add('rec');document.getElementById('voice-status').style.display='block';};
  recog.onresult=e=>{
    let fin='';for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)fin+=e.results[i][0].transcript;
    if(fin){const inp=document.getElementById('notepad-input');inp.value+=(inp.value?' ':'')+fin;npResize(inp);}
  };
  recog.onerror=e=>{showToast('Ошибка: '+e.error);stopVoice();};
  recog.onend=()=>stopVoice();
  recog.start();
}
function stopVoice(){
  if(recog)try{recog.stop();}catch(e){}
  recog=null;isRec=false;
  document.getElementById('mic-btn').classList.remove('rec');
  document.getElementById('voice-status').style.display='none';
}

// ── HOME FEED ──
let homeRecog=null,homeIsRec=false;

function loadHomeFeed(){
  const notes=getNotes();
  const list=[...notes]; // oldest→newest = chat order, newest at bottom
  const el=document.getElementById('home-feed');if(!el)return;
  el.innerHTML='';
  // Тап на пустое место чата → новая заметка
  el.onclick=(e)=>{
    if(e.target.closest('.bubble,.bubble-swipe-panel,.bubble-wrap'))return;
    openSheet('note');
  };
  const badge=document.getElementById('notes-count-badge');
  if(badge)badge.textContent=notes.length?'('+notes.length+')':'';
  if(!list.length){
    return; // empty — just sky and clouds
  }
  list.forEach((n,i)=>{
    const realIdx=i;
    const displayNum=i+1;
    const wrap=document.createElement('div');wrap.className='bubble-wrap';
    const timeStr=fmtMeta(n.updatedAt||n.createdAt);
    const bId=n.id||('b'+i);

    if(n.type==='list'){
      wrap.innerHTML=`
        <div class="bubble" style="cursor:pointer;">
          <div id="list-inner-${esc(bId)}">${buildListInner(n)}</div>
          <div class="bubble-footer">
            <span class="bubble-num">#${displayNum}</span>
            <span class="bubble-cat">список</span>
            <span class="bubble-time">${esc(timeStr)}</span>
          </div>
        </div>`;
      const swipePanel=buildBubbleSwipePanel(()=>delHomeEntry(n.id,i),()=>{});
      wrap.prepend(swipePanel);
      const bbl=wrap.querySelector('.bubble');
      const bdel=wrap.querySelector('.bubble-swipe-panel');
      attachSwipeBubble(bbl,bdel,116);
      // Клик по пузырю — открыть список на редактирование
      bbl.addEventListener('click',()=>openListSheet(n.id));
      const dBtnL=document.createElement('button');dBtnL.className='desk-del';
      dBtnL.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="oklch(0.45 0.15 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      dBtnL.onclick=(e)=>{e.stopPropagation();delHomeEntry(n.id,i);};
      wrap.appendChild(dBtnL);
    } else {
      const catHtml=safeLabel(n.label||'заметка')!=='заметка'?`<span class="bubble-cat">${esc(safeLabel(n.label))}</span>`:'';
      const bodyText=n.body||n.title||'';
      const isLong=bodyText.length>90||(bodyText.match(/\n/g)||[]).length>1;
      const bodyPreview=n.body||bodyText||'';
      const expandBtn=isLong?`<button class="bubble-expand-btn" id="bxb-${esc(bId)}" onclick="event.stopPropagation();toggleBubble(${jsAttr(bId)},this)">ещё</button>`:'';
      wrap.innerHTML=`
        <div class="bubble" style="cursor:pointer;">
          <div class="bubble-text" id="bt-${bId}">${esc(bodyPreview)}</div>
          ${expandBtn}
          <div class="bubble-footer"><span class="bubble-num">#${displayNum}</span>${catHtml}<span class="bubble-time">${esc(timeStr)}</span></div>
        </div>`;
      const swipePanel=buildBubbleSwipePanel(()=>delHomeEntry(n.id,i),()=>shareNote(n));
      wrap.prepend(swipePanel);
      const bbl=wrap.querySelector('.bubble');
      const bdel=wrap.querySelector('.bubble-swipe-panel');
      bbl.onclick=(e)=>{
        if(_cardSwiping)return;
        if(e.target.closest('.bubble-expand-btn'))return;
        n.id?openNoteSheetById(n.id):openNoteSheet(realIdx);
      };
      attachSwipeBubble(bbl,bdel,116);
      const dBtnN=document.createElement('button');dBtnN.className='desk-del';
      dBtnN.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="oklch(0.45 0.15 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      dBtnN.onclick=(e)=>{e.stopPropagation();delHomeEntry(n.id,i);};
      wrap.appendChild(dBtnN);
    }
    el.appendChild(wrap);
    // AI-ответ под обычной заметкой
    if(n.type!=='list'){
      const replyEl=document.createElement('div');
      replyEl.id='ai-reply-'+bId;
      replyEl.className='ai-reply-wrap';
      if(n.aiReply){replyEl.innerHTML=_buildReplyHTML(n);}
      else{replyEl.style.display='none';}
      el.appendChild(replyEl);
    }
  });
  el.scrollTop=el.scrollHeight;
}

function delHomeEntry(id,legacyI){
  const notes=getNotes();
  const realIdx=id?notes.findIndex(n=>n.id===id):(notes.length-1-legacyI);
  if(realIdx>=0){
    const deleted=notes.splice(realIdx,1)[0];
    if(deleted){
      deleted._deletedAt=Date.now();
      const trash=getTrash();
      trash.unshift(deleted);
      if(trash.length>50)trash.pop();
      saveTrash(trash);
    }
    saveNotes(notes);
  }
  loadHomeFeed();loadNotes();loadNotepad();
  showToast('В корзину · можно восстановить');
  updTrashBadge();
}

// ── INPUT SHEET ──
let sheetRecog=null,sheetIsRec=false;

function openInputSheet(){
  syncViewportForKeyboard();
  document.getElementById('input-sheet-overlay').classList.add('open');
  document.getElementById('input-sheet-char-count').textContent='';
  setTimeout(()=>{
    const f=document.getElementById('home-input');
    if(f){f.value='';f.style.height='auto';f.focus();}
    const l=document.getElementById('home-input-label');if(l)l.value='';
    const r=document.getElementById('home-input-reminder');if(r)r.value='';
  },300);
}
function closeInputSheet(){
  stopSheetVoice();
  stopNoteSheetVoice();
  document.getElementById('input-sheet-overlay').classList.remove('open');
}

function saveHome(){
  const inp=document.getElementById('home-input');
  const text=inp.value.trim();if(!text){showToast('Напишите что-нибудь');return;}
  const auto=analyzeText(text);
  const labelEl=document.getElementById('home-input-label');
  const reminderEl=document.getElementById('home-input-reminder');
  const label=safeLabel((labelEl&&labelEl.value.trim())||auto.label);
  const reminder=(reminderEl&&reminderEl.value)||auto.reminder;
  const title=auto.title;
  const ts=Date.now();
  const notes=getNotes();
  notes.push({id:genId(),title,body:text,label,reminder:reminder||null,createdAt:ts,updatedAt:ts,fromPad:true});
  saveNotes(notes);
  closeInputSheet();
  loadHomeFeed();loadNotes();loadNotepad();
  showToast(reminder?'Записал · напомню '+fmtDt(reminder):'Записал ✓');
  if(reminder) _handleReminderAfterSave(reminder);
}

function toggleSheetVoice(){sheetIsRec?stopSheetVoice():startSheetVoice();}
function startSheetVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голос не поддерживается');return;}
  let collected='';
  sheetRecog=new SR();sheetRecog.lang='ru-RU';sheetRecog.continuous=true;sheetRecog.interimResults=false;
  sheetRecog.onstart=()=>{sheetIsRec=true;collected='';const btn=document.getElementById('input-sheet-mic-btn');if(btn)btn.classList.add('rec');};
  sheetRecog.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)collected+=(collected?' ':'')+e.results[i][0].transcript;
  };
  sheetRecog.onerror=e=>{if(e.error!=='no-speech')showToast('Ошибка: '+e.error);stopSheetVoice();};
  sheetRecog.onend=()=>{
    sheetIsRec=false;sheetRecog=null;
    const btn=document.getElementById('input-sheet-mic-btn');if(btn)btn.classList.remove('rec');
    if(collected.trim()){
      const vReminder=parseVoiceReminder(collected);
      const cleanText=vReminder?stripReminderCommand(collected.trim()):collected.trim();
      const inp=document.getElementById('home-input');
      if(inp){
        inp.value+=(inp.value?' ':'')+cleanText;
        document.getElementById('input-sheet-char-count').textContent=inp.value.length+' симв';
      }
      if(vReminder){
        const r=document.getElementById('home-input-reminder');
        if(r)r.value=vReminder;
        showToast('🔔 Напоминание: '+fmtDt(vReminder));
      }
    }
  };
  sheetRecog.start();
}
function stopSheetVoice(){
  if(sheetRecog)try{sheetRecog.stop();}catch(e){}
}

// ── AI AUDIO NOTE (inside note sheet) ──
let sheetAudioRecog=null;
let sheetAudioRec=false;

function toggleSheetAudioNote(){
  sheetAudioRec?stopSheetAudioNote():startSheetAudioNote();
}

function startSheetAudioNote(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голосовой ввод не поддерживается в этом браузере');return;}
  let collected='';
  sheetAudioRecog=new SR();
  sheetAudioRecog.lang='ru-RU';
  sheetAudioRecog.continuous=true;
  sheetAudioRecog.interimResults=false;
  sheetAudioRecog.onstart=()=>{
    sheetAudioRec=true;
    collected='';
    const btn=document.getElementById('sheet-voice-btn');
    const lbl=document.getElementById('sheet-voice-lbl');
    const wr=document.getElementById('sheet-wave-row');
    if(btn)btn.classList.add('rec');
    if(lbl)lbl.innerHTML='<span class="sheet-voice-dot"></span> Слушаю…';
    if(wr){wr.classList.add('show');buildSheetAudioWave(wr,18);}
  };
  sheetAudioRecog.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal)collected+=(collected?' ':'')+e.results[i][0].transcript;
    }
  };
  sheetAudioRecog.onerror=e=>{
    if(e.error!=='no-speech')showToast('Ошибка: '+e.error);
    stopSheetAudioNote();
  };
  sheetAudioRecog.onend=()=>{
    sheetAudioRec=false;
    sheetAudioRecog=null;
    const btn=document.getElementById('sheet-voice-btn');
    const lbl=document.getElementById('sheet-voice-lbl');
    const wr=document.getElementById('sheet-wave-row');
    if(btn)btn.classList.remove('rec');
    if(lbl)lbl.textContent='🎤 Голосовая заметка';
    if(wr)wr.classList.remove('show');
    if(!collected.trim())return;
    const vReminder=parseVoiceReminder(collected);
    const cleanText=vReminder?stripReminderCommand(collected.trim()):collected.trim();
    const ta=document.getElementById('sh1');
    if(ta){
      ta.value+=(ta.value?'\n':'')+cleanText;
      ta.dispatchEvent(new Event('input'));
      ta.scrollTop=ta.scrollHeight;
    }
    showAiTranscriptBlock(cleanText);
    if(vReminder){
      const row=document.getElementById('sheet-reminder-row');
      const inp=document.getElementById('sheet-reminder-in');
      const calBtn=document.getElementById('sheet-cal-btn');
      if(row)row.style.display='flex';
      if(inp)inp.value=vReminder;
      showToast('🔔 Напоминание: '+fmtDt(vReminder));
    } else {
      showToast('Голос записан ✓');
    }
    if(_aiOn){
      const p=document.getElementById('ai-panel');
      const t=document.getElementById('sh1')?.value||'';
      if(p&&p.style.display!=='none'&&t.length>14)runAiAnalysis(t,p);
    }
  };
  sheetAudioRecog.start();
}

function stopSheetAudioNote(){
  if(sheetAudioRecog)try{sheetAudioRecog.stop();}catch(e){}
}

function buildSheetAudioWave(container,n){
  container.innerHTML='';
  const hs=[30,55,80,48,70,90,40,65,85,50,75,35,62,88,44,70,55,38];
  for(let i=0;i<n;i++){
    const b=document.createElement('div');
    b.className='vwb';
    b.style.height=(hs[i%hs.length]*0.5)+'%';
    b.style.animationDelay=(i*0.05)+'s';
    b.style.animationDuration=(0.45+Math.random()*0.35)+'s';
    container.appendChild(b);
  }
}

function showAiTranscriptBlock(text){
  document.querySelector('.ai-transcript-block')?.remove();
  const sheetBody=document.getElementById('sheet-body');
  if(!sheetBody)return;
  const block=document.createElement('div');
  block.className='ai-transcript-block';
  block.innerHTML=`<div class="ai-transcript-label"><svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> ✦ Расшифровка AI</div>${esc(text)}`;
  sheetBody.parentNode.insertBefore(block,sheetBody);
}

// ── NEW NOTE BUTTON — hold logic ──
let _nnbHoldTimer=null, _nnbHolding=false, _nnbHandsfree=false, _nnbJustLocked=false;
let _nnbStartY=0,_nnbStopTap=false,_nnbManualStop=false;

function nnbPointerDown(e){
  // Если уже в хендсфри — этот тап останавливает
  if(_nnbHandsfree){
    _nnbStopTap=true;
    _nnbManualStop=true;
    stopHomeVoice();
    nnbStopHandsfree();
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='';lbl.classList.remove('rec');}
    return;
  }
  // Захватываем pointer — события продолжают идти даже если палец ушёл с кнопки
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){}
  _nnbStartY=e.clientY;
  _nnbHolding=false;
  _nnbJustLocked=false;
  _nnbHoldTimer=setTimeout(()=>{
    _nnbHolding=true;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.add('holding');
    startHomeVoice();
  },200);
}

function nnbPointerMove(e){
  if(!_nnbHolding||_nnbHandsfree)return;
  const dy=_nnbStartY-e.clientY;
  // Свайп вверх 30px = замок хендсфри
  if(dy>30){
    _nnbHandsfree=true;
    _nnbJustLocked=true;
    const btn=document.getElementById('new-note-btn');
    if(btn){btn.classList.remove('holding');btn.classList.add('handsfree');}
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='🔒 Хендсфри — говорите';lbl.classList.add('rec');}
  }
}

function nnbPointerUp(e){
  clearTimeout(_nnbHoldTimer);
  if(_nnbStopTap){
    _nnbStopTap=false;
    return;
  }
  if(_nnbHandsfree&&_nnbJustLocked){
    // Отпустили палец после свайпа вверх — хендсфри остаётся активным
    _nnbJustLocked=false;
    _nnbHolding=false;
    return;
  }
  if(_nnbHolding){
    // Держали — отпустили без свайпа — останавливаем
    _nnbHolding=false;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.remove('holding');
    _nnbManualStop=true;
    stopHomeVoice();
  } else if(!_nnbHandsfree){
    // Короткий тап — открываем заметку
    openSheet('note');
  }
}

function nnbPointerCancel(e){
  clearTimeout(_nnbHoldTimer);
  if(_nnbHolding&&!_nnbHandsfree){
    _nnbHolding=false;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.remove('holding');
    _nnbManualStop=true;
    stopHomeVoice();
  }
}

function nnbStopHandsfree(){
  _nnbHandsfree=false;_nnbHolding=false;_nnbJustLocked=false;
  const btn=document.getElementById('new-note-btn');
  if(btn){btn.classList.remove('holding');btn.classList.remove('handsfree');}
}

// ── HOME VOICE (used by new note button) ──
function toggleHomeVoice(){homeIsRec?stopHomeVoice():startHomeVoice();}
function startHomeVoice(){
  if(homeIsRec||homeRecog)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голос не поддерживается');return;}
  let collected='';
  _nnbManualStop=false;
  homeRecog=new SR();
  homeRecog.lang='ru-RU';homeRecog.continuous=true;homeRecog.interimResults=false;
  homeRecog.onstart=()=>{
    homeIsRec=true;collected='';
    const lbl=document.getElementById('home-voice-label');if(lbl){lbl.textContent='🎙 Говорите…';lbl.classList.add('rec');}
  };
  homeRecog.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal)collected+=(collected?' ':'')+e.results[i][0].transcript;
    }
  };
  homeRecog.onerror=e=>{
    if(e.error!=='no-speech')showToast('Ошибка: '+e.error);
    _nnbManualStop=true;
    stopHomeVoice();
  };
  homeRecog.onend=()=>{
    homeIsRec=false;homeRecog=null;
    const lbl=document.getElementById('home-voice-label');if(lbl){lbl.textContent='';lbl.classList.remove('rec');}
    const text=collected.trim();
    if(text){
      const voiceReminder=parseVoiceReminder(text);
      const cleanBody=voiceReminder?stripReminderCommand(text):text;
      const auto=analyzeText(cleanBody);
      const reminder=voiceReminder||auto.reminder||null;
      const ts=Date.now();
      const notes=getNotes();
      notes.push({id:genId(),title:auto.title,body:cleanBody,label:auto.label,reminder,createdAt:ts,updatedAt:ts,fromPad:true});
      saveNotes(notes);
      loadHomeFeed();loadNotes();loadNotepad();
      showToast(reminder?'Записал · напомню '+fmtDt(reminder):'Записал ✓');
      if(reminder) _handleReminderAfterSave(reminder);
    }
    if(_nnbHandsfree&&!_nnbManualStop){
      setTimeout(()=>{if(_nnbHandsfree&&!homeRecog)startHomeVoice();},260);
    }else{
      nnbStopHandsfree();
    }
  };
  homeRecog.start();
}
function stopHomeVoice(){
  if(homeRecog)try{homeRecog.stop();}catch(e){}
}


// ── LOAD ALL ──
function loadAll(){
  loadHomeFeed();
  loadNotes();
  loadNotepad();
  updTrashBadge();
  if('requestIdleCallback'in window){
    requestIdleCallback(()=>{scheduleAll();calRender();updCalTrigger();updateReminderDot();checkDueReminders();});
  } else {
    setTimeout(()=>{scheduleAll();calRender();updCalTrigger();updateReminderDot();checkDueReminders();},200);
  }
}

// ── SERVICE WORKER ──
window.addEventListener('load',()=>{
  if('serviceWorker'in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});

// ── INIT ──
initAuth();
