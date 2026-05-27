const SUPABASE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co';
const SUPABASE_ANON_KEY='sb_publishable_YtwehFnevo4R3UpmOnTTXQ_j4PQY21D';
const sbConfigured=/^https:\/\//.test(SUPABASE_URL)&&SUPABASE_ANON_KEY&&!SUPABASE_ANON_KEY.startsWith('PASTE_');
const sb=sbConfigured&&window.supabase?window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
  auth:{detectSessionInUrl:true,persistSession:true,autoRefreshToken:true,flowType:'pkce'}
}):null;

let CU=null,ST=null,EI=null;
let CLOUD_READY_UID=null,CLOUD_SAVE_TIMER=null,CLOUD_LOADING=false;
// Флаг: если Promise.race timeout выиграл раньше чем пришли облачные данные,
// loadCloudData не должна перезаписывать localStorage — пользователь уже работает.
let _cloudStale=false;
let _cardSwiping=false; // флаг: карточка перехватила свайп, подавить навигацию

function userScope(){return CU&&CU.id?CU.id:'signed-out';}
function scopedKey(key){return key.startsWith('rz_')?'rz_'+userScope()+'_'+key.slice(3):key;}
function readJson(key,fallback){try{const raw=localStorage.getItem(scopedKey(key));return raw?JSON.parse(raw):fallback;}catch(e){return fallback;}}
function writeJson(key,value){localStorage.setItem(scopedKey(key),JSON.stringify(value));queueCloudSave();}
function readText(key){return localStorage.getItem(scopedKey(key))||'';}
function writeText(key,value){localStorage.setItem(scopedKey(key),String(value||''));queueCloudSave();}
function migrateLegacyLocal(){['rz_notes','rz_trash','rz_history','rz_name'].forEach(key=>{const target=scopedKey(key);if(localStorage.getItem(target)!==null)return;const legacy=localStorage.getItem(key);if(legacy!==null)localStorage.setItem(target,legacy);});}
function getNotes(){
  const notes=readJson('rz_notes',[]);
  // Миграция: назначаем id заметкам без него (старые заметки)
  let dirty=false;
  notes.forEach(n=>{if(!n.id){n.id=genId();dirty=true;}});
  if(dirty)writeJson('rz_notes',notes);
  return notes;
}
function saveNotes(notes){writeJson('rz_notes',notes);}
function getTrash(){return readJson('rz_trash',[]);}
function saveTrash(trash){writeJson('rz_trash',trash);}
function getHistory(){return readJson('rz_history',[]);}
function saveHistory(hist){writeJson('rz_history',hist);}

// ── NOTES TABLE — конвертеры client ↔ Supabase ──
function _noteToRow(n,userId,deletedAt){
  return{
    id:n.id,user_id:userId,
    title:n.title||null,body:n.body||null,label:n.label||'заметка',
    reminder:n.reminder||null,recurring:n.recurring||null,
    ai_tags:Array.isArray(n.aiTags)&&n.aiTags.length?n.aiTags:null,
    ai_summary:n.aiSummary||null,ai_cache:n.aiCache||null,
    items:Array.isArray(n.items)&&n.items.length?n.items:null,
    from_pad:n.fromPad||false,
    created_at:n.createdAt?new Date(n.createdAt).toISOString():new Date().toISOString(),
    updated_at:n.updatedAt?new Date(n.updatedAt).toISOString():new Date().toISOString(),
    deleted_at:deletedAt||null
  };
}
function _rowToNote(r){
  return{
    id:r.id,title:r.title||'',body:r.body||'',label:r.label||'заметка',
    reminder:r.reminder||null,recurring:r.recurring||null,
    aiTags:Array.isArray(r.ai_tags)?r.ai_tags:[],
    aiSummary:r.ai_summary||'',aiCache:r.ai_cache||null,
    items:r.items||null,fromPad:r.from_pad||false,
    createdAt:r.created_at?new Date(r.created_at).getTime():Date.now(),
    updatedAt:r.updated_at?new Date(r.updated_at).getTime():Date.now(),
    ...(r.deleted_at?{_deletedAt:new Date(r.deleted_at).getTime()}:{})
  };
}

// Одноразовая миграция: перенос из user_state.notes в таблицу notes
async function _migrateNotesToTable(){
  if(!cloudAllowed())return;
  if(localStorage.getItem('rz_notes_migrated_v1'))return;
  const localNotes=getNotes();const localTrash=getTrash();
  const rows=[
    ...localNotes.map(n=>_noteToRow(n,CU.id,null)),
    ...localTrash.map(n=>_noteToRow(n,CU.id,n._deletedAt?new Date(n._deletedAt).toISOString():new Date().toISOString()))
  ];
  if(!rows.length){localStorage.setItem('rz_notes_migrated_v1','1');return;}
  const{error}=await sb.from('notes').upsert(rows,{onConflict:'id'});
  if(!error){
    localStorage.setItem('rz_notes_migrated_v1','1');
    console.log('✅ notes migrated:',rows.length);
  } else {
    console.warn('notes migration failed:',error.message);
  }
}

// Загрузить заметки из таблицы notes (вызывается при старте)
async function _syncFromNotesTable(){
  if(!cloudAllowed())return;
  try{
    const{data:rows,error}=await sb.from('notes').select('*').eq('user_id',CU.id).order('updated_at',{ascending:false}).limit(500);
    if(error){
      // Таблица ещё не создана — норм, используем user_state
      console.warn('notes table not ready:',error.message);return;
    }
    if(rows&&rows.length>0){
      // Таблица есть — она источник правды
      const active=rows.filter(r=>!r.deleted_at).map(_rowToNote);
      const trashed=rows.filter(r=>!!r.deleted_at).map(_rowToNote);
      localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(active));
      if(trashed.length)localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(trashed));
      if(!localStorage.getItem('rz_notes_migrated_v1'))localStorage.setItem('rz_notes_migrated_v1','1');
    } else {
      // Таблица пустая — запускаем одноразовую миграцию
      await _migrateNotesToTable();
    }
  }catch(e){console.warn('_syncFromNotesTable error:',e);}
}

// Синхронизировать текущие заметки в таблицу notes (fire-and-forget)
function _syncNotesToTable(){
  if(!cloudAllowed()||!localStorage.getItem('rz_notes_migrated_v1'))return;
  const rows=[
    ...getNotes().map(n=>_noteToRow(n,CU.id,null)),
    ...getTrash().map(n=>_noteToRow(n,CU.id,n._deletedAt?new Date(n._deletedAt).toISOString():new Date().toISOString()))
  ];
  if(!rows.length)return;
  sb.from('notes').upsert(rows,{onConflict:'id'}).then(({error})=>{
    if(error)console.warn('notes upsert failed:',error.message);
  });
}
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
function _mergeCloudFolders(cloudUserFolders,cloudTagFolders){
  // Правило: облако побеждает только если непустое.
  // Если облако вернуло [] (новые колонки с дефолтом) — НЕ перезаписываем локальные данные.
  if(Array.isArray(cloudUserFolders)){
    const local=getUserFolders();
    if(cloudUserFolders.length>0){
      localStorage.setItem(scopedKey('rz_user_folders'),JSON.stringify(cloudUserFolders));
    } else if(local.length>0){
      // Локальные есть, облако пустое — синхронизируем в облако
      queueCloudSave();
    }
  }
  if(Array.isArray(cloudTagFolders)){
    const localTags=typeof getTagFolders==='function'?getTagFolders():[];
    if(cloudTagFolders.length>0){
      localStorage.setItem('rz_tag_folders',JSON.stringify(cloudTagFolders));
    } else if(localTags.length>0){
      queueCloudSave();
    }
  }
  // Если после мёрджа разделы всё ещё пустые — восстанавливаем из тегов заметок
  const afterMerge=getUserFolders();
  if(!afterMerge.length){
    _recoverUserFoldersFromNotes();
  }
}
function _recoverUserFoldersFromNotes(){
  // Восстанавливает разделы пользователя из тегов _filed_in:ИМЯ в заметках
  const notes=getNotes();
  const seen=new Set();
  const recovered=[];
  notes.forEach(n=>{
    const filed=getFiledFolderName(n);
    if(filed&&!seen.has(filed)){
      seen.add(filed);
      const displayName=filed.charAt(0).toUpperCase()+filed.slice(1);
      recovered.push({name:displayName,createdAt:Date.now(),idx:recovered.length});
    }
  });
  if(recovered.length>0){
    localStorage.setItem(scopedKey('rz_user_folders'),JSON.stringify(recovered));
    console.info('[rz] Восстановлено разделов из заметок:',recovered.length);
    queueCloudSave();
  }
}
function isMissingFoldersColumns(error){
  const msg=String(error?.message||error?.details||error?.hint||error||'').toLowerCase();
  return (msg.includes('user_folders')||msg.includes('tag_folders'))&&(msg.includes('column')||msg.includes('schema cache')||msg.includes('does not exist')||msg.includes('could not find'));
}
async function loadCloudData(){
  if(!cloudAllowed()||CLOUD_READY_UID===CU.id)return;
  CLOUD_LOADING=true;
  try{
    let {data,error}=await sb.from('user_state').select('notes,trash,history,ai_memory,user_folders,tag_folders,name').eq('user_id',CU.id).maybeSingle();
    if(error&&(isMissingAiMemoryColumn(error)||isMissingFoldersColumns(error))){
      console.warn('new columns not ready yet, loading cloud state without them');
      const fallback=await sb.from('user_state').select('notes,trash,history,name').eq('user_id',CU.id).maybeSingle();
      data=fallback.data;error=fallback.error;
    }
    if(error)throw error;
    if(data){
      // Если timeout уже прошёл (_cloudStale), пользователь работает с локальными данными —
      // не перезаписываем localStorage: это может затереть только что созданные заметки.
      if(!_cloudStale){
        if(Array.isArray(data.notes))localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(data.notes));
        if(Array.isArray(data.trash))localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(data.trash));
        if(Array.isArray(data.history))localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
        if(Array.isArray(data.ai_memory))localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
        // Папки: облако побеждает только если там что-то есть.
        _mergeCloudFolders(data.user_folders,data.tag_folders);
        if(typeof data.name==='string')localStorage.setItem(scopedKey('rz_name'),data.name);
      }
    } else if(getNotes().length||getTrash().length||getHistory().length||getAiMemory().length||readText('rz_name')){
      await saveCloudNow();
    }
    // Синхронизация с таблицей notes (новый источник правды)
    await _syncFromNotesTable();
    CLOUD_READY_UID=CU.id;
  }catch(e){
    console.warn('cloud load failed (attempt 1)',e);
    CLOUD_LOADING=false;
    // Сеть при старте PWA может ещё не быть готова — ждём 3 сек и тихо пробуем снова
    setTimeout(async()=>{
      if(CLOUD_READY_UID===CU?.id)return; // уже загрузилось
      try{
        CLOUD_LOADING=true;
        let {data,error}=await sb.from('user_state').select('notes,trash,history,ai_memory,user_folders,tag_folders,name').eq('user_id',CU.id).maybeSingle();
        if(error&&(isMissingAiMemoryColumn(error)||isMissingFoldersColumns(error))){
          const fallback=await sb.from('user_state').select('notes,trash,history,name').eq('user_id',CU.id).maybeSingle();
          data=fallback.data;error=fallback.error;
        }
        if(error)throw error;
        if(data&&!_cloudStale){
          if(Array.isArray(data.notes))localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(data.notes));
          if(Array.isArray(data.trash))localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(data.trash));
          if(Array.isArray(data.history))localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
          if(Array.isArray(data.ai_memory))localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
          _mergeCloudFolders(data.user_folders,data.tag_folders);
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
    const payload={user_id:CU.id,notes:getNotes(),trash:getTrash(),history:getHistory(),ai_memory:getAiMemory(),user_folders:getUserFolders(),tag_folders:typeof getTagFolders==='function'?getTagFolders():[],name:readText('rz_name'),updated_at:new Date().toISOString()};
    let {error}=await sb.from('user_state').upsert(payload,{onConflict:'user_id'});
    if(error&&(isMissingAiMemoryColumn(error)||isMissingFoldersColumns(error))){
      console.warn('new columns not ready yet, saving cloud state without them');
      const {ai_memory,user_folders,tag_folders,...fallbackPayload}=payload;
      const fallback=await sb.from('user_state').upsert(fallbackPayload,{onConflict:'user_id'});
      error=fallback.error;
    }
    if(error)throw error;
    // Параллельная синхронизация в таблицу notes (fire-and-forget)
    _syncNotesToTable();
  }catch(e){console.warn('cloud save failed',e);showToast('Не удалось сохранить в облако');}
}
function setAuthChecking(checking){
  const card=document.querySelector('#auth-screen .auth-card');
  if(card)card.classList.toggle('checking',!!checking);
  const scr=document.getElementById('auth-screen');
  if(scr)scr.classList.toggle('checking',!!checking);
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
  CU=user;migrateLegacyLocal();_cloudStale=false;
  // Таймаут 7с: если облако не ответило — запускаем с локальными данными (не висим на логотипе)
  // После timeout флаг _cloudStale=true: loadCloudData не перезапишет localStorage пока пользователь работает
  await Promise.race([
    loadCloudData(),
    new Promise(r=>setTimeout(()=>{_cloudStale=true;r();},7000))
  ]);
  showApp();updUI(user);loadAll();
  _maybeOnboard();
  // Восстановить push-подписку при каждом логине (endpoint может смениться)
  if(notifGranted())_ensurePushSubscription();
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
    if(p==='granted'){scheduleAll();_ensurePushSubscription();}
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
  // Счётчик корзины в меню
  const trashS=document.getElementById('hmenu-trash-s');
  if(trashS){const tc=getTrash().length;trashS.textContent=tc?`${tc} удалённых заметок`:'Удалённые заметки';}
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
  btn.textContent='Отправляем…';

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
  if(id!=='notes')document.getElementById('main-app')?.classList.remove('agent-folder-shell');
  if(id==='home')loadHomeFeed();
  if(id==='notes'){renderNotifBanner();loadNotes();_pullCloudIfStale();}
  if(id==='notepad')loadNotepad();
  if(id==='trash')loadTrash();
}

// ── AI PANEL ──
const SUPABASE_EDGE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co/functions/v1/ai';
let _aiOn=false;

function _setSheetAiButtonState(state){
  const btn=document.getElementById('sheet-ai-btn');
  const label=btn?.querySelector('.sheet-ai-btn-label');
  if(!btn||!label)return;
  const text={
    idle:'Разобраться в заметке',
    loading:'Разбираюсь...',
    ready:'Разбор готов',
    retry:'Попробовать разобраться снова'
  };
  label.textContent=text[state]||text.idle;
  btn.classList.toggle('is-thinking',state==='loading');
}

function toggleAiPanel(){
  const btn=document.getElementById('sheet-ai-btn');
  const panel=document.getElementById('ai-panel');
  if(!btn||!panel)return;
  _aiOn=!_aiOn;
  btn.classList.toggle('ai-on',_aiOn);
  if(!_aiOn){panel.style.display='none';_setSheetAiButtonState('idle');return;}
  const f=document.getElementById('sh1');
  const text=(f?.value||'').trim();
  panel.style.display='block';
  panel.classList.remove('collapsed'); // всегда раскрывать при показе
  const bodyEl=document.getElementById('ai-panel-body');
  if(text.length<15){
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">Напишите немного больше — тогда AI сможет помочь.</div></div>`;
    _setSheetAiButtonState('retry');
    _scrollToAiPanel();
    return;
  }
  // ── Кэш: если заметка уже анализировалась и текст не менялся — показать без API ──
  if(EI){
    const list=getNotes();
    const idx=list.findIndex(n=>n.id===EI);
    const note=idx>=0?list[idx]:null;
    if(note?.aiCache&&note.aiCache.bodyKey===text.slice(0,80)){
      // Бэкфилл: сохраняем aiTags если их ещё нет (старые заметки)
      if(!Array.isArray(note.aiTags)||!note.aiTags.length){
        list[idx].aiTags=note.aiCache.tags||[];
        list[idx].aiSummary=note.aiCache.summary||'';
        saveNotes(list);
      }
      _renderAiResult(note.aiCache.summary,note.aiCache.tags,note.aiCache.actions,panel,text);
      _scrollToAiPanel();
      return;
    }
  }
  _setSheetAiButtonState('loading');
  runAiAnalysis(text,panel);
}
function rerunAiAnalysis(){
  // Сброс кэша → принудительный перезапуск
  if(EI){
    const list=getNotes();const idx=list.findIndex(n=>n.id===EI);
    if(idx>=0){list[idx].aiCache=null;saveNotes(list);}
  }
  _aiOn=false; // сбросить флаг чтобы toggleAiPanel перезапустил
  toggleAiPanel();
}

function toggleAiCollapse(){
  const panel=document.getElementById('ai-panel');
  if(!panel)return;
  const body=document.getElementById('ai-panel-body');
  const btn=document.getElementById('ai-collapse-btn');
  // Сбросить любые inline-стили от предыдущих итераций
  if(body){body.style.maxHeight='';body.style.overflow='';body.style.opacity='';}
  panel.style.overflow='';
  panel.classList.toggle('collapsed');
  if(btn)btn.style.transform=panel.classList.contains('collapsed')?'rotate(180deg)':'rotate(0deg)';
}

// ── ИСПРАВЛЕНИЕ ТЕКСТА ──
// _spellOriginal и _spellActive — var-глобалы из inline-скрипта index.html
// _spellStage: 0=original, 1=light, 2=medium, 3=full
async function toggleSpellFix(){
  const btn=document.getElementById('sheet-spell-btn');
  const f=document.getElementById('sh1');
  if(!f)return;
  // Stage 3 → восстановить оригинал
  if(typeof _spellStage!=='undefined'&&_spellStage>=3&&_spellOriginal!==null){
    f.value=_spellOriginal;
    autoGrowTA(f);onSheetInput();
    _spellOriginal=null;
    if(typeof _spellStage!=='undefined')_spellStage=0;
    _updateSpellBtn(btn);
    showToast('Текст восстановлен');
    return;
  }
  // Если нажимают снова при активном stage 1 или 2 → переход к следующему
  const curStage=(typeof _spellStage!=='undefined')?_spellStage:0;
  const nextStage=curStage+1;
  if(nextStage>3){
    // Восстановить
    if(_spellOriginal!==null){f.value=_spellOriginal;autoGrowTA(f);onSheetInput();}
    _spellOriginal=null;
    if(typeof _spellStage!=='undefined')_spellStage=0;
    _updateSpellBtn(btn);
    showToast('Текст восстановлен');
    return;
  }
  const text=_spellOriginal||f.value.trim();
  if(text.length<5){showToast('Напишите немного больше');return;}
  // Запомнить оригинал на первом вызове
  if(curStage===0)_spellOriginal=f.value;
  if(btn)btn.disabled=true;
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)throw new Error('no session');
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'rewrite',payload:{text,stage:nextStage}})
    });
    if(!res.ok){const e=await res.text();throw new Error(e||'Ошибка сервера');}
    const data=await res.json();
    const rewritten=data.rewritten||data.text||data.result;
    if(!rewritten)throw new Error('Пустой ответ AI');
    if(typeof _spellStage!=='undefined')_spellStage=nextStage;
    f.value=rewritten;
    autoGrowTA(f);onSheetInput();
    _updateSpellBtn(btn);
    const msgs=['','Ошибки исправлены · нажми ещё','Формулировка улучшена · нажми ещё','Полностью переписано · нажми чтобы вернуть'];
    showToast(msgs[nextStage]);
  }catch(e){
    if(btn)btn.disabled=false;
    showToast(String(e?.message||'Не удалось исправить текст'));
  }
}
function _updateSpellBtn(btn){
  if(!btn)return;
  btn.disabled=false;
  const dot=document.getElementById('spell-stage-dot');
  const stage=(typeof _spellStage!=='undefined')?_spellStage:0;
  btn.classList.remove('spell-s1','spell-s2','spell-s3','spell-active');
  if(stage===0){
    btn.title='Исправить орфографию и пунктуацию';
    if(dot)dot.style.display='none';
  }else{
    btn.classList.add('spell-s'+stage);
    const titles=['','Ошибки исправлены · нажми ещё','Улучшена формулировка · нажми ещё','Полностью переписано · нажми чтобы вернуть'];
    btn.title=titles[stage];
    if(dot){dot.textContent=stage;dot.style.display='inline';}
  }
}
function _scrollToAiPanel(){
  const sa=document.getElementById('sheet-scroll-area');
  if(!sa)return;
  // Instant jump — smooth scroll causes panel to appear stuck in middle of screen
  sa.scrollTop=sa.scrollHeight;
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
  _setSheetAiButtonState('loading');
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
    _renderAiResult(summary,tags,actions,panel,text);
    // ── Сохранить кэш анализа в заметку ──
    if(EI){
      const list=getNotes();
      const idx=list.findIndex(n=>n.id===EI);
      if(idx>=0){
        const filedTags=(list[idx].aiTags||[]).filter(_isFiledFolderTag);
        list[idx].aiCache={summary:summary||'',tags:tags||[],actions:actions||[],bodyKey:text.slice(0,80)};
        list[idx].aiTags=[...(tags||[]),...filedTags];
        list[idx].aiSummary=summary||'';
        saveNotes(list);
      }
    }
    // ── Авто-сохранение идей в репозиторий ──
    const isIdea=(tags||[]).some(t=>/^идеи?$|^ideas?$/i.test(t.trim()))
      || /^идея([^а-яёА-ЯЁa-zA-Z]|$)/i.test(text.trim());
    if(isIdea){
      const nid=document.getElementById('sheet-wrap')?.dataset.noteId||'';
      _saveIdeaToRepo({text,summary:summary||'',tags:tags||[],actions:actions||[],noteId:nid})
        .catch(e=>console.warn('save_idea failed',e));
    }
    _scrollToAiPanel();
  }catch(e){
    console.warn('AI error',e);
    const msg=String(e?.message||'').startsWith('Ошибка AI:')||String(e?.message||'').startsWith('AI ')||String(e?.message||'').startsWith('Войдите')||String(e?.message||'').startsWith('Не получилось')?String(e?.message):friendlyAiError(e?.message);
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">${esc(msg)}</div></div>`;
    _setSheetAiButtonState('retry');
    // editBtn removed
    _scrollToAiPanel();
  }
}

// ── RENDER AI RESULT (used both from runAiAnalysis and from cache) ──
function _renderAiResult(summary,tags,actions,panel,text){
  const bodyEl=document.getElementById('ai-panel-body');
  let html='<div class="ai-panel-inner">';
  if(summary){html+=`<div class="ai-section"><div class="ai-label">Суть</div><div class="ai-text">${esc(summary)}</div></div>`;}
  if(tags?.length){
    // Текущая открытая папка (если открыта из drill)
    const currentFolderTag=(drillAiTag||'').toLowerCase();
    const tagBtns=tags.map(t=>{
      const tl=t.toLowerCase();
      const exists=typeof tagFolderExists==='function'&&tagFolderExists(t);
      const isCurrent=currentFolderTag&&tl===currentFolderTag;
      const cls='ai-tag'+(isCurrent?' ai-tag--current':exists?' ai-tag--active':'');
      const title=isCurrent?'Текущая папка':exists?'Открыть папку':'Создать папку в Заметках';
      return `<button type="button" class="${cls}" data-tag="${esc(t)}" onclick="toggleTagFolder(${jsAttr(t)})" title="${title}">${esc(t)}</button>`;
    }).join('');
    html+=`<div class="ai-section"><div class="ai-label-row"><span class="ai-label">Теги</span><button type="button" class="ai-tag-add-btn" onclick="promptNewTag()">+ тег</button></div><div class="ai-tags">${tagBtns}</div></div>`;
  }
  if(actions?.length){
    // Простой toggle — CSS transition обрабатывает анимацию через .open класс
    html+=`<div class="ai-section ai-actions-section">
      <button type="button" class="ai-actions-toggle" onclick="this.closest('.ai-actions-section').classList.toggle('open')">
        <span class="ai-label">Разберёмся? <span class="ai-actions-hint">(${actions.length})</span></span>
        <svg class="ai-actions-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="ai-actions-body">
        <div class="ai-actions" style="margin-top:8px;">${actions.map((a,i)=>`<div class="ai-action-card"><div class="ai-action-text">${esc(a)}</div><div class="ai-action-btns"><button class="ai-accept-btn" onclick="acceptAiAction(${i})">✓ Сделаю</button><button class="ai-reject-btn" onclick="rejectAiAction(${i})">Не надо</button></div></div>`).join('')}</div>
      </div>
    </div>`;
  }
  const settings=getReminderSettings();
  const reminderAlreadySet=!!(document.getElementById('sheet-reminder-in')?.value);
  // bell hint removed — too aggressive
  html+='</div>';
  if(bodyEl){
    bodyEl.innerHTML=html;
    // Inline стили не нужны — CSS .ai-panel:not(.collapsed) управляет высотой
    bodyEl.style.maxHeight='';
    bodyEl.style.overflow='';
    requestAnimationFrame(()=>{ _scrollToAiPanel(); });
  }
  if(panel){
    panel.dataset.aiTags=JSON.stringify(Array.isArray(tags)?tags:[]);
    panel.dataset.aiSummary=summary||'';
  }
  _setSheetAiButtonState('ready');
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
      body:JSON.stringify({action:'chat_reply',payload:{text,mode:'note'}})
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
    // Обновить пузырь — если элемент ещё в DOM, обновить его;
    // если нет (пользователь переключил вкладку и назад) — пересобрать весь фид
    const bubbleEl=document.getElementById('ai-reply-'+noteId);
    if(bubbleEl){
      _renderReplyBubble(noteId);
    } else {
      loadHomeFeed();
    }
    showToast('✦ ИИ ответил');
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
  // Показываем только строку ввода + кнопку раскрыть (чтобы не путать пользователя)
  wrap.style.display='none'; // сообщения скрыты по умолчанию
  if(inputRow)inputRow.style.display='flex';
  wrap.innerHTML=msgs.map(m=>{
    const isAi=m.role==='ai';
    return `<div class="nc-msg nc-msg-${isAi?'ai':'user'}">
      ${isAi?'<div class="nc-icon">✦</div>':''}
      <div class="nc-text">${esc(m.text)}</div>
    </div>`;
  }).join('');
  // Показываем подсказку в поле ввода что есть ответ
  const inp=document.getElementById('note-chat-in');
  if(inp&&msgs.some(m=>m.role==='ai'))inp.placeholder='Есть ответ ✦ — открыть…';
}
function toggleNoteChat(){
  const wrap=document.getElementById('note-chat');
  if(!wrap)return;
  const isHidden=wrap.style.display==='none'||wrap.style.display==='';
  wrap.style.display=isHidden?'block':'none';
  if(isHidden){
    const inp=document.getElementById('note-chat-in');
    if(inp)inp.placeholder='Продолжить разговор…';
    requestAnimationFrame(()=>{
      const sa=document.getElementById('sheet-scroll-area');
      if(sa)sa.scrollTop=sa.scrollHeight;
    });
  }
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
    // Передаём историю диалога как массив (Edge Function строит multi-turn messages)
    // n.aiChat уже содержит текущее сообщение пользователя — передаём всё кроме него
    const history=n.aiChat.slice(0,-1).slice(-12);
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'chat_reply',payload:{text,history,mode:'chat'}})
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
          // Прокрутить вниз после ответа AI
          requestAnimationFrame(()=>{
            const sa=document.getElementById('sheet-scroll-area');
            if(sa)sa.scrollTop=sa.scrollHeight;
          });
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
    if(dx>90&&sx<44&&cur!=='home'){
      // Если drill-свайп уже сработал внутри #s-notes — не дублируем переход на home
      if(cur==='notes'&&_drillHandledSwipe){_drillHandledSwipe=false;return;}
      go('home');
    }
    if(dx<-90&&sx<44&&cur==='home'){go('notes');return;}
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
  const t=document.getElementById('toast');t.classList.remove('action');t.textContent=msg;t.classList.add('show');
  clearTimeout(_toastT);_toastT=setTimeout(()=>t.classList.remove('show'),2600);
}
function showActionToast(msg,label,action){
  const t=document.getElementById('toast');if(!t)return;
  t.textContent='';t.classList.add('action','show');
  const copy=document.createElement('span');copy.textContent=msg;
  const btn=document.createElement('button');btn.type='button';btn.className='toast-action-btn';btn.textContent=label;
  btn.onclick=()=>{t.classList.remove('show','action');action();};
  t.append(copy,btn);
  clearTimeout(_toastT);_toastT=setTimeout(()=>t.classList.remove('show','action'),5600);
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
      // Не дублируем если advance-баннер уже показал checkDueReminders
      const key=n.id+'_'+n.reminder;
      if(!_shownReminders[key])showInAppReminder(n);
      updateReminderDot();
    },delay);
    _NT.push(tid);
  });

  updateReminderDot();
}

// Пересылаем в SW при каждом возвращении в приложение
let _lastPullAt=0;
async function _pullCloudIfStale(){
  if(!cloudAllowed()||!CU)return;
  const age=Date.now()-_lastPullAt;
  if(age<12000)return; // не чаще раза в 12 секунд
  _lastPullAt=Date.now();
  try{
    const {data}=await sb.from('user_state')
      .select('notes,trash,user_folders,tag_folders')
      .eq('user_id',CU.id).maybeSingle();
    if(!data)return;
    let changed=false;
    if(Array.isArray(data.notes)){
      const localJson=localStorage.getItem(scopedKey('rz_notes'));
      const cloudJson=JSON.stringify(data.notes);
      if(localJson!==cloudJson){localStorage.setItem(scopedKey('rz_notes'),cloudJson);changed=true;}
    }
    if(Array.isArray(data.trash)){
      localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(data.trash));
    }
    _mergeCloudFolders(data.user_folders,data.tag_folders);
    if(changed)loadAll();
    else if(document.getElementById('drill-p0')?.offsetParent!==null)_drillP0(); // обновить разделы
  }catch(_){}
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(notifGranted())scheduleAll();
    _pullCloudIfStale();
  }
});

// ── Умная обработка напоминания после сохранения заметки ──
function _handleReminderAfterSave(reminderVal,noteId,noteTitle,noteBody){
  // Сохраняем на сервер всегда (VAPID cron будет стрелять независимо от SW)
  if(noteId&&reminderVal)_saveReminderToServer(noteId,noteTitle||'',noteBody||'',reminderVal);
  if(notifGranted()){
    scheduleAll();
    _ensurePushSubscription(); // гарантируем подписку
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
    if(p==='granted'){scheduleAll();_ensurePushSubscription();}
  });
}

// ── VAPID WEB PUSH ────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY='BOZyP-dj5nQQogwdMgUtSWwWcEa6yAuNm2dCwVbhSFfHq7xvVcyoUNQA226AT0OlrOVqX3MOERBsZsnjllKqjKo';

function _vapidB64toUint8(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=window.atob(base64);
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}

async function _getPushSubscription(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window))return null;
  try{
    const reg=await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  }catch(e){return null;}
}

async function _subscribePush(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window))return null;
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:_vapidB64toUint8(VAPID_PUBLIC_KEY)
    });
    // Сохраняем на сервер
    await _syncPushSubToServer(sub);
    return sub;
  }catch(e){
    console.warn('push subscribe failed',e);
    return null;
  }
}

async function _syncPushSubToServer(sub){
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token||!sub)return;
    const k=sub.getKey('p256dh');
    const a=sub.getKey('auth');
    if(!k||!a)return;
    const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'push_subscribe',payload:{
        endpoint:sub.endpoint,
        p256dh:b64u(k),
        auth:b64u(a),
        userAgent:navigator.userAgent.slice(0,200)
      }})
    });
  }catch(e){console.warn('sync push sub failed',e);}
}

// Вызывается после выдачи разрешения на уведомления
async function _ensurePushSubscription(){
  if(!notifGranted())return;
  let sub=await _getPushSubscription();
  if(!sub)sub=await _subscribePush();
  else await _syncPushSubToServer(sub); // обновить на случай если endpoint изменился
}

// Сохранить напоминание на сервер (чтоб cron мог отправить push)
async function _saveReminderToServer(noteId,noteTitle,noteBody,remindAt){
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)return;
    // Конвертируем в UTC ISO — браузер парсит как локальное время, сервер должен получить UTC
    const dt=new Date(remindAt);
    if(isNaN(dt.getTime()))return;
    // Не сохранять на сервер прошедшие напоминания — они будут слаться снова и снова
    if(dt.getTime()<Date.now())return;
    const remindAtUtc=dt.toISOString();
    await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'save_reminder',payload:{noteId,noteTitle,noteBody,remindAt:remindAtUtc}})
    });
  }catch(e){console.warn('save reminder to server failed',e);}
}

async function _deleteReminderFromServer(noteId){
  try{
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)return;
    await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'delete_reminder',payload:{noteId}})
    });
  }catch(e){}
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
// Persisted in sessionStorage: survives page refresh, resets when tab is closed
let _shownReminders=(()=>{try{return JSON.parse(sessionStorage.getItem('rz_shown_rem')||'{}');}catch(e){return{};}})();
function _persistShownRem(){try{sessionStorage.setItem('rz_shown_rem',JSON.stringify(_shownReminders));}catch(e){}}

function _tsToIso(ts){
  const d=new Date(ts);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}

function _nextRecurringTime(times){
  const now=new Date();
  // Сегодня — ближайшее время в будущем
  const todayFuture=times.map(t=>{
    const [h,m]=(t||'').split(':').map(Number);
    const d=new Date(now);d.setHours(h,m||0,0,0);return d;
  }).filter(d=>d.getTime()>now.getTime()).sort((a,b)=>a-b);
  if(todayFuture.length)return todayFuture[0].getTime();
  // Завтра — первое время из списка
  const sorted=[...times].sort();
  const [h,m]=(sorted[0]||'09:00').split(':').map(Number);
  const tomorrow=new Date(now);
  tomorrow.setDate(tomorrow.getDate()+1);
  tomorrow.setHours(h,m||0,0,0);
  return tomorrow.getTime();
}

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
      _persistShownRem();
      showInAppReminder(n);
    }
    // Авто-перепланировка повторяющихся напоминаний
    if(diff<0&&n.recurring?.times?.length){
      const next=_nextRecurringTime(n.recurring.times);
      const nextIso=_tsToIso(next);
      if(nextIso!==n.reminder){
        const list=getNotes();
        const idx=list.findIndex(x=>x.id===n.id);
        if(idx>=0){
          list[idx].reminder=nextIso;list[idx].updatedAt=Date.now();saveNotes(list);
          // Регистрируем новое время на сервере чтоб VAPID-пуш сработал при закрытом приложении
          _saveReminderToServer(n.id,n.title||'',n.body||'',nextIso);
          scheduleAll();
        }
      }
    }
    // Clean shown cache for reminders more than 1h past
    if(diff<-3600000&&!n.recurring){delete _shownReminders[key];_persistShownRem();}
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
function _remindWhenTxt(dt,now){
  const ms=dt.getTime()-now;
  const abs=Math.abs(ms);
  const d=new Date(dt);
  const today=new Date();today.setHours(0,0,0,0);
  const tom=new Date(today);tom.setDate(tom.getDate()+1);
  const days=['вс','пн','вт','ср','чт','пт','сб'];
  const hm=pad(d.getHours())+':'+pad(d.getMinutes());
  if(ms<0){
    // просрочено
    if(abs<3600000)return'Только что';
    if(abs<86400000)return'Сегодня в '+hm+' — просрочено';
    return _fmtDayTime(d)+' — просрочено';
  }
  const dayStart=new Date(d);dayStart.setHours(0,0,0,0);
  if(dayStart.getTime()===today.getTime())return'Сегодня в '+hm;
  if(dayStart.getTime()===tom.getTime())return'Завтра в '+hm;
  const diffDays=Math.round((dayStart-today)/86400000);
  if(diffDays<7)return days[d.getDay()]+' в '+hm;
  return _fmtDayTime(d);
}
function _fmtDayTime(d){
  const months=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  return d.getDate()+' '+months[d.getMonth()]+' в '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function renderReminderPanel(){
  const scroll=document.getElementById('remind-scroll');if(!scroll)return;
  const notes=getNotes();
  const now=Date.now();
  const upcoming=notes.filter(n=>{
    if(!n.reminder)return false;
    const dt=parseDt(n.reminder);if(!dt)return false;
    return dt.getTime()>now-86400000*3; // просроченные до 3 суток тоже показываем
  }).sort((a,b)=>{
    const da=parseDt(a.reminder),db=parseDt(b.reminder);
    return(da?da.getTime():Infinity)-(db?db.getTime():Infinity);
  });
  const settings=getReminderSettings();
  let html='';
  if(upcoming.length){
    upcoming.forEach(n=>{
      const dt=parseDt(n.reminder);
      const isPast=dt&&dt.getTime()<now;
      const isSoon=dt&&!isPast&&(dt.getTime()-now)<3*3600000;
      const dotCls=isPast?'overdue':isSoon?'soon':'future';
      const timeCls=isPast?'overdue':isSoon?'soon':'';
      const whenTxt=dt?_remindWhenTxt(dt,now):fmtDt(n.reminder);
      const cardCls=isPast?'remind-item overdue-card':'remind-item';
      const title=n.title||(n.body||'').split('\n')[0].slice(0,60)||'Заметка';
      const preview=(n.body||'').split('\n').slice(1).join(' ').trim().slice(0,120);
      const recurLine=n.recurring?.times?.length
        ?`<div class="remind-item-recurring">🔁 ${esc(n.recurring.times.join(' · '))}</div>`:'';
      html+=`<div class="${cardCls}" onclick="closeReminderPanel();setTimeout(()=>openNoteSheetById(${jsAttr(n.id)}),260)">
        <div class="remind-item-top">
          <div class="remind-item-dot ${dotCls}"></div>
          <div class="remind-item-time ${timeCls}">${esc(whenTxt)}</div>
        </div>
        <div class="remind-item-title">${esc(title)}</div>
        ${preview?`<div class="remind-item-preview">${esc(preview)}</div>`:''}
        ${recurLine}
        <div class="remind-item-actions">
          <button class="remind-done-btn" onclick="event.stopPropagation();doneReminder(${jsAttr(n.id)})">
            <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            Выполнено
          </button>
          <button class="remind-open-btn" onclick="event.stopPropagation();openRemEditForNote(${jsAttr(n.id)})">
            Изменить
          </button>
          <button class="remind-del-btn" onclick="event.stopPropagation();removeNoteReminder(${jsAttr(n.id)})" title="Удалить напоминание">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
    });
  } else {
    html+=`<div class="remind-empty"><div class="remind-empty-ico">🔔</div><div class="remind-empty-txt">Нет активных напоминаний</div></div>`;
  }
  html+='<div class="remind-section-label">Настройки</div>';
  html+=`<div class="remind-settings">
    <div class="remind-set-row">
      <span class="remind-set-lbl">Напомнить заранее</span>
      <button class="remind-set-val" id="remind-adv-btn" onclick="cycleAdvance()">${advanceLabel(settings.advanceMinutes)}</button>
    </div>
  </div>`;
  scroll.innerHTML=html;
}

function doneReminder(noteId){
  // Убираем напоминание (выполнено) — с анимацией исчезновения карточки
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  const hadReminder=!!n.reminder;
  n.reminder=null;
  if(n.recurring)n.recurring=null;
  n.updatedAt=Date.now();
  saveNotes(notes);
  if(hadReminder)_deleteReminderFromServer(noteId);
  scheduleAll();
  showToast('Выполнено ✓');
  renderReminderPanel();
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

// ── REMINDER EDITOR MODAL ──
let _remEditNoteId=null;

function openRemEditForNote(noteId){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  _remEditNoteId=noteId;
  // Сбрасываем календарь при открытии новой заметки
  _remCal=null;
  const _cw=document.getElementById('rem-cal-wrap');
  if(_cw){_cw.classList.remove('open');_cw.innerHTML='';}
  const _cr=document.getElementById('rem-edit-custom-row');
  if(_cr)_cr.classList.remove('expanded');
  const isRec=!!(n.recurring?.times?.length);
  // Заголовок
  const nameEl=document.getElementById('rem-edit-note-name');
  if(nameEl)nameEl.textContent=n.title||(n.body||'').split('\n')[0].slice(0,60)||'Заметка';
  const typeLbl=document.getElementById('rem-edit-type-lbl');
  if(typeLbl)typeLbl.textContent=isRec?'🔁 Повторяющееся напоминание':'🔔 Время напоминания';
  // Показываем нужный блок
  const simpleBlock=document.getElementById('rem-edit-simple-block');
  const recBlock=document.getElementById('rem-edit-rec-block');
  if(simpleBlock)simpleBlock.style.display=isRec?'none':'block';
  if(recBlock)recBlock.style.display=isRec?'block':'none';
  // Сбрасываем активные чипы
  document.querySelectorAll('.rem-edit-q').forEach(b=>b.classList.remove('active'));
  if(isRec){
    _renderRemEditRecChips(n);
  } else {
    // Показываем текущее время
    const dtLbl=document.getElementById('rem-edit-dt-lbl');
    if(dtLbl)dtLbl.textContent=n.reminder?fmtDt(n.reminder):'Выбрать дату и время';
  }
  // Открываем
  const ov=document.getElementById('rem-edit-ov');
  if(ov){
    ov.style.display='flex';
    requestAnimationFrame(()=>{
      const sheet=document.getElementById('rem-edit-sheet');
      if(sheet)sheet.style.transform='translateY(0)';
    });
  }
}

function closeRemEdit(){
  const sheet=document.getElementById('rem-edit-sheet');
  if(sheet)sheet.style.transform='translateY(100%)';
  // Сбрасываем календарь немедленно
  _remCal=null;
  const wrap=document.getElementById('rem-cal-wrap');
  if(wrap){wrap.classList.remove('open');wrap.innerHTML='';}
  const row=document.getElementById('rem-edit-custom-row');
  if(row)row.classList.remove('expanded');
  setTimeout(()=>{
    const ov=document.getElementById('rem-edit-ov');
    if(ov)ov.style.display='none';
    _remEditNoteId=null;
  },320);
}

function remEditOpenNote(){
  // Тап на название — открывает заметку
  const id=_remEditNoteId;
  closeRemEdit();
  setTimeout(()=>{ if(id)openNoteSheetById(id); },350);
}

function _remEditSave(isoVal){
  if(!_remEditNoteId)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===_remEditNoteId);
  if(idx<0)return;
  const dt=new Date(isoVal);
  if(isNaN(dt.getTime()))return;
  if(dt.getTime()<Date.now()){showToast('Время уже прошло — выбери будущее');return;}
  notes[idx].reminder=isoVal;
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);
  scheduleAll();
  renderReminderPanel();
  const dtLbl=document.getElementById('rem-edit-dt-lbl');
  if(dtLbl)dtLbl.textContent=fmtDt(isoVal);
  showToast('🔔 Напомним '+fmtDt(isoVal));
}

function remEditQuick(minutes,btn){
  if(!_remEditNoteId)return;
  const dt=new Date(Date.now()+minutes*60000);
  _remEditSave(_rmpLocalStr(dt));
  document.querySelectorAll('.rem-edit-q').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}

function remEditTomorrow(h,m,btn){
  if(!_remEditNoteId)return;
  const d=new Date();d.setDate(d.getDate()+1);d.setHours(h,m,0,0);
  _remEditSave(_rmpLocalStr(d));
  document.querySelectorAll('.rem-edit-q').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}

// ── КАСТОМНЫЙ КАЛЕНДАРЬ (замена datetime-local) ──
let _remCal=null; // {year,month,day,hour,min}

function _remCalToggle(){
  const wrap=document.getElementById('rem-cal-wrap');
  const row=document.getElementById('rem-edit-custom-row');
  if(!wrap)return;
  if(wrap.classList.contains('open')){
    // Закрыть
    wrap.classList.remove('open');
    if(row)row.classList.remove('expanded');
    _remCal=null;
    return;
  }
  // Инициализировать состояние
  const notes=getNotes();
  const n=_remEditNoteId?notes.find(x=>x.id===_remEditNoteId):null;
  const now=new Date();
  let base=new Date(now.getTime()+60*60000); // дефолт: +1 час
  base.setSeconds(0,0);
  const rm=Math.round(base.getMinutes()/5)*5;
  if(rm>=60){base.setHours(base.getHours()+1);base.setMinutes(0);}else base.setMinutes(rm);
  if(n?.reminder){const d=parseDt(n.reminder);if(d&&!isNaN(d.getTime())&&d.getTime()>now.getTime())base=d;}
  _remCal={year:base.getFullYear(),month:base.getMonth(),day:base.getDate(),hour:base.getHours(),min:base.getMinutes()};
  _renderRemCal();
  wrap.classList.add('open');
  if(row)row.classList.add('expanded');
  // Скролл вниз чтобы показать календарь
  setTimeout(()=>{const s=document.getElementById('rem-edit-sheet');if(s)s.scrollTo({top:s.scrollHeight,behavior:'smooth'});},200);
}

function _renderRemCal(){
  const wrap=document.getElementById('rem-cal-wrap');
  if(!wrap||!_remCal)return;
  const {year,month,day,hour,min}=_remCal;
  const now=new Date();
  const MONTHS=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const MS=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  const DHDR=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const firstDay=new Date(year,month,1).getDay();
  const startOff=(firstDay+6)%7;
  const dInMonth=new Date(year,month+1,0).getDate();
  const dInPrev=new Date(year,month,0).getDate();
  let cells='';
  for(let i=startOff-1;i>=0;i--)cells+=`<div class="rcal-day other">${dInPrev-i}</div>`;
  for(let d=1;d<=dInMonth;d++){
    const isToday=year===now.getFullYear()&&month===now.getMonth()&&d===now.getDate();
    const isSel=d===day;
    const isPast=new Date(year,month,d,23,59).getTime()<now.getTime()&&!isToday;
    const wd=new Date(year,month,d).getDay();
    const isWknd=wd===0||wd===6;
    let cls='rcal-day'+(isPast?' past':'')+(isToday?' today':'')+(isSel?' sel':'')+(isWknd&&!isSel?' wknd':'');
    const click=isPast?'':`onclick="_remCalPick(${year},${month},${d})"`;
    cells+=`<div class="${cls}" ${click}>${d}</div>`;
  }
  const total=startOff+dInMonth;
  const rem=total%7?7-total%7:0;
  for(let d=1;d<=rem;d++)cells+=`<div class="rcal-day other">${d}</div>`;
  const hS=String(hour).padStart(2,'0'),mS=String(min).padStart(2,'0');
  const minusSvg=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const plusSvg=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  wrap.innerHTML=`<div class="rcal">
    <div class="rcal-hdr">
      <button class="rcal-nav" onclick="_remCalPrevMonth()">${`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`}</button>
      <div class="rcal-month">${MONTHS[month]} ${year}</div>
      <button class="rcal-nav" onclick="_remCalNextMonth()">${`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`}</button>
    </div>
    <div class="rcal-dhdr">${DHDR.map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="rcal-grid">${cells}</div>
    <div class="rcal-time">
      <div class="rcal-tpart">
        <button class="rcal-tb" onclick="_remCalH(-1)">${minusSvg}</button>
        <div class="rcal-tv">${hS}</div>
        <button class="rcal-tb" onclick="_remCalH(1)">${plusSvg}</button>
      </div>
      <div class="rcal-tsep">:</div>
      <div class="rcal-tpart">
        <button class="rcal-tb" onclick="_remCalM(-1)">${minusSvg}</button>
        <div class="rcal-tv">${mS}</div>
        <button class="rcal-tb" onclick="_remCalM(1)">${plusSvg}</button>
      </div>
    </div>
    <button class="rcal-save" onclick="_remCalSave()">Напомнить ${hS}:${mS} · ${day} ${MS[month]}</button>
  </div>`;
}

function _remCalPick(y,m,d){
  if(!_remCal)return;
  _remCal.year=y;_remCal.month=m;_remCal.day=d;_renderRemCal();
}
function _remCalPrevMonth(){
  if(!_remCal)return;
  _remCal.month--;if(_remCal.month<0){_remCal.month=11;_remCal.year--;}
  _renderRemCal();
}
function _remCalNextMonth(){
  if(!_remCal)return;
  _remCal.month++;if(_remCal.month>11){_remCal.month=0;_remCal.year++;}
  _renderRemCal();
}
function _remCalH(delta){
  if(!_remCal)return;
  _remCal.hour=(_remCal.hour+delta+24)%24;_renderRemCal();
}
function _remCalM(delta){
  if(!_remCal)return;
  _remCal.min=(_remCal.min+delta*5+60)%60;_renderRemCal();
}
function _remCalSave(){
  if(!_remCal)return;
  const {year,month,day,hour,min}=_remCal;
  const d=new Date(year,month,day,hour,min,0,0);
  if(d.getTime()<Date.now()){showToast('Время уже прошло — выбери будущее');return;}
  _remEditSave(_rmpLocalStr(d));
  _remCal=null;
  const wrap=document.getElementById('rem-cal-wrap');
  if(wrap)wrap.classList.remove('open');
  const row=document.getElementById('rem-edit-custom-row');
  if(row)row.classList.remove('expanded');
}

function remEditDtChange(val){
  if(!val||!_remEditNoteId)return;
  _remEditSave(val);
}

function remEditDelete(){
  if(!_remEditNoteId)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===_remEditNoteId);
  if(idx<0)return;
  delete notes[idx].reminder;
  delete notes[idx].recurring;
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);
  _deleteReminderFromServer(_remEditNoteId);
  scheduleAll();
  renderReminderPanel();
  closeRemEdit();
  showToast('Напоминание удалено');
}

function _renderRemEditRecChips(n){
  const wrap=document.getElementById('rem-edit-rec-chips');
  if(!wrap||!n?.recurring?.times)return;
  const times=[...n.recurring.times].sort();
  wrap.innerHTML=times.map(t=>`<span class="rem-edit-rec-chip">${esc(t)}<button class="rem-edit-rec-chip-del" type="button" onclick="remEditRemoveTime('${t}')" title="Убрать">×</button></span>`).join('');
}

function remEditRemoveTime(time){
  if(!_remEditNoteId)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===_remEditNoteId);
  if(idx<0)return;
  const n=notes[idx];
  if(!n.recurring?.times)return;
  const newTimes=n.recurring.times.filter(t=>t!==time);
  if(!newTimes.length){
    delete notes[idx].recurring;
    delete notes[idx].reminder;
    notes[idx].updatedAt=Date.now();
    saveNotes(notes);
    _deleteReminderFromServer(_remEditNoteId);
    scheduleAll();renderReminderPanel();
    closeRemEdit();
    showToast('Повторение отключено');
    return;
  }
  notes[idx].recurring={...n.recurring,times:newTimes};
  notes[idx].reminder=_tsToIso(_nextRecurringTime(newTimes));
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);scheduleAll();renderReminderPanel();
  _renderRemEditRecChips(notes[idx]);
  showToast(`Убрано ${time}`);
}

function remEditAddTimePrompt(){
  const inp=document.getElementById('rem-edit-add-time-inp');
  if(inp)inp.click();
}

function remEditAddTime(val){
  if(!val||!_remEditNoteId)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===_remEditNoteId);
  if(idx<0)return;
  const n=notes[idx];
  if(!n.recurring)return;
  const times=[...(n.recurring.times||[])];
  if(!times.includes(val))times.push(val);
  times.sort();
  notes[idx].recurring={...n.recurring,times};
  notes[idx].reminder=_tsToIso(_nextRecurringTime(times));
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);scheduleAll();renderReminderPanel();
  _renderRemEditRecChips(notes[idx]);
  showToast(`Добавлено ${val}`);
}

function removeNoteReminder(id){
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===id);
  if(idx<0)return;
  notes[idx]={...notes[idx],reminder:null,recurring:null};
  saveNotes(notes);
  _deleteReminderFromServer(id);
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
    // Открываем пикер времени сразу после открытия шита
    setTimeout(()=>openRmp('home'),350);
  },200);
}

// ── УМНЫЙ ПАРСЕР ВРЕМЕНИ ИЗ ГОЛОСА ──
// Понимает: "завтра в три", "через час", "в пятницу вечером", "сегодня в 18:00", "напомни в понедельник"
function _fmtIso(d){
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}
const _WNUM={один:1,одну:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10,одиннадцать:11,двенадцать:12,тринадцать:13,четырнадцать:14,пятнадцать:15,шестнадцать:16,семнадцать:17,восемнадцать:18,девятнадцать:19,двадцать:20,полдень:12,полночь:0};
const _DAYS={понедельник:1,вторник:2,среда:3,среду:3,четверг:4,пятница:5,пятницу:5,суббота:6,субботу:6,воскресенье:0,воскресенью:0};
// Убирает команду напоминания из текста заметки, оставляя суть
function stripReminderCommand(text){
  if(!text)return text;
  return text
    // "поставь/добавь уведомление/напоминание в/на/через..."
    .replace(/[,.]?\s*(?:поставь(?:\s+мне)?|поставить|добавь|создай)\s+(?:уведомление|напоминание)[^\n.]*/gi,'')
    // "напомни в/на/через/завтра/..."
    .replace(/[,.]?\s*напомни(?:те)?\s+(?:мне\s+)?(?:в|на|через|завтра|сегодня|послезавтра)[^\n.]*/gi,'')
    // "каждый час напоминай [мне]", "каждые 2 часа напоминай [мне]"
    .replace(/[,.]?\s*каждый\s+\S+\s+напоминай(?:\s+мне)?\s*/gi,'')
    .replace(/[,.]?\s*каждые?\s+\S+\s+\S+\s+напоминай(?:\s+мне)?\s*/gi,'')
    // "напоминай [мне] [каждый X]" — убираем только команду, оставляем суть
    .replace(/[,.]?\s*напоминай(?:\s+каждый\s+\S+)?(?:\s+мне)?\s+/gi,'')
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

  // ── «каждый час/день», «каждые N минут/часов» ──
  const evM=t.match(/каждый\s+(час|день)|каждые?\s+(\d+|[\wа-яё]+)\s*(час[а-яё]*|минут[а-яё]*|ден[ьёя]|дн[яей])/);
  if(evM){
    const unit=(evM[1]||evM[3]||'час').toLowerCase();
    const rawAmt=evM[2];
    const amount=rawAmt?(parseInt(rawAmt)||_WNUM[rawAmt]||1):1;
    const d=new Date(now);
    if(unit.startsWith('мин'))d.setMinutes(d.getMinutes()+amount);
    else if(unit.startsWith('ден')||unit.startsWith('дн'))d.setDate(d.getDate()+amount);
    else d.setHours(d.getHours()+amount);
    d.setSeconds(0);d.setMilliseconds(0);
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

  // "напоминай [что]" без явного времени → через час
  if(!base&&h===null){
    if(/напоминай/i.test(t)){
      const d=new Date(now);d.setHours(d.getHours()+1);d.setSeconds(0);d.setMilliseconds(0);
      return _fmtIso(d);
    }
    return null; // ничего не нашли
  }

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
  if(!s)return null;
  // Числовой timestamp (от агента и SET_RECURRING)
  if(typeof s==='number'||(typeof s==='string'&&/^\d{10,}$/.test(s.trim()))){
    const d=new Date(+s);return isNaN(d.getTime())?null:d;
  }
  // ISO строка YYYY-MM-DDTHH:MM (стандартный формат)
  const p=String(s).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
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

// ── "РАЗОБРАЛИСЬ" — пометить заметку как проработанную ──
// Размещение в пользовательском разделе хранится отдельной служебной меткой.
// Обычный AI-тег — лишь предложение и не должен убирать заметку из входящих.
const FILED_FOLDER_PREFIX='__filed__:';
function _filedFolderTag(name){return FILED_FOLDER_PREFIX+String(name||'').trim().toLowerCase();}
function _isFiledFolderTag(tag){return String(tag||'').toLowerCase().startsWith(FILED_FOLDER_PREFIX);}
function getFiledFolderName(note){
  const tag=Array.isArray(note?.aiTags)?note.aiTags.find(_isFiledFolderTag):null;
  return tag?String(tag).slice(FILED_FOLDER_PREFIX.length):'';
}
function isNoteResolved(note){
  const filedFolder=getFiledFolderName(note);
  return !!filedFolder&&isUserFolderName(filedFolder);
}

// ── STATS ──
const _HEALTH_RX=/здоров|врач|лекар|аптек|анализ|спорт|фитнес|бег|трениров|диет|витамин|давлен|таблетк|процедур/i;
function _isHealthNote(n){
  if(n.label==='здоровье')return true;
  return Array.isArray(n.aiTags)&&n.aiTags.some(t=>_HEALTH_RX.test(t));
}
function calcStats(){
  const notes=getNotes();
  const now=Date.now();
  const dayMs=86400000;
  const weekMs=7*dayMs;
  const healthNotes=notes.filter(_isHealthNote);
  const weekNotes=notes.filter(n=>(n.updatedAt||n.createdAt||0)>now-weekMs);
  const resolvedNotes=notes.filter(n=>isNoteResolved(n));
  // Per day last 7 days oldest→newest
  const days=Array.from({length:7},(_,i)=>{
    const start=now-(6-i)*dayMs;
    return notes.filter(n=>{const ts=n.updatedAt||n.createdAt||0;return ts>=start&&ts<start+dayMs;}).length;
  });
  const maxDay=Math.max(1,...days);
  // Scores 0→100 for scale position
  const healthScore=Math.min(96,Math.round(healthNotes.length*20));   // 5 notes = full
  const activityScore=Math.min(96,Math.round(weekNotes.length*12));   // 8 notes = full
  return{total:notes.length,health:healthNotes.length,resolved:resolvedNotes.length,week:weekNotes.length,days,maxDay,healthScore,activityScore};
}
function updateStatsPill(){
  const s=calcStats();
  const h=document.getElementById('hstat-hcnt');
  const a=document.getElementById('hstat-scnt');
  if(h)h.textContent=s.health;
  if(a)a.textContent=s.week;
}
function openStats(){
  const s=calcStats();
  const modal=document.getElementById('stats-modal');
  if(!modal)return;
  // Reset markers before animating
  const mh=document.getElementById('stats-mark-h');
  const ms=document.getElementById('stats-mark-s');
  if(mh)mh.style.transition='none';
  if(ms)ms.style.transition='none';
  if(mh)mh.style.left='5%';
  if(ms)ms.style.left='5%';
  // Week chart
  const barsEl=document.getElementById('stats-week-bars');
  if(barsEl){
    const DAY_NAMES=['пн','вт','ср','чт','пт','сб','вс'];
    const todayIdx=(new Date().getDay()+6)%7; // 0=Mon
    barsEl.innerHTML=s.days.map((cnt,i)=>{
      const barH=Math.max(3,Math.round((cnt/s.maxDay)*48));
      const today=i===todayIdx;
      return`<div class="stats-week-col"><div class="stats-week-bar${today?' today':''}" style="height:${barH}px"></div><div class="stats-week-day">${DAY_NAMES[i]}</div></div>`;
    }).join('');
  }
  // Breakdown
  const bd=document.getElementById('stats-breakdown');
  if(bd){
    bd.innerHTML=[
      {e:'📝',name:'Всего заметок',val:s.total},
      {e:'❤️',name:'О здоровье',val:s.health},
      {e:'⭐',name:'За эту неделю',val:s.week},
      {e:'✅',name:'Разобрались',val:s.resolved},
    ].map(r=>`<div class="stats-row"><div class="stats-row-l"><span class="stats-row-emo">${r.e}</span><span class="stats-row-name">${r.name}</span></div><span class="stats-row-val">${r.val}</span></div>`).join('');
  }
  // Show modal
  modal.style.pointerEvents='auto';
  requestAnimationFrame(()=>{
    modal.classList.add('show');
    // Animate markers after sheet appears
    setTimeout(()=>{
      if(mh){mh.style.transition='';mh.style.left=Math.max(5,s.healthScore)+'%';}
      if(ms){ms.style.transition='';ms.style.left=Math.max(5,s.activityScore)+'%';}
    },120);
  });
}
function closeStats(){
  const modal=document.getElementById('stats-modal');
  if(!modal)return;
  modal.classList.remove('show');
  setTimeout(()=>{modal.style.pointerEvents='none';},300);
}

// ── USER FOLDERS (custom sections created by user via + button) ──
function getUserFolders(){try{return JSON.parse(localStorage.getItem(scopedKey('rz_user_folders'))||'[]');}catch(e){return[];}}
function saveUserFolders(arr){localStorage.setItem(scopedKey('rz_user_folders'),JSON.stringify(arr));queueCloudSave();}
function isUserFolderName(name){
  const value=String(name||'').toLowerCase();
  return !!value&&getUserFolders().some(folder=>String(folder.name||'').toLowerCase()===value);
}
// Palette for user-created folders
const _FOLDER_COLORS=['oklch(0.58 0.12 180)','oklch(0.58 0.12 60)','oklch(0.58 0.12 300)','oklch(0.58 0.12 25)','oklch(0.55 0.12 270)','oklch(0.58 0.12 220)'];
function _folderColor(idx){return _FOLDER_COLORS[idx%_FOLDER_COLORS.length];}
function _folderTint(idx,alpha){
  return _folderColor(idx).replace(/\)$/,` / ${alpha})`);
}
function getNoteUserFolder(note){
  const filedFolder=getFiledFolderName(note);
  if(!filedFolder)return null;
  const folders=getUserFolders();
  const index=folders.findIndex(folder=>String(folder.name).toLowerCase()===filedFolder);
  return index<0?null:{...folders[index],colorIndex:folders[index].idx!==undefined?folders[index].idx:index};
}
function _sectionNoteStyle(note){
  const folder=getNoteUserFolder(note);if(!folder)return '';
  const tint=_folderTint(folder.colorIndex,'.13');
  const line=_folderTint(folder.colorIndex,'.11');
  return `--section-line:${line};background:radial-gradient(ellipse 86% 72% at 12% 10%,${tint},transparent 62%),linear-gradient(158deg,oklch(1 0 0 / .84),oklch(0.965 0.012 210 / .73));`;
}
// Одноразовая очистка дублей рекуррентных заметок (fix для старых данных)
function _deduplicateRecurringNotes(){
  const key=scopedKey('rz_recurring_dedup_v1');
  if(localStorage.getItem(key))return;
  const notes=getNotes();
  const seen={};
  const toKeep=[];
  const toTrash=[];
  notes.forEach(n=>{
    const titleKey=(n.title||'').toLowerCase().trim();
    if(n.recurring&&titleKey){
      if(!seen[titleKey]){seen[titleKey]=true;toKeep.push(n);}
      else toTrash.push(n); // дубль — в корзину
    } else {
      toKeep.push(n);
    }
  });
  if(toTrash.length>0){
    const now=Date.now();
    const trash=getTrash();
    toTrash.forEach(n=>{n._deletedAt=now;trash.unshift(n);});
    while(trash.length>200)trash.pop();
    saveTrash(trash);
    saveNotes(toKeep);
    loadHomeFeed&&loadHomeFeed();
    showToast&&showToast('Убрал '+toTrash.length+' дублей напоминания');
  }
  localStorage.setItem(key,'1');
}

function migrateLegacyFolderPlacements(){
  const key=scopedKey('rz_filed_folder_migrated_v1');
  if(localStorage.getItem(key))return;
  const folders=getUserFolders();
  if(!folders.length)return;
  const notes=getNotes();
  let changed=false;
  notes.forEach(note=>{
    if(getFiledFolderName(note)||!Array.isArray(note.aiTags))return;
    const matched=folders.find(folder=>note.aiTags.some(tag=>String(tag).toLowerCase()===String(folder.name).toLowerCase()));
    if(!matched)return;
    note.aiTags=[...note.aiTags,_filedFolderTag(matched.name)];
    changed=true;
  });
  if(changed)saveNotes(notes);
  localStorage.setItem(key,'1');
}
function _agentFolderDisplayName(tag){
  if(typeof getTagFolders==='function'){
    const folder=getTagFolders().find(item=>String(item.tag).toLowerCase()===String(tag).toLowerCase());
    if(folder?.label)return folder.label;
  }
  const raw=String(tag||'');
  return raw?raw.charAt(0).toUpperCase()+raw.slice(1):'Папка';
}
function openFolderModal(){
  const m=document.getElementById('folder-modal');
  const inner=document.getElementById('folder-modal-inner');
  const inp=document.getElementById('folder-modal-inp');
  if(!m)return;
  m.style.pointerEvents='auto';
  m.style.background='oklch(0.14 0.02 210 / 0.28)';
  m.style.backdropFilter='blur(6px)';
  m.style.webkitBackdropFilter='blur(6px)';
  inner.style.transform='scale(1) translateY(0)';
  inner.style.opacity='1';
  if(inp){inp.value='';setTimeout(()=>inp.focus(),320);}
}
function closeFolderModal(){
  const m=document.getElementById('folder-modal');
  const inner=document.getElementById('folder-modal-inner');
  if(!m)return;
  inner.style.transform='scale(.88) translateY(14px)';
  inner.style.opacity='0';
  setTimeout(()=>{
    m.style.pointerEvents='none';
    m.style.background='oklch(0.14 0.02 210 / 0)';
    m.style.backdropFilter='blur(0px)';
    m.style.webkitBackdropFilter='blur(0px)';
  },260);
}
function confirmFolderCreate(){
  const inp=document.getElementById('folder-modal-inp');
  const name=(inp?.value||'').trim();
  if(!name){inp?.focus();return;}
  const folders=getUserFolders();
  if(!folders.find(f=>f.name.toLowerCase()===name.toLowerCase())){
    folders.push({name,idx:folders.length});
    saveUserFolders(folders);
    loadNotes();
    showToast('Раздел «'+name+'» создан');
  }
  closeFolderModal();
}
function openDrillAdd(){
  if(drillLevel===0)openFolderModal();
  else openSheet('note');
}
function deleteUserFolder(name){
  const folders=getUserFolders().filter(f=>f.name!==name);
  saveUserFolders(folders);
  // Чистим _filed_in: теги в заметках, чтобы не зависали как "разобрались"
  const nameLow=String(name).toLowerCase();
  const notes=getNotes();
  let changed=false;
  notes.forEach(n=>{
    if(!Array.isArray(n.aiTags))return;
    const before=n.aiTags.length;
    n.aiTags=n.aiTags.filter(t=>t.toLowerCase()!==_filedFolderTag(nameLow));
    if(n.aiTags.length!==before){n.updatedAt=Date.now();changed=true;}
  });
  if(changed)saveNotes(notes);
  loadNotes();
  showToast('Раздел удалён');
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
// ── DRILL-DOWN NAVIGATION ──
let drillLevel=0;
let drillCategory=null;
let drillAiTag=null;   // фильтр по AI-тегу (tag-папки)
let drillNoteId=null;
let _drillNoteIdx=-1;
let _drillNotes=[];
let _drillTouchX=0;
let _drillSwipeInited=false;
let _drillGrid=(()=>{const v=localStorage.getItem('rz_drill_grid');return v!==null?v==='1':true;})();
let _drillP1Limit=10;
let _drillHandledSwipe=false; // флаг: drill-свайп обработан, не дублировать в глобальном хендлере
let _selectMode=false;
let _selectedNoteIds=new Set();
let _selectLongPressTimer=null;
let _selectLongPressNid=null;
let _p0SectCollapsed=localStorage.getItem('rz_p0_sect_col')==='1';
let _p0InboxCollapsed=localStorage.getItem('rz_p0_inbox_col')==='1';

function toggleDrillGrid(){
  _drillGrid=!_drillGrid;
  localStorage.setItem('rz_drill_grid',_drillGrid?'1':'0');
  const btn=document.getElementById('drill-grid-btn');
  if(btn)btn.classList.toggle('active',_drillGrid);
  if(drillLevel===1)_drillP1();
  else if(drillLevel===0)_drillP0();
}

function _notePreview(n){
  // Список — показываем первые пункты через запятую
  if(n.type==='list'&&Array.isArray(n.items)&&n.items.length){
    return n.items.slice(0,5).map(i=>i.t||'').filter(Boolean).join(' · ').slice(0,120);
  }
  const body=(n.body||n.title||'');
  const lines=body.split('\n').filter(l=>l.trim());
  if(lines.length>1)return lines.slice(1).join(' ').trim().slice(0,120);
  return '';
}

function loadNotes(){
  migrateLegacyFolderPlacements();
  drillLevel=0;drillCategory=null;drillAiTag=null;drillNoteId=null;
  _drillRender(0);
  _drillNav();
  _drillSeek(0);
  if(!_drillSwipeInited){_drillInitSwipe();_drillSwipeInited=true;}
  // Sync grid-button visual state
  const gBtn=document.getElementById('drill-grid-btn');
  if(gBtn)gBtn.classList.toggle('active',_drillGrid);
}

function drillGo(level,data){
  if(level===1)_drillP1Limit=10; // сбросить пагинацию при входе в список
  if(data&&data.category!==undefined){drillCategory=data.category;drillAiTag=null;}
  if(data&&data.aiTag!==undefined){drillAiTag=data.aiTag;drillCategory=null;}
  if(data&&data.noteId!==undefined)drillNoteId=data.noteId;
  drillLevel=level;
  _drillRender(level);
  _drillNav();
  _drillSeek(level);
}

function drillPickNote(i){
  const n=_drillNotes[i];if(!n)return;
  if(_selectMode){toggleNoteSelect(n.id);return;}
  // Сразу открываем заметку — уровень 2 пропускаем
  if(n.id)openNoteSheetById(n.id);
  else openNoteSheet(getNotes().findIndex(x=>x===n));
}

function drillBack(){
  if(drillLevel===0){go('home');return;}
  drillGo(drillLevel-1,{});
}

function drillJump(level){
  if(level===drillLevel)return;
  if(level<drillLevel){drillGo(level,{});return;}
  // Вперёд: только уровень 1 доступен с уровня 0 (все заметки)
  if(level===1&&drillLevel===0){drillGo(1,{category:null});return;}
}

function _drillSeek(level){
  const track=document.getElementById('drill-track');
  if(track)track.style.transform=`translateX(-${level*100/3}%)`;
  const panel=document.getElementById('drill-p'+level);
  if(panel)panel.scrollTop=0;
}

function _drillNav(){
  const backBtn=document.getElementById('drill-back-btn');
  const crumbs=document.getElementById('drill-crumbs');
  const agentFolderView=drillLevel===1&&drillAiTag!==null&&!isUserFolderName(drillAiTag);
  const notesScreen=document.getElementById('s-notes');
  notesScreen?.classList.toggle('agent-folder-view',agentFolderView);
  document.getElementById('main-app')?.classList.toggle('agent-folder-shell',agentFolderView);
  if(!agentFolderView)notesScreen?.classList.remove('placing');
  if(backBtn){backBtn.style.opacity='1';backBtn.style.pointerEvents='all';}
  if(crumbs){
    let h='';
    const cat=drillAiTag?esc('🏷 '+drillAiTag):drillCategory?esc(drillCategory):'Все заметки';
    const note=(drillNoteId?getNotes().find(n=>n.id===drillNoteId):null)||_drillNotes[_drillNoteIdx]||null;
    if(agentFolderView){
      h=`<span class="drill-agent-label">Папка агента</span><span class="drill-agent-title">${esc(_agentFolderDisplayName(drillAiTag))}</span>`;
    }else if(drillLevel===0){
      h=`<span class="drill-crumb drill-crumb-cur">\u0417\u0430\u043c\u0435\u0442\u043a\u0438</span>`;
    }else if(drillLevel===1){
      h=`<span class="drill-crumb" onclick="drillJump(0)">\u0417\u0430\u043c\u0435\u0442\u043a\u0438</span><span class="drill-sep">&rsaquo;</span><span class="drill-crumb drill-crumb-cur">${cat}</span>`;
    }else{
      const noteTitle=note?(note.title||'\u0417\u0430\u043c\u0435\u0442\u043a\u0430').slice(0,22):'\u0417\u0430\u043c\u0435\u0442\u043a\u0430';
      h=`<span class="drill-crumb" onclick="drillJump(0)">\u0417\u0430\u043c\u0435\u0442\u043a\u0438</span><span class="drill-sep">&rsaquo;</span><span class="drill-crumb" onclick="drillJump(1)">${cat}</span><span class="drill-sep">&rsaquo;</span><span class="drill-crumb drill-crumb-cur">${esc(noteTitle)}</span>`;
    }
    crumbs.innerHTML=h;
  }
  ['dseg0','dseg1','dseg2'].forEach((id,i)=>{
    const s=document.getElementById(id);if(!s)return;
    const isNext=i===drillLevel+1&&i===1; // только сегмент 1 доступен вперёд с уровня 0
    s.className='drill-seg'+(i<drillLevel?' done':i===drillLevel?' cur':isNext?' next':'');
    s.style.cursor=(i<drillLevel||isNext)?'pointer':'default';
  });
}

function _drillRender(level){
  if(level===0)_drillP0();
  if(level===1)_drillP1();
  if(level===2)_drillP2();
}

// ── Закрепление AI-папки в разделах ──
function pinTagFolder(tag){
  if(typeof getTagFolders!=='function')return;
  const tagLow=String(tag).toLowerCase();
  const folders=getTagFolders();
  const f=folders.find(x=>String(x.tag).toLowerCase()===tagLow);
  if(!f)return;
  f.pinned=true;
  saveTagFolders(folders);
  loadNotes();
  showToast(`«${f.label||f.tag}» закреплена в разделах`);
}
function unpinTagFolder(tag){
  if(typeof getTagFolders!=='function')return;
  const tagLow=String(tag).toLowerCase();
  const folders=getTagFolders();
  const f=folders.find(x=>String(x.tag).toLowerCase()===tagLow);
  if(!f)return;
  f.pinned=false;
  saveTagFolders(folders);
  loadNotes();
  showToast(`«${f.label||f.tag}» откреплена`);
}

const _PIN_SVG=`<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14"/><path d="M15 5v5l2 3H7l2-3V5"/><line x1="12" y1="2" x2="12" y2="5"/></svg>`;
const _X_SVG=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const _CHEV_SVG=`<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const _TAG_SVG=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
const _BOOK_SVG=`<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;

// Lucide-style иконки для встроенных категорий
const _STRIPE_SVG={
  здоровье:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  покупки:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
  контакт:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  событие:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  идея:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>`,
  рецепт:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  адрес:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  заметка:`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
};

function _drillP0(){
  const el=document.getElementById('drill-p0');if(!el)return;
  const notes=getNotes();
  const userFolders=getUserFolders();
  const tagFolders=typeof getTagFolders==='function'?getTagFolders():[];
  const userFolderNames=userFolders.map(f=>f.name.toLowerCase());
  const pinnedFolders=tagFolders.filter(f=>f.pinned&&!userFolderNames.includes(String(f.tag).toLowerCase()));
  const aiOnlyFolders=tagFolders.filter(f=>!f.pinned&&!userFolderNames.includes(String(f.tag).toLowerCase()));

  // Встроенные стрипы (здоровье, покупки...) у которых есть заметки
  const stripeEntries=Object.keys(STRIPES).filter(l=>l!=='заметка'&&notes.some(n=>safeLabel(n.label||'заметка')===l));

  // Список / сетка
  el.classList.toggle('list-mode',!_drillGrid);

  let h='';

  // ── МОИ РАЗДЕЛЫ ──
  const hasAny=userFolders.length||pinnedFolders.length||stripeEntries.length;
  h+=`<div class="sect-hdr-row" onclick="toggleP0Sect()">
    <span class="sect-hdr-label">Мои разделы</span>
    <span class="sect-hdr-chev${_p0SectCollapsed?' collapsed':''}">${_CHEV_SVG}</span>
  </div>`;

  if(!_p0SectCollapsed){
    h+=`<div class="sect-grid">`;

    // Пользовательские разделы
    userFolders.forEach((f,i)=>{
      const fNameLow=f.name.toLowerCase();
      const cnt=notes.filter(n=>getFiledFolderName(n)===fNameLow).length;
      const col=_folderColor(f.idx!==undefined?f.idx:i);
      const tint=_folderTint(f.idx!==undefined?f.idx:i,'.12');
      const letter=f.name.charAt(0).toUpperCase();
      h+=`<div class="sect-card" style="--card-tint:${tint};--card-accent:${col};" data-nav-folder="${esc(f.name)}">
        <button type="button" class="sect-card-del" onclick="deleteUserFolder(${jsAttr(f.name)})" title="Удалить">${_X_SVG}</button>
        <div class="sect-card-ico" style="background:${tint};color:${col};">${letter}</div>
        <div class="sect-card-name">${esc(f.name)}</div>
        <div class="sect-card-cnt">${cnt} ${cnt===1?'заметка':cnt<5?'заметки':'заметок'}</div>
      </div>`;
    });

    // Закреплённые папки
    pinnedFolders.forEach(f=>{
      const cnt=notes.filter(n=>Array.isArray(n.aiTags)&&n.aiTags.some(t=>t.toLowerCase()===f.tag.toLowerCase())).length;
      h+=`<div class="sect-card sect-card-pinned" data-nav-folder="${esc(f.tag)}">
        <button type="button" class="sect-card-del" onclick="unpinTagFolder(${JSON.stringify(f.tag)})" title="Открепить">${_PIN_SVG}</button>
        <div class="sect-card-ico sect-card-ico-pin">${_BOOK_SVG}</div>
        <div class="sect-card-name">${esc(f.label||f.tag)}</div>
        <div class="sect-card-cnt">${cnt} ${cnt===1?'заметка':cnt<5?'заметки':'заметок'}</div>
      </div>`;
    });

    // Встроенные категории (здоровье, покупки...) у которых есть заметки
    stripeEntries.forEach(l=>{
      const cnt=notes.filter(n=>safeLabel(n.label||'заметка')===l).length;
      const col=STRIPES[l];
      const ico=_STRIPE_SVG[l]||_STRIPE_SVG.заметка;
      h+=`<div class="sect-card sect-card-stripe" style="--card-tint:${col.replace(')','/0.10)')};--card-accent:${col};" data-nav-cat="${esc(l)}">
        <div class="sect-card-ico" style="background:${col.replace(')','/0.13)')};color:${col};">${ico}</div>
        <div class="sect-card-name">${esc(l.charAt(0).toUpperCase()+l.slice(1))}</div>
        <div class="sect-card-cnt">${cnt} ${cnt===1?'заметка':cnt<5?'заметки':'заметок'}</div>
      </div>`;
    });

    if(!hasAny){
      h+=`<div class="sect-card-empty">Скажи агенту что записать — разделы появятся сами</div>`;
    }

    h+=`</div>`;
  }

  // ── ВХОДЯЩИЕ ──
  if(aiOnlyFolders.length){
    const totalIncoming=aiOnlyFolders.reduce((acc,f)=>acc+notes.filter(n=>Array.isArray(n.aiTags)&&n.aiTags.some(t=>t.toLowerCase()===f.tag.toLowerCase())&&!isNoteResolved(n)).length,0);
    const badge=totalIncoming>0?`<span class="drill-incoming-badge">${totalIncoming}</span>`:'';
    h+=`<div class="sect-hdr-row sect-hdr-incoming" onclick="toggleP0Inbox()">
      <span class="sect-hdr-label">Входящие</span>${badge}
      <span class="sect-hdr-chev${_p0InboxCollapsed?' collapsed':''}">${_CHEV_SVG}</span>
    </div>`;
    if(!_p0InboxCollapsed){
      aiOnlyFolders.forEach(f=>{
        const cnt=notes.filter(n=>Array.isArray(n.aiTags)&&n.aiTags.some(t=>t.toLowerCase()===f.tag.toLowerCase())&&!isNoteResolved(n)).length;
        h+=`<div class="drill-sec-row drill-sec-tag drill-folder-ai" data-nav-folder="${esc(f.tag)}">
          <div class="drill-sec-ico" style="background:oklch(0.52 0.10 202 / .07);color:oklch(0.45 0.10 202);">${_TAG_SVG}</div>
          <div class="drill-sec-name">${esc(f.label||f.tag)}</div>
          <div class="drill-sec-count">${cnt}</div>
          <button type="button" class="folder-pin-btn" title="Закрепить" onclick="pinTagFolder(${JSON.stringify(f.tag)})">${_PIN_SVG}</button>
          <button type="button" class="folder-del-btn" title="Удалить" onclick="deleteTagFolder(${JSON.stringify(f.tag)})">${_X_SVG}</button>
        </div>`;
      });
    }
  }

  // ── ВСЕ ЗАМЕТКИ ──
  h+=`<button type="button" class="drill-all-notes-btn" onclick="drillGo(1,{category:null})">
    Все заметки <span class="drill-all-count">${notes.length}</span>
  </button>`;

  el.innerHTML=h;
}

function toggleP0Sect(){
  _p0SectCollapsed=!_p0SectCollapsed;
  localStorage.setItem('rz_p0_sect_col',_p0SectCollapsed?'1':'');
  _drillP0();
}
function toggleP0Inbox(){
  _p0InboxCollapsed=!_p0InboxCollapsed;
  localStorage.setItem('rz_p0_inbox_col',_p0InboxCollapsed?'1':'');
  _drillP0();
}

// ── Горизонтальный ряд пилюль в заметке ──
function renderSectPills(){
  const row=document.getElementById('sect-pill-row');if(!row)return;
  const btn=document.getElementById('sheet-cat-btn');
  const curLabel=btn?.dataset.label||'заметка';
  const isUserFolder=btn?.dataset.userFolder==='1';
  const curAiTag=btn?.dataset.aiTagFolder||'';

  const userFolders=getUserFolders();
  const tagFolders=typeof getTagFolders==='function'?getTagFolders():[];
  const pinnedFolders=tagFolders.filter(f=>f.pinned);

  const pills=[];

  // Пользовательские разделы
  userFolders.forEach((f,i)=>{
    const col=_folderColor(f.idx!==undefined?f.idx:i);
    const isActive=isUserFolder&&curLabel.toLowerCase()===f.name.toLowerCase();
    pills.push({isActive,html:`<button type="button" class="sect-pill${isActive?' sect-pill-active':''}" style="${isActive?`--pill-c:${col};`:''}" onclick="selectSectPill('user',${jsAttr(f.name)})">${esc(f.name)}</button>`});
  });

  // Закреплённые папки
  pinnedFolders.forEach(f=>{
    const isActive=!!curAiTag&&curAiTag.toLowerCase()===f.tag.toLowerCase();
    pills.push({isActive,html:`<button type="button" class="sect-pill sect-pill-pinned${isActive?' sect-pill-active':''}" style="${isActive?`--pill-c:oklch(0.50 0.14 270);`:''}" onclick="selectSectPill('ai',${jsAttr(f.tag)},${jsAttr(f.label||f.tag)})">${esc(f.label||f.tag)}</button>`});
  });

  // Встроенные типы
  Object.keys(STRIPES).forEach(l=>{
    const isActive=!isUserFolder&&!curAiTag&&curLabel===l;
    pills.push({isActive,html:`<button type="button" class="sect-pill${isActive?' sect-pill-active':''}" style="${isActive?`--pill-c:${STRIPES[l]};`:''}" onclick="selectSectPill('cat','${l}')">${l}</button>`});
  });

  // Активная — первой, остальные в исходном порядке
  pills.sort((a,b)=>Number(b.isActive)-Number(a.isActive));

  let h=pills.map(p=>p.html).join('');
  h+=`<button type="button" class="sect-pill sect-pill-add" onclick="openFolderModal()">+ раздел</button>`;
  row.innerHTML=h;
}

function selectSectPill(type,value,label){
  if(type==='user')selectUserFolderTag(value);
  else if(type==='ai')selectAiTagFolder(value,label||value);
  else selectCat(value);
}

function deleteTagFolder(tag){
  if(typeof getTagFolders!=='function')return;
  const tagLow=String(tag).toLowerCase();
  const folders=getTagFolders();
  const f=folders.find(x=>String(x.tag).toLowerCase()===tagLow);
  if(!f)return;
  const label=f.label||f.tag;
  saveTagFolders(folders.filter(x=>String(x.tag).toLowerCase()!==tagLow));
  loadNotes();
  showToast(`Папка «${label}» удалена`);
}

// Повысить AI-папку до постоянного Раздела (архива)
function promoteToSection(tag){
  const tFolders=typeof getTagFolders==='function'?getTagFolders():[];
  const f=tFolders.find(x=>x.tag.toLowerCase()===String(tag).toLowerCase());
  const raw=f?f.label||f.tag:tag;
  const sectionName=raw.charAt(0).toUpperCase()+raw.slice(1);
  const existing=getUserFolders();
  if(existing.some(x=>x.name.toLowerCase()===sectionName.toLowerCase())){
    showToast(`Раздел «${sectionName}» уже есть`);return;
  }
  const newFolders=[...existing,{name:sectionName,createdAt:Date.now(),idx:existing.length}];
  saveUserFolders(newFolders);
  const notes=getNotes();
  let filed=0;
  notes.forEach(n=>{
    if(Array.isArray(n.aiTags)&&n.aiTags.some(t=>t.toLowerCase()===String(tag).toLowerCase())){
      if(!getFiledFolderName(n)){
        n.aiTags=[...n.aiTags,_filedFolderTag(sectionName)];
        n.updatedAt=Date.now();filed++;
      }
    }
  });
  saveNotes(notes);
  if(typeof getTagFolders==='function'){
    saveTagFolders(tFolders.filter(x=>x.tag.toLowerCase()!==String(tag).toLowerCase()));
  }
  loadNotes();loadHomeFeed();
  showToast(`«${sectionName}» теперь в Архиве`+(filed?` · ${filed} заметок разобрались`:''));
}



// ── ЗАКРЕПЛЕНИЕ ЗАМЕТОК ──
function pinToggleNote(id){
  const notes=getNotes();
  const n=notes.find(x=>x.id===id);
  if(!n)return;
  n.pinned=!n.pinned;
  n.pinnedAt=n.pinned?Date.now():null;
  n.updatedAt=Date.now();
  saveNotes(notes);
  loadHomeFeed();loadNotes();
  showToast(n.pinned?'Заметка закреплена':'Откреплено');
}
function pinToggleFromSheet(){
  // EI — глобальный id текущей открытой заметки (из sheet)
  if(typeof EI==='undefined'||!EI)return;
  const notes=getNotes();
  const n=notes.find(x=>x.id===EI);
  if(!n)return;
  n.pinned=!n.pinned;
  n.pinnedAt=n.pinned?Date.now():null;
  n.updatedAt=Date.now();
  saveNotes(notes);
  loadHomeFeed();
  const btn=document.getElementById('sheet-pin-btn');
  if(btn)btn.classList.toggle('pinned',n.pinned);
  showToast(n.pinned?'Заметка закреплена':'Откреплено');
}function _drillCardBg(i,total){
  const t=total>1?i/(total-1):0;
  const l=(0.93+t*0.06).toFixed(3);
  const c=(0.065-t*0.06).toFixed(4);
  const a=(0.90-t*0.35).toFixed(2);
  return `oklch(${l} ${c} 210 / ${a})`;
}

// ── КОМПАКТНЫЙ ВИД ЛЕНТЫ ──
let _homeFeedCompact=!!localStorage.getItem('rz_compact_feed');
function toggleCompactFeed(){
  _homeFeedCompact=!_homeFeedCompact;
  if(_homeFeedCompact)localStorage.setItem('rz_compact_feed','1');
  else localStorage.removeItem('rz_compact_feed');
  const wrap=document.getElementById('home-feed');
  if(wrap){if(_homeFeedCompact)wrap.classList.add('compact');else wrap.classList.remove('compact');}
  const btn=document.getElementById('compact-feed-btn');
  if(btn)btn.classList.toggle('active',_homeFeedCompact);
}
function _applyCompactFeedState(){
  const wrap=document.getElementById('home-feed');
  const btn=document.getElementById('compact-feed-btn');
  if(wrap){if(_homeFeedCompact)wrap.classList.add('compact');else wrap.classList.remove('compact');}
  if(btn)btn.classList.toggle('active',_homeFeedCompact);
}
function _agentInboxCard(note,index){
  const preview=_notePreview(note);
  return `<article class="agent-note" onclick="drillPickNote(${index})">
    <div class="agent-note-top">
      <span class="agent-note-dot"></span>
      <span class="agent-note-copy">
        <span class="agent-note-title">${esc(note.title)}</span>
        ${preview?`<span class="agent-note-body">${esc(preview)}</span>`:''}
      </span>
      <span class="agent-note-time">${esc(fmtMeta(note.updatedAt||note.createdAt))}</span>
    </div>
  </article>`;
}
function _renderAgentInbox(el,notes){
  _drillNotes=notes;
  if(!notes.length){
    el.innerHTML='<div class="agent-folder-empty">Всё разобрано.</div>';
    return;
  }
  const cards=notes.map((note,index)=>_agentInboxCard(note,index)).join('');
  el.innerHTML=`<div class="agent-inbox">
    <div class="agent-inbox-board"><div class="agent-note-stack">${cards}</div></div>
  </div>`;
}

function _drillP1(){
  const el=document.getElementById('drill-p1');if(!el)return;
  let notes=getNotes();
  if(drillCategory!==null)notes=notes.filter(n=>safeLabel(n.label||'\u0437\u0430\u043c\u0435\u0442\u043a\u0430')===drillCategory);
  const viewingUserFolder=drillAiTag!==null&&isUserFolderName(drillAiTag);
  if(drillAiTag!==null){
    const t=drillAiTag.toLowerCase();
    notes=viewingUserFolder
      ?notes.filter(n=>getFiledFolderName(n)===t)
      :notes.filter(n=>Array.isArray(n.aiTags)&&n.aiTags.map(x=>x.toLowerCase()).includes(t));
    if(!viewingUserFolder)notes=notes.filter(n=>!isNoteResolved(n));
  }
  notes=[...notes].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  if(drillAiTag!==null&&!viewingUserFolder){
    _renderAgentInbox(el,notes);
    return;
  }
  _drillNotes=notes;
  if(!notes.length){
    const emptyMessage=drillAiTag!==null&&!viewingUserFolder?'\u0412\u0441\u0451 \u0440\u0430\u0437\u043e\u0431\u0440\u0430\u043d\u043e.':'\u0417\u0430\u043c\u0435\u0442\u043e\u043a \u043d\u0435\u0442';
    el.innerHTML=`<div style="text-align:center;padding:54px 0;color:var(--fg-l);font-size:16px;">${emptyMessage}</div>`;return;
  }
  const totalNotes=notes.length;
  let h='';
  if(_drillGrid){
    h+='<div class="drill-grid">';
    notes.forEach((n,i)=>{
      if(i>=_drillP1Limit)return;
      const preview=_notePreview(n);
      const visibleTags=(n.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
      const hasAi=!!(n.aiSummary||visibleTags.length);
      const hasBell=!!n.reminder;
      const resolved=!viewingUserFolder&&isNoteResolved(n);
      const sectionStyle=_sectionNoteStyle(n);
      const cardClass=sectionStyle?' section-glass-note':'';
      const bg=sectionStyle?sectionStyle:`background:${_drillCardBg(i,notes.length)};`;
      const selGrid=_selectMode&&_selectedNoteIds.has(n.id);
      h+=`<div class="drill-grid-card${resolved?' resolved':''}${cardClass}${selGrid?' note-selected':''}" style="${bg}" data-nid="${esc(n.id)}" onclick="drillPickNote(${i})">
        <div class="note-select-circle${selGrid?' note-sel-checked':''}"></div>
        <div class="drill-grid-title">${esc(n.title)}</div>
        ${preview?`<div class="drill-grid-preview">${esc(preview)}</div>`:''}
        <div class="drill-grid-foot">
          <span class="drill-note-time">${esc(fmtMeta(n.updatedAt||n.createdAt))}</span>
          ${hasBell?'<span style="font-size:10px">\ud83d\udd14</span>':''}
          ${hasAi&&!resolved?'<span style="font-size:9px;color:var(--accent-d);font-weight:700">AI</span>':''}
        </div>
        ${resolved?'<div class="note-resolved-stamp">\u0440\u0430\u0437\u043e\u0431\u0440\u0430\u043b\u0438\u0441\u044c</div>':''}
      </div>`;
    });
    h+='</div>';
  } else {
    notes.forEach((n,i)=>{
      if(i>=_drillP1Limit)return;
      const preview=_notePreview(n);
      const visibleTags=(n.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
      const hasAi=!!(n.aiSummary||visibleTags.length);
      const hasBell=!!n.reminder;
      const resolved=!viewingUserFolder&&isNoteResolved(n);
      const aiBadge=hasAi&&!resolved?`<span class="drill-note-ai">\u2736 AI</span>`:'';
      const bellBadge=hasBell?`<span class="drill-note-bell"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></span>`:'';
      const resolvedBadge=resolved?`<span class="note-resolved-row">\u0440\u0430\u0437\u043e\u0431\u0440\u0430\u043b\u0438\u0441\u044c</span>`:'';
      const sectionStyle=_sectionNoteStyle(n);
      const tagChips=visibleTags.slice(0,3).map(t=>`<span class="drill-note-tag-chip" onclick="event.stopPropagation();drillGo(1,{aiTag:${jsAttr(t)}})">${esc(t)}</span>`).join('');
      const selRow=_selectMode&&_selectedNoteIds.has(n.id);
      h+=`<div class="drill-note-row${resolved?' resolved':''}${sectionStyle?' section-glass-note':''}${selRow?' note-selected':''}" ${sectionStyle?`style="${sectionStyle}"`:''} data-nid="${esc(n.id)}" onclick="drillPickNote(${i})">
        <div class="note-select-circle${selRow?' note-sel-checked':''}"></div>
        <div class="drill-note-body">
          <div class="drill-note-title">${esc(n.title)}</div>
          ${preview?`<div class="drill-note-preview">${esc(preview)}</div>`:''}
          <div class="drill-note-foot">
            <span class="drill-note-time">${esc(fmtMeta(n.updatedAt||n.createdAt))}</span>
            ${bellBadge}${aiBadge}
          </div>
          ${tagChips?`<div class="drill-note-tags">${tagChips}</div>`:''}
        </div>
        ${resolvedBadge}
      </div>`;
    });
  }
  if(totalNotes>_drillP1Limit){
    const rem=totalNotes-_drillP1Limit;
    h+=`<button class="drill-show-more" onclick="_drillShowMore()">\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0435\u0449\u0451 ${rem}</button>`;
  }
  el.innerHTML=h;
}
function _drillShowMore(){
  const el=document.getElementById('drill-p1');
  const prev=el?el.scrollTop:0;
  _drillP1Limit+=10;
  _drillP1();
  if(el)requestAnimationFrame(()=>{el.scrollTop=prev;});
}

function _drillP2(){
  const el=document.getElementById('drill-p2');if(!el)return;
  const n=(drillNoteId?getNotes().find(x=>x.id===drillNoteId):null)||_drillNotes[_drillNoteIdx]||null;
  if(!n){el.innerHTML=`<div style="padding:20px;color:var(--fg-l);">\u0417\u0430\u043c\u0435\u0442\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430</div>`;return;}
  const nid=n.id;
  // \u0412\u0441\u0435\u0433\u0434\u0430 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u043c id \u2014 getNotes() \u0443\u0436\u0435 \u0433\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u0443\u0435\u0442 \u043d\u0430\u043b\u0438\u0447\u0438\u0435 id \u0443 \u0432\u0441\u0435\u0445 \u0437\u0430\u043c\u0435\u0442\u043e\u043a
  const visibleTags=(n.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
  const hasAi=!!(n.aiSummary||visibleTags.length);
  const aiBlock=hasAi?`<div class="drill-detail-ai">
    <div class="drill-detail-ai-hdr">\u2736 AI \u0430\u043d\u0430\u043b\u0438\u0437</div>
    <div class="drill-detail-ai-body">${esc(n.aiSummary||visibleTags.join(', '))}</div>
  </div>`:'';
  const editFn=nid?`openNoteSheetById('${nid}')`:`showToast('ID\u00a0\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d')`;
  const delFn=nid?`delNoteById('${nid}')`:`showToast('ID\u00a0\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d')`;
  el.innerHTML=`<div class="drill-detail">
    <div class="drill-detail-title">${esc(n.title)}</div>
    <div class="drill-detail-meta">${esc(fmtDt(n.createdAt||n.updatedAt))}</div>
    <div class="drill-detail-body">${esc(n.body||n.title||'')}</div>
    ${aiBlock}
    <div class="drill-detail-actions">
      <button class="drill-btn drill-btn-edit" onclick="${editFn}">\u0420\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c</button>
      <button class="drill-btn drill-btn-del" onclick="${delFn};drillBack();">\u0423\u0434\u0430\u043b\u0438\u0442\u044c</button>
    </div>
  </div>`;
}

// ── Event delegation для drill-p0: iOS-safe навигация по карточкам ──
function _drillInitP0Nav(){
  const p0=document.getElementById('drill-p0');
  if(!p0||p0._p0NavInited)return;
  p0._p0NavInited=true;
  p0.addEventListener('click',e=>{
    // Кнопки действий и заголовки-коллапсеры — навигацию не запускаем
    if(e.target.closest('.sect-card-del,.folder-del-btn,.folder-pin-btn,.sect-hdr-row'))return;
    const navFolder=e.target.closest('[data-nav-folder]');
    if(navFolder){drillGo(1,{aiTag:navFolder.dataset.navFolder});return;}
    const navCat=e.target.closest('[data-nav-cat]');
    if(navCat){drillGo(1,{category:navCat.dataset.navCat||null});return;}
  });
}

function _drillInitSwipe(){
  const el=document.getElementById('s-notes');if(!el)return;
  el.addEventListener('touchstart',e=>{_drillTouchX=e.touches[0].clientX;},{passive:true});
  el.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-_drillTouchX;
    if(dx>60&&drillLevel>0){
      if(_selectMode){_exitSelectMode();return;}
      _drillHandledSwipe=true;
      drillBack();
      // Авто-сброс флага если document handler не успел (edge case)
      setTimeout(()=>{_drillHandledSwipe=false;},300);
    }
  },{passive:true});
  // Scroll-to-top FAB для drill-p1
  const p1=document.getElementById('drill-p1');
  const fab=document.getElementById('drill-top-fab');
  if(p1&&fab){
    p1.addEventListener('scroll',()=>{
      fab.style.display=p1.scrollTop>150?'flex':'none';
    },{passive:true});
  }
  _drillInitSelect();
  _drillInitP0Nav();
}

// ── Multi-select: long-press → выбор заметок ──
function _drillInitSelect(){
  const p1=document.getElementById('drill-p1');if(!p1)return;
  p1.addEventListener('pointerdown',e=>{
    const card=e.target.closest('[data-nid]');if(!card)return;
    if(e.target.closest('.drill-note-tag-chip'))return; // теги не триггерят выбор
    _selectLongPressNid=card.dataset.nid;
    _selectLongPressTimer=setTimeout(()=>{
      _selectLongPressNid=null;
      _enterSelectMode(card.dataset.nid);
      if(navigator.vibrate)navigator.vibrate(40);
    },480);
  },{passive:true});
  const cancel=()=>{
    if(_selectLongPressTimer){clearTimeout(_selectLongPressTimer);_selectLongPressTimer=null;}
  };
  p1.addEventListener('pointerup',cancel,{passive:true});
  p1.addEventListener('pointercancel',cancel,{passive:true});
  p1.addEventListener('pointermove',e=>{
    if(_selectLongPressTimer){
      const r=e.target.closest('[data-nid]');
      if(!r||r.dataset.nid!==_selectLongPressNid)cancel();
    }
  },{passive:true});
}

function _enterSelectMode(nid){
  _selectMode=true;
  _selectedNoteIds=new Set(nid?[nid]:[]);
  document.getElementById('s-notes')?.classList.add('select-mode');
  _drillP1();
  _updateSelectBar();
  _showMultiselectHint();
}

function toggleNoteSelect(nid){
  if(_selectedNoteIds.has(nid))_selectedNoteIds.delete(nid);
  else _selectedNoteIds.add(nid);
  // Перекрашиваем карточку без полного ре-рендера
  document.querySelectorAll(`#drill-p1 [data-nid]`).forEach(el=>{
    if(el.dataset.nid!==nid)return;
    const sel=_selectedNoteIds.has(nid);
    el.classList.toggle('note-selected',sel);
    const circle=el.querySelector('.note-select-circle');
    if(circle)circle.classList.toggle('note-sel-checked',sel);
  });
  _updateSelectBar();
}

function _exitSelectMode(){
  _selectMode=false;
  _selectedNoteIds=new Set();
  document.getElementById('s-notes')?.classList.remove('select-mode');
  _updateSelectBar();
  _drillP1();
}

function _updateSelectBar(){
  const bar=document.getElementById('select-bar');if(!bar)return;
  bar.style.display=_selectMode?'flex':'none';
  const lbl=bar.querySelector('.select-bar-count');
  if(lbl)lbl.textContent=`Выбрано ${_selectedNoteIds.size}`;
  const btn=bar.querySelector('.select-bar-move');
  if(btn)btn.disabled=_selectedNoteIds.size===0;
}

function moveSelectedNotes(){
  if(!_selectedNoteIds.size)return;
  _showMoveToSheet();
}

function _showMoveToSheet(){
  const existing=document.getElementById('move-to-sheet');
  if(existing)existing.remove();
  // Список назначений: разделы пользователя + страйпы
  const userFolders=typeof getUserFolders==='function'?getUserFolders():[];
  let opts='';
  userFolders.forEach(f=>{
    const col=f.color||'oklch(0.55 0.10 210)';
    opts+=`<button class="move-to-opt" onclick="_applyMoveTo('user',${jsAttr(f.name)})">
      <span class="move-to-dot" style="background:${col}"></span>${esc(f.name)}
    </button>`;
  });
  Object.keys(STRIPES).forEach(l=>{
    if(l==='заметка')return;
    const col=(STRIPES[l]||{}).color||'oklch(0.55 0.10 220)';
    const ico=_STRIPE_SVG[l]||_STRIPE_SVG.заметка;
    opts+=`<button class="move-to-opt" onclick="_applyMoveTo('stripe',${jsAttr(l)})">
      <span class="move-to-ico">${ico}</span>${esc(l)}
    </button>`;
  });
  const sheet=document.createElement('div');
  sheet.id='move-to-sheet';
  sheet.className='move-to-sheet';
  sheet.innerHTML=`
    <div class="move-to-backdrop" onclick="_closeMoveToSheet()"></div>
    <div class="move-to-panel">
      <div class="move-to-hdr">Переместить в…</div>
      <div class="move-to-list">${opts}</div>
      <button class="move-to-cancel" onclick="_closeMoveToSheet()">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('open'));
}

function _closeMoveToSheet(){
  const s=document.getElementById('move-to-sheet');
  if(!s)return;
  s.classList.remove('open');
  setTimeout(()=>s.remove(),280);
}

function _applyMoveTo(type,value){
  const notes=getNotes();
  const ids=new Set(_selectedNoteIds);
  let changed=false;
  notes.forEach(n=>{
    if(!ids.has(n.id))return;
    if(type==='user'){
      n.aiTags=(n.aiTags||[]).filter(t=>!_isFiledFolderTag(t));
      n.aiTags.push(_filedFolderTag(value));
    } else if(type==='stripe'){
      n.label=value;
    }
    n.updatedAt=Date.now();
    changed=true;
  });
  if(changed)saveNotes(notes);
  _closeMoveToSheet();
  setTimeout(()=>{
    _exitSelectMode();
    showToast(`Перемещено: ${ids.size}`);
  },200);
}

function _showMultiselectHint(){
  if(localStorage.getItem('rz_multiselect_hint_shown'))return;
  localStorage.setItem('rz_multiselect_hint_shown','1');
  const hint=document.createElement('div');
  hint.className='multiselect-hint';
  hint.textContent='Тапни на заметку — добавь в выбор';
  const sn=document.getElementById('s-notes');
  if(!sn)return;
  sn.appendChild(hint);
  requestAnimationFrame(()=>hint.classList.add('show'));
  setTimeout(()=>{hint.classList.remove('show');setTimeout(()=>hint.remove(),400);},3500);
}

function renderStatChips(){}
function setFilter(){}
function toggleFinderFolders(){}

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
  const delBtn=document.getElementById('tool-delete-btn');
  if(delBtn)delBtn.style.display='inline-flex';
  document.getElementById('sheet-title').textContent='Заметка';
  document.getElementById('sheet-body').innerHTML=noteForm(n.body||n.title||'');
  document.getElementById('sheet-char-count').textContent=(n.body||n.title||'').length+' символов';
  const _nFiledIn=getFiledFolderName(n);
  if(_nFiledIn&&isUserFolderName(_nFiledIn)){
    const _nBtn=document.getElementById('sheet-cat-btn');
    if(_nBtn){
      const _ufs=getUserFolders();
      const _nfi=_ufs.findIndex(f=>f.name.toLowerCase()===_nFiledIn.toLowerCase());
      const _nDisp=_nfi>=0?_ufs[_nfi].name:(_nFiledIn.charAt(0).toUpperCase()+_nFiledIn.slice(1));
      const _nIdx=_nfi>=0?(_ufs[_nfi].idx!==undefined?_ufs[_nfi].idx:_nfi):0;
      _nBtn.dataset.label=_nDisp;_nBtn.dataset.userFolder='1';delete _nBtn.dataset.aiTagFolder;
      const _nDot=document.getElementById('sheet-cat-dot');
      const _nLbl=document.getElementById('sheet-cat-label');
      if(_nDot)_nDot.style.background=_folderColor(_nIdx);
      if(_nLbl)_nLbl.textContent=_nDisp;
    }
    renderSectPills();
  }else{showSheetCat(safeLabel(n.label||'заметка'));}
  initSheetReminder(n.reminder||'');
  initSheetRecurring(n);
  initSheetUndo(n.body||n.title||'');
  // Рендерим чат внутри заметки
  renderNoteChat(n);
  _openSheet();
}

function openSheet(type){
  ST=type;EI=null;_chatNoteId=null;
  const delBtn=document.getElementById('tool-delete-btn');
  if(delBtn)delBtn.style.display='none';
  document.getElementById('sheet-title').textContent='Новая заметка';
  document.getElementById('sheet-body').innerHTML=noteForm('');
  document.getElementById('sheet-char-count').textContent='0 символов';
  // Если открываем из категории — подставляем её по умолчанию
  const defaultCat=(drillCategory&&typeof drillCategory==='string')?drillCategory:'заметка';
  showSheetCat(defaultCat);
  initSheetReminder('');
  initSheetRecurring(null);
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
  // _spellOriginal и _spellActive — var-глобалы из inline-скрипта index.html
  if(typeof _spellOriginal!=='undefined') _spellOriginal=null;
  if(typeof _spellActive!=='undefined') _spellActive=false;
  if(typeof _spellStage!=='undefined') _spellStage=0;
  const spellBtn=document.getElementById('sheet-spell-btn');
  if(spellBtn){spellBtn.classList.remove('spell-on','spell-active','spell-s1','spell-s2','spell-s3','spell-loading');spellBtn.disabled=false;}
  const stageDot=document.getElementById('spell-stage-dot');
  if(stageDot)stageDot.style.display='none';
  // Показать состояние закрепления для текущей заметки
  const pinBtn=document.getElementById('sheet-pin-btn');
  if(pinBtn){
    const curNote=EI?getNotes().find(x=>x.id===EI):null;
    pinBtn.classList.toggle('pinned',!!(curNote?.pinned));
    pinBtn.title=curNote?.pinned?'Открепить заметку':'Закрепить заметку';
  }
  const aiBtn=document.getElementById('sheet-ai-btn');
  if(aiBtn)aiBtn.classList.remove('ai-on');
  _setSheetAiButtonState('idle');
  const filingTarget=document.getElementById('sheet-filing-target');
  if(filingTarget){filingTarget.classList.remove('show');filingTarget.textContent='';}
  const currentFolder=getNoteUserFolder(EI!==null?getNotes().find(note=>note.id===EI):null);
  if(filingTarget&&currentFolder){
    filingTarget.innerHTML=`<span>В разделе</span><strong>${esc(currentFolder.name)}</strong>`;
    filingTarget.classList.add('show');
  }
  const aiPanel=document.getElementById('ai-panel');
  if(aiPanel){
    aiPanel.style.display='none';
    aiPanel.style.overflow='';
    aiPanel.classList.remove('collapsed');
    aiPanel.dataset.aiTags='';
    aiPanel.dataset.aiSummary='';
  }
  const aiBody=document.getElementById('ai-panel-body');
  if(aiBody){
    aiBody.innerHTML='';
    aiBody.style.maxHeight='';
    aiBody.style.overflow='';
    aiBody.style.opacity='';
  }
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
    const sa=document.getElementById('sheet-scroll-area');
    if(sa){
      sa.onclick=(e)=>{if(e.target===sa){const ta=document.getElementById('sh1');if(ta)ta.focus();}};
      // Если есть чат — прокрутить вниз ПОСЛЕ autoGrowTA (иначе рост textarea сбивает скролл)
      const chat=document.getElementById('note-chat');
      if(chat&&chat.style.display!=='none'){
        sa.scrollTop=sa.scrollHeight;
      } else {
        sa.scrollTop=0; // новая заметка — сверху
      }
    }
    const bw=document.getElementById('sheet-body');
    if(bw)bw.onclick=(e)=>{if(e.target===bw){const ta=document.getElementById('sh1');if(ta)ta.focus();}};
  },120);
}

function toggleListMode(){
  const overlay=document.getElementById('overlay');
  const body=document.getElementById('sheet-body');
  if(!overlay||!body)return;
  const ta=document.getElementById('sh1');
  const lines=ta?ta.value.split('\n').map(l=>l.trim()).filter(Boolean):[];
  if(ST==='list'){
    // Список → обычная заметка
    overlay.classList.remove('list-mode');
    body.innerHTML=noteForm(lines.join('\n'));
    const nt=body.querySelector('#sh1');
    if(nt){nt.addEventListener('input',onSheetInput);nt.addEventListener('keydown',onSheetKeydown);nt.addEventListener('paste',onSheetPaste);autoGrowTA(nt);nt.focus();}
    ST='note';
    showToast('Обычная заметка');
  }else{
    // Обычная заметка → список
    overlay.classList.add('list-mode');
    body.innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Каждый пункт с новой строки">${esc(lines.join('\n'))}</textarea>`;
    const nt=body.querySelector('#sh1');
    if(nt){nt.addEventListener('input',onSheetInput);nt.addEventListener('keydown',onSheetKeydown);nt.addEventListener('paste',onSheetPaste);nt.focus();}
    ST='list';
    showToast('Список с галочками');
  }
}

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

const SHEET_HUES={здоровье:'25',покупки:'250',контакт:'210',событие:'80',идея:'290',рецепт:'60',адрес:'195',заметка:'210'};
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
  // btn остаётся скрытым — он хранилище данных, sect-pill-row отображает состояние
  btn.style.display='none';
  delete btn.dataset.userFolder; // сброс флага пользовательского раздела
  delete btn.dataset.aiTagFolder; // сброс флага AI-папки
  const col=STRIPES[label||'заметка']||STRIPES.заметка;
  if(dot)dot.style.background=col;
  if(lbl)lbl.textContent=label||'заметка';
  btn.dataset.label=label||'заметка';
  const filingTarget=document.getElementById('sheet-filing-target');
  if(filingTarget){filingTarget.classList.remove('show');filingTarget.textContent='';}
  // Тонируем фон заметки в цвет категории
  const sheet=document.querySelector('#overlay .sheet');
  if(sheet){
    const h=SHEET_HUES[label]||'210';
    const c=SHEET_CHROMAS[label]||'0.010';
    const chroma2=parseFloat(c)*2.5;
    sheet.style.background=`radial-gradient(ellipse 100% 45% at 50% 0%, oklch(0.84 ${chroma2.toFixed(3)} ${h} / 0.22), transparent 55%), radial-gradient(circle at 8% 8%, oklch(1 0 0 / 0.60) 0%, transparent 36%), oklch(0.974 ${c} ${h} / 0.96)`;
  }
  renderSectPills();
}

function toggleCatDropdown(){
  const dd=document.getElementById('cat-dropdown');if(!dd)return;
  if(dd.classList.contains('open')){dd.classList.remove('open');return;}
  const cur=document.getElementById('sheet-cat-btn')?.dataset.label||'заметка';
  const CHECK=`<svg viewBox="0 0 24 24" width="12" height="12" stroke="var(--accent-d)" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const userFolders=getUserFolders();
  const tagFoldersList=typeof getTagFolders==='function'?getTagFolders():[];
  const pinnedList=tagFoldersList.filter(f=>f.pinned);
  const unpinnedList=tagFoldersList.filter(f=>!f.pinned);
  const curNote=EI?getNotes().find(n=>n.id===EI):null;

  // ── МОИ РАЗДЕЛЫ (пользовательские + закреплённые) ──
  let sectionOpts='<div class="cat-opt-sep">Мои разделы</div>';
  userFolders.forEach((f,i)=>{
    const col=_folderColor(f.idx!==undefined?f.idx:i);
    const isCur=f.name===cur||f.name.toLowerCase()===cur.toLowerCase();
    sectionOpts+=`<div class="cat-opt" onclick="selectUserFolderTag(${jsAttr(f.name)})">
      <div class="cat-opt-dot" style="background:${col};"></div>${esc(f.name)}${isCur?CHECK:''}
    </div>`;
  });
  pinnedList.forEach(f=>{
    const isActive=curNote&&Array.isArray(curNote.aiTags)&&curNote.aiTags.some(t=>t.toLowerCase()===f.tag.toLowerCase());
    sectionOpts+=`<div class="cat-opt" onclick="selectAiTagFolder(${jsAttr(f.tag)},${jsAttr(f.label||f.tag)})">
      <div class="cat-opt-dot" style="background:oklch(0.55 0.12 270);"></div>📌 ${esc(f.label||f.tag)}${isActive?CHECK:''}
    </div>`;
  });
  // Встроенные типы (заметка, здоровье, покупки и т.д.)
  Object.keys(STRIPES).forEach(l=>{
    const isCur=l===cur;
    sectionOpts+=`<div class="cat-opt" onclick="selectCat('${l}')">
      <div class="cat-opt-dot" style="background:${STRIPES[l]};"></div>${l}${isCur?CHECK:''}
    </div>`;
  });
  sectionOpts+=`<div class="cat-opt cat-opt-add" onclick="openFolderModal();document.getElementById('cat-dropdown')?.classList.remove('open')">
    <div class="cat-opt-dot" style="background:oklch(0.75 0 0);"></div>+ Новый раздел
  </div>`;

  // ── ВХОДЯЩИЕ (временные AI-папки) ──
  const incomingOpts=unpinnedList.length
    ?'<div class="cat-opt-sep">Входящие</div>'+unpinnedList.map(f=>{
      const isActive=curNote&&Array.isArray(curNote.aiTags)&&curNote.aiTags.some(t=>t.toLowerCase()===f.tag.toLowerCase());
      return `<div class="cat-opt" onclick="selectAiTagFolder(${jsAttr(f.tag)},${jsAttr(f.label||f.tag)})">
        <div class="cat-opt-dot" style="background:oklch(0.55 0.13 290);"></div>${esc(f.label||f.tag)}${isActive?CHECK:''}
      </div>`;}).join('')
    :'';

  dd.innerHTML=sectionOpts+incomingOpts;
  dd.classList.add('open');
  setTimeout(()=>document.addEventListener('click',closeCatOnClick,{once:true}),10);
}
function closeCatOnClick(e){
  const dd=document.getElementById('cat-dropdown');
  if(dd&&!dd.contains(e.target))dd.classList.remove('open');
}
function selectCat(label){
  showSheetCat(label);
  document.getElementById('cat-dropdown')?.classList.remove('open');
  renderSectPills();
  saveSheetDraft();
}
function selectUserFolderTag(folderName){
  const btn=document.getElementById('sheet-cat-btn');
  if(btn){
    btn.dataset.label=folderName;
    btn.dataset.userFolder='1';
    const dot=document.getElementById('sheet-cat-dot');
    const lbl=document.getElementById('sheet-cat-label');
    const userFolders=getUserFolders();
    const fi=userFolders.findIndex(f=>f.name.toLowerCase()===folderName.toLowerCase());
    const folderIdx=fi>=0?(userFolders[fi].idx!==undefined?userFolders[fi].idx:fi):0;
    const col=_folderColor(folderIdx);
    if(dot)dot.style.background=col;
    if(lbl)lbl.textContent=folderName;
    const filingTarget=document.getElementById('sheet-filing-target');
    if(filingTarget){
      filingTarget.innerHTML=`<span>Сохранить в раздел</span><strong>${esc(folderName)}</strong>`;
      filingTarget.classList.add('show');
    }
    // Цвет раздела мягко входит в стекло листа после выбора назначения.
    const sheet=document.querySelector('#overlay .sheet');
    if(sheet)sheet.style.background=`radial-gradient(ellipse 100% 45% at 50% 0%, ${_folderTint(folderIdx,'.15')}, transparent 55%), radial-gradient(circle at 8% 8%, oklch(1 0 0 / 0.60) 0%, transparent 36%), oklch(0.974 0.012 205 / 0.96)`;
  }
  document.getElementById('cat-dropdown')?.classList.remove('open');
  renderSectPills();
  saveSheetDraft();
}

function selectAiTagFolder(tag,label){
  const btn=document.getElementById('sheet-cat-btn');
  if(btn){
    btn.dataset.label=label;
    btn.dataset.aiTagFolder=tag;
    btn.dataset.userFolder='1';
    const dot=document.getElementById('sheet-cat-dot');
    const lbl=document.getElementById('sheet-cat-label');
    if(dot)dot.style.background='oklch(0.55 0.13 290)';
    if(lbl)lbl.textContent=label;
    const filingTarget=document.getElementById('sheet-filing-target');
    if(filingTarget){
      filingTarget.innerHTML=`<span>Добавить в папку</span><strong>${esc(label)}</strong>`;
      filingTarget.classList.add('show');
    }
    const sheet=document.querySelector('#overlay .sheet');
    if(sheet)sheet.style.background='radial-gradient(ellipse 100% 45% at 50% 0%, oklch(0.55 0.13 290 / .12), transparent 55%), radial-gradient(circle at 8% 8%, oklch(1 0 0 / 0.60) 0%, transparent 36%), oklch(0.974 0.010 290 / 0.96)';
  }
  document.getElementById('cat-dropdown')?.classList.remove('open');
  renderSectPills();
  saveSheetDraft();
}

function initSheetReminder(val){
  const row=document.getElementById('sheet-reminder-row');
  const inp=document.getElementById('sheet-reminder-in');
  const btn=document.getElementById('sheet-reminder-btn');
  if(row)row.style.display=val?'flex':'none';
  if(inp)inp.value=val||'';
  if(btn)btn.textContent=val?fmtDt(val):'Выбрать время';
}
function clearSheetReminder(){
  initSheetReminder('');
  document.getElementById('sheet-reminder-row').style.display='none';
}
function onReminderChange(){}

// ── RECURRING TIMES EDITOR ──
function initSheetRecurring(n){
  const row=document.getElementById('sheet-recurring-row');
  if(!row)return;
  if(!n||!n.recurring?.times?.length){row.style.display='none';row.innerHTML='';return;}
  const times=[...n.recurring.times].sort();
  const chips=times.map(t=>`<span class="rec-chip">${esc(t)}<button class="rec-chip-del" type="button" onclick="removeRecurringTime('${t}')" title="Убрать это время">×</button></span>`).join('');
  row.innerHTML=`<span class="sheet-reminder-lbl">🔁</span><div class="rec-chips-wrap">${chips}</div><button class="rec-add-btn" type="button" onclick="addRecurringTimePrompt()" title="Добавить время">+</button>`;
  row.style.display='flex';
}
function removeRecurringTime(time){
  if(!EI)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===EI);
  if(idx<0)return;
  const n=notes[idx];
  if(!n.recurring?.times)return;
  const newTimes=n.recurring.times.filter(t=>t!==time);
  if(!newTimes.length){
    // Последнее время убрано — отключаем recurring, оставляем как разовое (без reminder)
    delete notes[idx].recurring;
    delete notes[idx].reminder;
    notes[idx].updatedAt=Date.now();
    saveNotes(notes);
    scheduleAll();
    initSheetRecurring(null);
    initSheetReminder('');
    renderReminderPanel();
    showToast('Повторение отключено');
    return;
  }
  notes[idx].recurring={...n.recurring,times:newTimes};
  notes[idx].reminder=_tsToIso(_nextRecurringTime(newTimes));
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);
  scheduleAll();
  initSheetRecurring(notes[idx]);
  initSheetReminder(notes[idx].reminder||'');
  renderReminderPanel();
  showToast(`Убрано ${time}`);
}
function addRecurringTimePrompt(){
  const inp=document.getElementById('rec-add-time-input');
  if(inp)inp.click();
}
function addRecurringTime(val){
  if(!val||!EI)return;
  const notes=getNotes();
  const idx=notes.findIndex(n=>n.id===EI);
  if(idx<0)return;
  const n=notes[idx];
  if(!n.recurring)return;
  const times=[...(n.recurring.times||[])];
  if(!times.includes(val))times.push(val);
  times.sort();
  notes[idx].recurring={...n.recurring,times};
  notes[idx].reminder=_tsToIso(_nextRecurringTime(times));
  notes[idx].updatedAt=Date.now();
  saveNotes(notes);
  scheduleAll();
  initSheetRecurring(notes[idx]);
  initSheetReminder(notes[idx].reminder||'');
  renderReminderPanel();
  showToast(`Добавлено ${val}`);
}

// ── REMINDER PICKER ──
let _rmpTarget=null,_rmpDate=new Date();

function openRmp(target){
  _rmpTarget=target;
  const id=target==='sheet'?'sheet-reminder-in':'home-input-reminder';
  const cur=document.getElementById(id)?.value;
  _rmpDate=cur?new Date(cur):null;
  // Показать баннер с текущим напоминанием если уже стоит
  const currentBanner=document.getElementById('rmp-current');
  const currentVal=document.getElementById('rmp-current-val');
  const hasExisting=_rmpDate&&!isNaN(_rmpDate.getTime())&&_rmpDate>new Date();
  if(currentBanner)currentBanner.style.display=hasExisting?'flex':'none';
  if(currentVal&&hasExisting)currentVal.textContent=fmtDt(_rmpDate.toISOString());
  if(!_rmpDate||isNaN(_rmpDate.getTime())||_rmpDate<=new Date()){
    _rmpDate=new Date(Date.now()+3600000);
  }
  _rmpSyncInput();
  _rmpHighlightChips();
  const ov=document.getElementById('rmp-ov');
  ov.style.display='flex';
}

function _rmpLocalStr(d){
  const pad=n=>String(n).padStart(2,'0');
  return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function _rmpSyncInput(){
  const inp=document.getElementById('rmp-dt-input');
  if(inp&&_rmpDate)inp.value=_rmpLocalStr(_rmpDate);
}
function _rmpHighlightChips(){
  // Clear all — chip highlight set on pick
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
}

// Quick picks: offset in minutes from now
function rmpPickQuick(minutes,btn){
  _rmpDate=new Date(Date.now()+minutes*60000);
  _rmpSyncInput();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
// Today at given hour:minute (if in past → tomorrow)
function rmpPickToday(h,m,btn){
  const d=new Date();d.setHours(h,m,0,0);
  if(d<=new Date())d.setDate(d.getDate()+1);
  _rmpDate=d;
  _rmpSyncInput();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
// Tomorrow at given hour:minute
function rmpPickTomorrow(h,m,btn){
  const d=new Date();d.setDate(d.getDate()+1);d.setHours(h,m,0,0);
  _rmpDate=d;
  _rmpSyncInput();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
// Native datetime-local input changed
function rmpPickNative(val){
  if(!val)return;
  const d=new Date(val);
  if(isNaN(d.getTime()))return;
  _rmpDate=d;
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
}

function rmpClose(){
  const ov=document.getElementById('rmp-ov');
  if(!ov)return;
  ov.style.opacity='0';ov.style.transition='opacity .22s';
  setTimeout(()=>{ov.style.display='none';ov.style.opacity='';ov.style.transition='';},240);
}
function rmpConfirm(){
  if(!_rmpDate||isNaN(_rmpDate.getTime()))return rmpClose();
  const val=_rmpLocalStr(_rmpDate);
  if(_rmpTarget==='sheet'){
    const inp=document.getElementById('sheet-reminder-in');
    const row=document.getElementById('sheet-reminder-row');
    const btn=document.getElementById('sheet-reminder-btn');
    if(inp)inp.value=val;
    if(row)row.style.display='flex';
    if(btn)btn.textContent=fmtDt(val);
  } else {
    const inp=document.getElementById('home-input-reminder');
    const btn=document.getElementById('home-reminder-btn');
    if(inp)inp.value=val;
    if(btn){btn.textContent=fmtDt(val);btn.classList.add('has-val');}
  }
  rmpClose();
}

// ── Авто .ics при сохранении заметки с напоминанием ──
function _autoExportIcs(noteTitle,noteBody,reminderVal,noteId){
  try{
    const dt=new Date(reminderVal);if(isNaN(dt.getTime()))return;
    const dtEnd=new Date(dt.getTime()+60000);
    const pad=n=>String(n).padStart(2,'0');
    const icsDate=d=>d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+'00Z';
    const icsEsc=s=>(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
    const title=icsEsc((noteTitle||'Напоминание').slice(0,80));
    const desc=icsEsc((noteBody||'').slice(0,200).replace(/\n/g,' '));
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Разберёмся//RU','CALSCALE:GREGORIAN','METHOD:PUBLISH',
      'BEGIN:VEVENT',`UID:${noteId||Date.now()}@razberemsia`,`DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(dt)}`,`DTEND:${icsDate(dtEnd)}`,`SUMMARY:${title}`,`DESCRIPTION:${desc}`,
      'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Напоминание','TRIGGER:-PT1M','END:VALARM',
      'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Напоминание','TRIGGER:PT0S','END:VALARM',
      'END:VEVENT','END:VCALENDAR'].join('\r\n');
    const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    const a=document.createElement('a');
    a.download=`rz-${String(noteId||Date.now()).slice(-6)}.ics`;
    a.href=isIOS?'data:text/calendar;charset=utf-8,'+encodeURIComponent(ics)
      :URL.createObjectURL(new Blob([ics],{type:'text/calendar;charset=utf-8'}));
    document.body.appendChild(a);a.click();
    setTimeout(()=>{document.body.removeChild(a);if(!isIOS)URL.revokeObjectURL(a.href);},600);
  }catch(e){}
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
    'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Напоминание','TRIGGER:-PT1M','END:VALARM',
    'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Напоминание','TRIGGER:PT0S','END:VALARM',
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
  const isUserFolder=catBtn?.dataset.userFolder==='1';
  const _selectedAiTag=catBtn?.dataset.aiTagFolder||'';
  const v3=isUserFolder?'заметка':safeLabel(catBtn?catBtn.dataset.label||'заметка':'заметка');
  const _selectedUserFolder=(isUserFolder&&!_selectedAiTag)?(catBtn?.dataset.label||''):'';
  const reminderEl=document.getElementById('sheet-reminder-in');
  const v2=reminderEl?reminderEl.value:'';
  if(!v1.trim()){showToast('Напишите текст');return;}
  const list=getNotes();
  const existingIdx=EI!==null?list.findIndex(n=>n.id===EI):-1;
  const prev=existingIdx>=0?list[existingIdx]:null;
  const previousFiledFolder=getFiledFolderName(prev);
  const prevHadDestination=!!(_selectedUserFolder&&previousFiledFolder===_selectedUserFolder.toLowerCase());
  const aiPanel=document.getElementById('ai-panel');
  let aiTags=Array.isArray(prev?.aiTags)?prev.aiTags:[];
  let aiSummary=prev?.aiSummary||'';
  let aiCache=prev?.aiCache||null;
  if(aiPanel?.dataset.aiTags){
    try{const parsed=JSON.parse(aiPanel.dataset.aiTags);if(Array.isArray(parsed))aiTags=parsed.filter(t=>typeof t==='string').slice(0,8);}catch(e){}
  }
  if(aiPanel?.dataset.aiSummary)aiSummary=aiPanel.dataset.aiSummary;
  // Если создаём заметку из тег-папки — добавляем её тег автоматически
  if(existingIdx<0&&drillAiTag&&!aiTags.map(t=>t.toLowerCase()).includes(drillAiTag.toLowerCase())){
    aiTags=[...aiTags,drillAiTag];
  }
  // Если пользователь выбрал раздел из пикера — добавляем тег
  if(_selectedUserFolder&&!aiTags.map(t=>t.toLowerCase()).includes(_selectedUserFolder.toLowerCase())){
    aiTags=[...aiTags,_selectedUserFolder];
  }
  // Если пользователь выбрал AI-папку из пикера — добавляем её тег
  if(_selectedAiTag&&!aiTags.map(t=>t.toLowerCase()).includes(_selectedAiTag.toLowerCase())){
    aiTags=[...aiTags,_selectedAiTag];
  }
  aiTags=aiTags.filter(tag=>!_isFiledFolderTag(tag));
  // Если создаём из раздела — добавить _filed_in: даже если пилюля не переключалась
  const drillFolderCtx=existingIdx<0&&drillAiTag&&isUserFolderName(drillAiTag)?drillAiTag:'';
  const filedFolder=_selectedUserFolder||drillFolderCtx||previousFiledFolder;
  if(filedFolder)aiTags=[...aiTags,_filedFolderTag(filedFolder)];
  const words=v1.trim().split(/\s+/);
  const title=words.slice(0,6).join(' ')+(words.length>6?'...':'');
  const ts=Date.now();
  // Если текст изменился — сбросить кэш анализа
  if(aiCache&&aiCache.bodyKey!==v1.trim().slice(0,80))aiCache=null;
  const item={id:existingIdx>=0?EI:genId(),title,body:v1.trim(),label:v3,reminder:v2||null,updatedAt:ts,aiTags,aiSummary,aiCache};
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
  if(aiSummary)addToAiMemory(aiSummary,aiTags.filter(tag=>!_isFiledFolderTag(tag)),item.id);
  clearSheetDraft();
  // Запомнить контекст папки ДО сброса в loadNotes()
  const wasNew=(EI===null); // запомнить ДО closeSheet(), который обнуляет EI
  const _prevAiTag=drillAiTag;
  const _prevCategory=drillCategory;
  const _prevDrillLevel=drillLevel;
  const _wasInNotes=(cur==='notes');
  loadNotes();loadHomeFeed();loadNotepad();
  closeSheet();
  showToast(wasNew?'Сохранено ✓':'Изменено ✓');
  // Возврат в папку после сохранения (и создания, и редактирования)
  if(_wasInNotes&&_prevDrillLevel>=1){
    setTimeout(()=>{
      if(_prevAiTag!==null)drillGo(1,{aiTag:_prevAiTag});
      else drillGo(1,{category:_prevCategory});
    },50);
  }
  if(v2) _handleReminderAfterSave(v2,item.id,title,v1.trim().slice(0,200));
  // AI-ответ — только для новых заметок (не редактирование)
  if(wasNew&&v1.trim().length>=15){
    _fetchChatReply(item.id, v1.trim());
  }
}

function editNote(i){openNoteSheet(i);}
function editNoteById(id){openNoteSheetById(id);}

// Удалить заметку прямо из открытого листа
function deleteOpenNote(){
  if(!EI)return;
  const id=EI;
  closeSheet();
  setTimeout(()=>{
    delNoteById(id);
  },260);
}

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
    // Снять напоминание с сервера (иначе cron продолжит слать пуши)
    if(deleted.reminder)_deleteReminderFromServer(deleted.id);
  }
  saveNotes(notes);
  scheduleAll();
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
    const d=document.createElement('div');d.className='trash-item';
    const when=n._deletedAt?fmtMeta(n._deletedAt):'';
    d.innerHTML=`<div class="note-cat"><span style="font-size:11px;margin-right:4px;">${catIcon(n.label)}</span>${esc(safeLabel(n.label||'заметка'))}</div>
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
      const d=document.createElement('div');d.className='hist-item';
      const when=fmtMeta(h.savedAt);
      d.innerHTML=`<div class="note-cat"><span style="font-size:11px;margin-right:4px;">${catIcon(sn.label)}</span>${esc(safeLabel(sn.label||'заметка'))}</div>
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
    const wrap=document.createElement('div');wrap.style.cssText='position:relative;overflow:hidden;border-radius:16px;margin-bottom:8px;';
    const delBg=buildNoteSwipePanel('list', 16, ()=>n.id?delNoteById(n.id):delNote(i), ()=>shareNote(n));
    const d=document.createElement('div');d.className='pad-item';d.style.margin='0';
    d.innerHTML=`<div class="pad-cat">${esc(safeLabel(n.label||'заметка'))}</div>
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
  const nidPad=genId();
  const notes=getNotes();
  notes.push({id:nidPad,title,body:text,label,reminder,createdAt:ts,updatedAt:ts,fromPad:true});
  saveNotes(notes);
  inp.value='';inp.style.height='auto';
  loadNotepad();loadNotes();loadHomeFeed();
  showToast(reminder?`Сохранено · напомним ${fmtDt(reminder)}`:`Сохранено в «${label}» ✓`);
  if(reminder) _handleReminderAfterSave(reminder,nidPad,title,text.slice(0,200));
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

// ── HOME FEED (notification cards) ──
let _homeFeedNotes=[];

function loadHomeFeed(){
  const notes=getNotes();
  const el=document.getElementById('home-feed');if(!el)return;

  // Обновить счётчик в кнопке «Заметки»
  const badge=document.getElementById('notes-count-badge');
  if(badge)badge.textContent=notes.length?'('+notes.length+')':'';

  // Обновить пилл статистики в шапке
  updateStatsPill();

  if(!notes.length){
    _homeFeedNotes=[];
    el.innerHTML=`<div class="hf-empty">Пока заметок нет.<br>Нажмите «Новая заметка» чтобы начать.</div>`;
    return;
  }

  // Сортировка: закреплённые → с ближайшими напоминаниями → по дате
  const now=Date.now();
  const pinned=notes.filter(n=>n.pinned)
    .sort((a,b)=>(b.pinnedAt||0)-(a.pinnedAt||0));
  const unpinned=notes.filter(n=>!n.pinned);
  const withRem=unpinned.filter(n=>n.reminder&&new Date(n.reminder).getTime()>now)
    .sort((a,b)=>new Date(a.reminder)-new Date(b.reminder));
  const rest=unpinned.filter(n=>!n.reminder||new Date(n.reminder).getTime()<=now)
    .sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
  const sorted=[...pinned,...withRem,...rest].slice(0,25);
  _homeFeedNotes=sorted;

  el.innerHTML='';
  sorted.forEach((n,i)=>{
    // 🚦 Светофор: 🔴 просрочено → 🟡 есть напоминание → 🟢 просто заметка
    const remDt=n.reminder?new Date(n.reminder).getTime():0;
    const remOverdue=remDt&&remDt<=now;
    const remFuture=remDt&&remDt>now;
    const visibleTags=(n.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
    const hasAi=!!(n.aiSummary||visibleTags.length);
    let dotClass=hasAi?'hf-dot-green':'hf-dot-none';
    if(remFuture)dotClass='hf-dot-amber';
    if(remOverdue)dotClass='hf-dot-red';

    const title=n.title||(n.body||'').split('\n')[0].trim().slice(0,60)||'Заметка';
    const preview=_notePreview(n);
    const timeStr=fmtMeta(n.updatedAt||n.createdAt);
    const aiBadge=hasAi?`<span class="hf-ai-badge">✶︎ AI</span>`:'';
    const typeTag=n.type==='list'?`<span class="hf-ai-badge" style="color:var(--accent-d);background:oklch(0.52 0.10 210/0.08);border-color:oklch(0.52 0.10 210/0.20);">☰ список</span>`:'';

    // Обёртка со свайпом
    const wrap=document.createElement('div');
    wrap.className='hf-wrap';

    // Карточка
    const card=document.createElement('button');
    const sectionStyle=_sectionNoteStyle(n);
    card.className='hf-card'+(sectionStyle?' section-glass-note':'');
    if(sectionStyle)card.style.cssText=sectionStyle;
    const isPinned=!!n.pinned;
    const pinIcon=isPinned?`<span class="hf-pin-mark"><svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0015 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z"/></svg></span>`:'';
    if(isPinned)card.classList.add('pinned');
    card.innerHTML=`
      <div class="hf-sig"><div class="hf-dot ${dotClass}"></div></div>
      <div class="hf-body">
        <div class="hf-title">${esc(title)}${pinIcon}</div>
        ${preview?`<div class="hf-preview">${esc(preview)}</div>`:''}
        <div style="margin-top:${(hasAi||n.type==='list')?'4px':'0'}">${aiBadge}${typeTag}</div>
      </div>
      <div class="hf-right">
        <div class="hf-time">${esc(timeStr)}</div>
        <div class="hf-arr">&rsaquo;</div>
      </div>`;
    card.onclick=()=>{
      if(_cardSwiping)return;
      n.id?openNoteSheetById(n.id):openNoteSheet(getNotes().findIndex(x=>x===n));
    };

    // Панель удаления (свайп)
    const delPanel=document.createElement('div');
    delPanel.className='hf-del-panel';
    delPanel.innerHTML=`<div class="del-x-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="oklch(0.45 0.20 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>`;
    delPanel._onDelete=()=>{
      const notes=getNotes();
      const idx=n.id?notes.findIndex(x=>x.id===n.id):notes.findIndex(x=>x===n);
      if(idx>=0){const del=notes.splice(idx,1)[0];del._deletedAt=Date.now();const tr=getTrash();tr.unshift(del);if(tr.length>50)tr.pop();saveTrash(tr);saveNotes(notes);if(del.reminder)_deleteReminderFromServer(del.id);}
      scheduleAll();loadHomeFeed();loadNotes();
      showToast('В корзину · можно восстановить');
    };
    _makeSwipeAttach(card,delPanel);

    // Крестик для десктопа
    const dDel=document.createElement('button');
    dDel.className='hf-desk-del';
    dDel.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="oklch(0.45 0.15 15)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    dDel.onclick=(e)=>{e.stopPropagation();delPanel._onDelete();};

    wrap.appendChild(delPanel);
    wrap.appendChild(card);
    wrap.appendChild(dDel);
    el.appendChild(wrap);
  });
  // Восстановить compact-класс и кнопку после каждого рендера
  _applyCompactFeedState();
}

function hfOpenNote(i){
  const n=_homeFeedNotes[i];if(!n)return;
  n.id?openNoteSheetById(n.id):openNoteSheet(getNotes().findIndex(x=>x===n));
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
  const nid=genId();
  const notes=getNotes();
  notes.push({id:nid,title,body:text,label,reminder:reminder||null,createdAt:ts,updatedAt:ts,fromPad:true});
  saveNotes(notes);
  closeInputSheet();
  loadHomeFeed();loadNotes();loadNotepad();
  showToast(reminder?'Записал · напомню '+fmtDt(reminder):'Записал ✓');
  if(reminder) _handleReminderAfterSave(reminder,nid,title,text.slice(0,200));
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

// ── CENTER BUTTON — тап=заметка, удержание=ИИ Агент ──
function nnbPointerDown(e){
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){}
  _nnbStartY=e.clientY;
  _nnbHolding=false;
  _nnbHoldTimer=setTimeout(()=>{
    _nnbHolding=true;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.add('holding');
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='Агент слушает…';lbl.classList.add('rec');}
    startAgentVoice();
  },220);
}

function nnbPointerMove(e){
  // Агент-режим — свайп не используется
}

function nnbPointerUp(e){
  clearTimeout(_nnbHoldTimer);
  if(_nnbHolding){
    _nnbHolding=false;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.remove('holding');
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='';lbl.classList.remove('rec');}
    stopAgentVoice();
  } else {
    // Короткий тап — новая заметка
    openSheet('note');
  }
}

function nnbPointerCancel(e){
  clearTimeout(_nnbHoldTimer);
  if(_nnbHolding){
    _nnbHolding=false;
    const btn=document.getElementById('new-note-btn');
    if(btn)btn.classList.remove('holding');
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='';lbl.classList.remove('rec');}
    stopAgentVoice();
  }
}

function nnbStopHandsfree(){
  _nnbHandsfree=false;_nnbHolding=false;_nnbJustLocked=false;
  const btn=document.getElementById('new-note-btn');
  if(btn){btn.classList.remove('holding');btn.classList.remove('handsfree');}
}

// ── MIC BUTTON — тап=голосовая заметка, удержание=хендсфри ──
let _micHolding=false,_micHandsfree=false,_micHoldTimer=null,_micJustLocked=false,_micStopTap=false,_micStartY=0,_micManualStop=false;

function micBtnPointerDown(e){
  if(_micHandsfree){
    _micStopTap=true;
    _micManualStop=true;
    stopHomeVoice();
    micStopHandsfree();
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='';lbl.classList.remove('rec');}
    return;
  }
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){}
  _micStartY=e.clientY;_micHolding=false;_micJustLocked=false;_micManualStop=false;
  _micHoldTimer=setTimeout(()=>{
    _micHolding=true;
    const btn=document.getElementById('mic-home-btn');
    if(btn)btn.classList.add('holding');
    startHomeVoice();
  },220);
}

function micBtnPointerMove(e){
  if(!_micHolding||_micHandsfree)return;
  const dy=_micStartY-e.clientY;
  if(dy>30){
    _micHandsfree=true;_micJustLocked=true;
    const btn=document.getElementById('mic-home-btn');
    if(btn){btn.classList.remove('holding');btn.classList.add('handsfree');}
    const lbl=document.getElementById('home-voice-label');
    if(lbl){lbl.textContent='🔒 Хендсфри — говорите';lbl.classList.add('rec');}
  }
}

function micBtnPointerUp(e){
  clearTimeout(_micHoldTimer);
  if(_micStopTap){_micStopTap=false;return;}
  if(_micHandsfree&&_micJustLocked){_micJustLocked=false;_micHolding=false;return;}
  if(_micHolding){
    _micHolding=false;
    const btn=document.getElementById('mic-home-btn');
    if(btn)btn.classList.remove('holding');
    _micManualStop=true;
    stopHomeVoice();
  } else if(!_micHandsfree){
    toggleHomeVoice();
  }
}

function micBtnPointerCancel(e){
  clearTimeout(_micHoldTimer);
  if(_micHolding&&!_micHandsfree){
    _micHolding=false;
    const btn=document.getElementById('mic-home-btn');
    if(btn)btn.classList.remove('holding');
    _micManualStop=true;
    stopHomeVoice();
  }
}

function micStopHandsfree(){
  _micHandsfree=false;_micHolding=false;_micJustLocked=false;
  const btn=document.getElementById('mic-home-btn');
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
      let cleanBody=voiceReminder?stripReminderCommand(text):text;
      // Если команда была вида "поставь уведомление в X" — тело пустое, создаём минимальную заметку
      if(!cleanBody&&voiceReminder)cleanBody='🔔 '+fmtDt(voiceReminder);
      const auto=analyzeText(cleanBody);
      const reminder=voiceReminder||auto.reminder||null;
      const ts=Date.now();
      const notes=getNotes();
      const nidVoice=genId();
      notes.push({id:nidVoice,title:auto.title,body:cleanBody,label:auto.label,reminder,createdAt:ts,updatedAt:ts,fromPad:true});
      saveNotes(notes);
      loadHomeFeed();loadNotes();loadNotepad();
      showToast(reminder?'Записал · напомню '+fmtDt(reminder):'Записал ✓');
      if(reminder) _handleReminderAfterSave(reminder,nidVoice,auto.title,cleanBody.slice(0,200));
    }
    if(_micHandsfree&&!_micManualStop){
      setTimeout(()=>{if(_micHandsfree&&!homeRecog)startHomeVoice();},260);
    }else{
      micStopHandsfree();
    }
  };
  homeRecog.start();
}
function stopHomeVoice(){
  if(homeRecog)try{homeRecog.stop();}catch(e){}
}


// ── VOICE AGENT (portal button) ──
let _agentRec=null,_agentRecording=false,_agentCollected='';

function agentTap(){
  // Разблокировка TTS на iOS — должна быть в обработчике жеста
  if(window.speechSynthesis&&!window._ttsPrimed){
    window._ttsPrimed=true;
    const u=new SpeechSynthesisUtterance('');u.volume=0;
    window.speechSynthesis.speak(u);
  }
  _agentRecording?stopAgentVoice():startAgentVoice();
}

let _agentAlts=[];
let _agentMediaRec=null;
let _agentAudioChunks=[];
let _agentAudioMime='audio/webm';

// ── AGENT VOICE — Whisper (основной) + Web Speech (fallback) ──
function startAgentVoice(){
  if(_agentRecording||_agentRec||_agentMediaRec)return;
  if(!CU){showToast('Сначала войдите в аккаунт');return;}
  // Используем Whisper если MediaRecorder доступен
  if(window.MediaRecorder&&navigator.mediaDevices?.getUserMedia){
    _startAgentVoiceWhisper();
  } else {
    _startAgentVoiceSR();
  }
}

async function _startAgentVoiceWhisper(){
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mimes=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
    _agentAudioMime=mimes.find(t=>MediaRecorder.isTypeSupported(t))||'';
    _agentAudioChunks=[];
    const opts=_agentAudioMime?{mimeType:_agentAudioMime}:{};
    _agentMediaRec=new MediaRecorder(stream,opts);
    if(!_agentAudioMime)_agentAudioMime=_agentMediaRec.mimeType||'audio/webm';

    _agentMediaRec.ondataavailable=e=>{if(e.data.size>0)_agentAudioChunks.push(e.data);};

    _agentMediaRec.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(_agentAudioChunks,{type:_agentAudioMime});
      _agentMediaRec=null;_agentRecording=false;

      if(blob.size<500){showToast('Не услышал — попробуйте ещё раз');_setAgentState('idle');return;}

      _setAgentState('transcribing');
      try{
        // blob → base64
        const base64=await new Promise((res,rej)=>{
          const reader=new FileReader();
          reader.onload=()=>res(reader.result.split(',')[1]);
          reader.onerror=rej;
          reader.readAsDataURL(blob);
        });
        const sess=await sb.auth.getSession();
        const token=sess?.data?.session?.access_token;
        if(!token){showToast('Войдите в аккаунт');_setAgentState('idle');return;}

        const res=await fetch(SUPABASE_EDGE_URL,{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
          body:JSON.stringify({action:'transcribe',payload:{audio_base64:base64,mime_type:_agentAudioMime}})
        });
        const data=await res.json();
        if(!res.ok||data.error){
          if(data.error==='GROQ_API_KEY not configured'){
            _startAgentVoiceSR();return;
          }
          // Логируем реальную ошибку для отладки
          console.error('[rz] Groq error:',data.groq_status,data.groq_error||data.error);
          showToast('Ошибка голоса — попробуйте ещё раз');
          _setAgentState('idle');return;
        }
        const text=(data.text||'').trim();
        if(!text){showToast('Не услышал — попробуйте ещё раз');_setAgentState('idle');return;}

        showToast('🎙 «'+text.slice(0,50)+(text.length>50?'…':'')+'»');
        _processAgentQuery(text,[]);
      }catch(e){
        console.error('Whisper transcription error:',e);
        showToast('Ошибка сети — попробуйте ещё раз');
        _setAgentState('idle');
      }
    };

    _agentMediaRec.start();
    _agentRecording=true;
    _setAgentState('listening');
  }catch(e){
    console.warn('MediaRecorder unavailable, falling back to SR:',e);
    _startAgentVoiceSR();
  }
}

// Fallback: старый Web Speech API
function _startAgentVoiceSR(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('Голосовой ввод не поддерживается');return;}
  _agentCollected='';_agentAlts=[];
  _agentRec=new SR();
  _agentRec.lang='ru-RU';_agentRec.continuous=true;_agentRec.interimResults=false;_agentRec.maxAlternatives=3;
  _agentRec.onstart=()=>{_agentRecording=true;_setAgentState('listening');};
  _agentRec.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(!e.results[i].isFinal)continue;
      _agentCollected+=(e.results[i][0].transcript||'');
      _agentAlts=Array.from(e.results[i]).slice(1,3).map(a=>a.transcript).filter(Boolean);
    }
  };
  _agentRec.onerror=e=>{
    if(e.error==='no-speech')return;
    showToast('Ошибка голоса: '+e.error);
    _agentRecording=false;_agentRec=null;_setAgentState('idle');
  };
  _agentRec.onend=()=>{
    _agentRecording=false;_agentRec=null;
    const text=_agentCollected.trim();
    if(text){
      showToast('🎙 «'+text.slice(0,50)+(text.length>50?'…':'')+'»');
      _processAgentQuery(text,_agentAlts);
    } else {
      showToast('Не услышал — попробуйте ещё раз');
      _setAgentState('idle');
    }
  };
  _agentRec.start();
}

function stopAgentVoice(){
  if(_agentMediaRec){try{_agentMediaRec.stop();}catch(e){}}
  else if(_agentRec){try{_agentRec.stop();}catch(e){}}
}

function _setAgentState(state){
  const btn=document.querySelector('.rz-portal');
  const lbl=document.getElementById('agent-lbl');
  btn?.classList.remove('agent-listening','agent-thinking');
  if(state==='listening'){
    btn?.classList.add('agent-listening');
    if(lbl){lbl.textContent='Слушаю...';lbl.style.opacity='1';}
  }else if(state==='transcribing'){
    btn?.classList.add('agent-thinking');
    if(lbl){lbl.textContent='Записываю...';lbl.style.opacity='1';}
  }else if(state==='thinking'){
    btn?.classList.add('agent-thinking');
    if(lbl){lbl.textContent='Разбираюсь...';lbl.style.opacity='1';}
  }else{
    if(lbl){lbl.textContent='';lbl.style.opacity='0';}
  }
}

async function _processAgentQuery(text,alts=[]){
  _setAgentState('thinking');

  // ── Таймаут агента: 30 сек, продление ещё на 30 сек ──
  const ac=new AbortController();
  let _abortTimer=null;
  let _warnTimer=null;
  function _armAbort(ms){clearTimeout(_abortTimer);_abortTimer=setTimeout(()=>ac.abort(),ms);}
  function _cleanTimers(){clearTimeout(_abortTimer);clearTimeout(_warnTimer);}

  // За 5 сек до аборта — предлагаем продлить
  _warnTimer=setTimeout(()=>{
    showActionToast('Агент думает… 🤔','Ещё 30 сек',()=>{_armAbort(30000);});
  },25000);
  _armAbort(30000);

  try{
    if(!sb){_cleanTimers();showToast('Нет подключения к серверу');_setAgentState('idle');return;}
    const sess=await sb.auth.getSession();
    const token=sess?.data?.session?.access_token;
    if(!token){_cleanTimers();showToast('Войдите в аккаунт — агент недоступен');_setAgentState('idle');return;}
    const memoryContext=getAiMemoryContext?.()??[];
    const _allNotes=getNotes();
    // Для запросов про планы/маршруты/сводку — передаём больше тела заметок
    const needsDeepCtx=/(план|маршрут|что у меня|сегодня|завтра|расскажи|составь|список дел|прочитай|озвучь)/i.test(text);
    const recentNotes=_allNotes.slice(0,30).map((n,i)=>({
      index:i,
      title:n.title||'Без названия',
      body:(n.body||n.items?.map(x=>x.text||x).join(', ')||'').slice(0,needsDeepCtx?300:100),
      hasReminder:!!n.reminder,
      isRecurring:!!n.recurring,
      reminderTime:n.reminder||null
    }));
    // Отправляем альтернативы только если они отличаются от основного текста
    const alternatives=alts.filter(a=>a&&a!==text).slice(0,2);
    // Разделы пользователя — агент знает куда предложить сохранить
    const userFolders=(getUserFolders?.()??[]).map(f=>f.name).filter(Boolean);
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'agent_query',payload:{text,alternatives,memoryContext,recentNotes,userFolders}}),
      signal:ac.signal
    });
    _cleanTimers();
    let data;
    try{data=await res.json();}catch(e){showToast('Ошибка ответа сервера');_setAgentState('idle');return;}
    _setAgentState('idle');
    if(!res.ok||data.error){showToast('Агент: '+(data.error||'ошибка '+res.status));return;}
    if(!data.intent){showToast('Агент не понял намерение');return;}
    _executeAgentIntent(data,text);
  }catch(e){
    _cleanTimers();
    _setAgentState('idle');
    if(e?.name==='AbortError'){showToast('Агент не успел ответить — попробуйте ещё раз');return;}
    showToast('Нет сети — '+String(e?.message||'').slice(0,40));
  }
}

function _executeAgentIntent(result,originalText){
  // Поддержка массива действий
  const actions=Array.isArray(result.actions)&&result.actions.length
    ?result.actions
    :[{intent:result.intent,params:result.params||{}}];
  actions.forEach(a=>_runSingleIntent(a.intent,a.params,originalText));

  const firstIntent=actions[0].intent;

  // Для удалений карточка не нужна — тост уже дал фидбек
  if(firstIntent==='DELETE_NOTE'||firstIntent==='DELETE_REMINDER')return;

  // options могут быть на верхнем уровне (старый формат) или внутри params первого action (CLARIFY в новом формате)
  const options=Array.isArray(result.options)&&result.options.length
    ?result.options
    :(Array.isArray(actions[0].params?.options)?actions[0].params.options:[]);

  _showAgentCardDebounced(firstIntent,result.response,actions[0].params,options);
}

function _runSingleIntent(intent,params,originalText){

  if(intent==='CREATE_NOTE'){
    const ts=Date.now();const notes=getNotes();const id=genId();
    const auto=analyzeText(params.body||originalText);
    const aiTags=[];
    if(params.section&&isUserFolderName?.(params.section)){
      aiTags.push(_filedFolderTag(params.section));
    }
    notes.push({id,title:params.title||auto.title,body:params.body||originalText,
      label:auto.label||'заметка',createdAt:ts,updatedAt:ts,fromPad:true,
      ...(aiTags.length?{aiTags}:{})});
    saveNotes(notes);loadHomeFeed();loadNotes();loadNotepad();
  }

  if(intent==='SET_REMINDER'){
    const ts=Date.now();const notes=getNotes();const id=genId();
    const body=params.body||originalText;
    const reminderTime=parseVoiceReminder(originalText)||parseVoiceReminder(params.when||'')||null;
    const auto=analyzeText(body);
    notes.push({id,title:params.title||auto.title,body,label:'заметка',
      reminder:reminderTime,  // parseVoiceReminder уже возвращает ISO
      createdAt:ts,updatedAt:ts});
    saveNotes(notes);
    if(reminderTime)_handleReminderAfterSave(reminderTime,id,params.title||auto.title,body.slice(0,200));
    loadHomeFeed();loadNotes();
  }

  if(intent==='DELETE_REMINDER'){
    const notes=getNotes();
    let count=0;
    const pat=(params.pattern||'').toLowerCase().trim();
    const byIdx=typeof params.noteIndex==='number';
    notes.forEach((n,i)=>{
      const match=byIdx?i===params.noteIndex:(pat&&(n.title||'').toLowerCase().includes(pat));
      if(match&&(n.reminder||n.recurring)){
        delete n.reminder;delete n.recurring;n.updatedAt=Date.now();count++;
      }
    });
    if(count){saveNotes(notes);scheduleAll();loadHomeFeed();loadNotes();
      showToast(count===1?'Напоминание удалено':'Удалено напоминаний: '+count);}
    else showToast('Напоминание не найдено');
  }

  if(intent==='DELETE_NOTE'){
    let notes=getNotes();
    const trash=getTrash();
    let count=0;
    const pat=(params.pattern||'').toLowerCase().trim();
    const byIdx=typeof params.noteIndex==='number';
    const toDelete=notes.filter((n,i)=>
      byIdx?i===params.noteIndex:(pat&&(n.title||'').toLowerCase().includes(pat))
    );
    toDelete.forEach(n=>{n._deletedAt=Date.now();trash.unshift(n);count++;});
    if(count){
      notes=notes.filter((n,i)=>
        byIdx?i!==params.noteIndex:!(pat&&(n.title||'').toLowerCase().includes(pat))
      );
      if(trash.length>50)trash.length=50;
      saveNotes(notes);saveTrash(trash);
      toDelete.forEach(n=>{if(n.reminder)_deleteReminderFromServer(n.id);});
      scheduleAll();
      loadNotes();loadHomeFeed();loadNotepad();updTrashBadge();
      showToast(count===1?'Заметка в корзине':'В корзину: '+count+' заметок');
    } else showToast('Заметка не найдена');
  }

  if(intent==='CREATE_TAG_FOLDER'){
    const tag=(params.tag||params.label||'').toLowerCase().trim();
    const label=params.label||tag;
    if(tag&&typeof getTagFolders==='function'){
      const folders=getTagFolders();
      if(!folders.some(f=>f.tag===tag)){
        folders.push({tag,label,createdAt:Date.now()});
        saveTagFolders(folders);
        loadNotes(); // обновить список папок
      }
    }
  }

  if(intent==='SET_RECURRING'){
    const title=params.title||originalText;
    const times=Array.isArray(params.times)&&params.times.length?params.times:['09:00'];
    const nextTs=_nextRecurringTime(times);
    const notes=getNotes();
    // Не создавать дубль — если уже есть повторяющаяся заметка с таким названием, обновить её
    const existIdx=notes.findIndex(n=>n.recurring&&(n.title||'').toLowerCase().trim()===(title||'').toLowerCase().trim());
    if(existIdx>=0){
      notes[existIdx].recurring={times,days:params.days||'daily'};
      notes[existIdx].reminder=_tsToIso(nextTs);
      notes[existIdx].updatedAt=Date.now();
      saveNotes(notes);
      _handleReminderAfterSave(nextTs,notes[existIdx].id,title,title);
    } else {
      const ts=Date.now();const id=genId();
      notes.push({id,title,body:title,label:'заметка',
        reminder:_tsToIso(nextTs),recurring:{times,days:params.days||'daily'},
        createdAt:ts,updatedAt:ts});
      saveNotes(notes);
      _handleReminderAfterSave(nextTs,id,title,title);
    }
    loadHomeFeed();loadNotes();
  }

  if(intent==='OPEN_NOTE'||intent==='ANALYZE_NOTE'){
    const idx=typeof params.noteIndex==='number'?params.noteIndex:0;
    const notes=getNotes();
    const note=notes[idx];
    if(note){
      // Закрываем карточку сразу, затем открываем заметку
      setTimeout(()=>{
        if(note.id)openNoteSheetById(note.id);
        else openNoteSheet(idx);
        // Для ANALYZE — запускаем AI через 400ms после открытия
        if(intent==='ANALYZE_NOTE'){
          setTimeout(()=>{
            if(!_aiOn)toggleAiPanel();
          },400);
        }
      },300);
    } else {
      showToast('Заметка не найдена');
    }
  }

  if(intent==='TAG_NOTE'){
    const tag=(params.tag||'').toLowerCase().trim();
    const idx=typeof params.noteIndex==='number'?params.noteIndex:0;
    if(tag){
      const notes=getNotes();
      const note=notes[idx];
      if(note){
        if(!Array.isArray(note.aiTags))note.aiTags=[];
        if(!note.aiTags.map(t=>t.toLowerCase()).includes(tag)){
          note.aiTags=[...note.aiTags,tag];
          note.updatedAt=Date.now();
          saveNotes(notes);loadHomeFeed();loadNotes();
        }
        // Создать тег-папку если нет
        if(typeof getTagFolders==='function'){
          const folders=getTagFolders();
          if(!folders.some(f=>f.tag===tag)){
            folders.push({tag,label:params.tag||tag,createdAt:Date.now()});
            saveTagFolders(folders);
          }
        }
      }
    }
  }

  if(intent==='FIND_NOTES'){
    const q=(params.query||'').trim();
    if(q){
      // Небольшая задержка чтобы карточка агента не конкурировала с оверлеем
      setTimeout(()=>openSearch(q),350);
    }
  }

  if(intent==='READ_NOTE_ALOUD'){
    const idx=typeof params.noteIndex==='number'?params.noteIndex:0;
    const note=getNotes()[idx];
    if(note){
      const content=(note.body||note.items?.map(x=>x.text||x).join('. ')||note.title||'').slice(0,500);
      // Озвучиваем через небольшую задержку чтобы карточка успела появиться
      setTimeout(()=>_agentSpeak(content||note.title),400);
    }
  }

  if(intent==='MAKE_PLAN'&&params.saveAsNote){
    // Агент явно просит сохранить план — создадим заметку
    const planText=params.planText||'';
    if(planText&&planText.length>10){
      const ts=Date.now();const id=genId();const notes=getNotes();
      notes.unshift({id,title:params.title||'План',body:planText,label:'заметка',createdAt:ts,updatedAt:ts});
      saveNotes(notes);loadHomeFeed();loadNotes();
    }
  }

}

function _agentPickOption(query){
  document.getElementById('agent-card')?.remove();
  if(query)_processAgentQuery(query);
}

// ── TTS — озвучка ответа агента ──
function _agentSpeak(text){
  if(!text||!window.speechSynthesis)return;
  window.speechSynthesis.cancel();
  const utt=new SpeechSynthesisUtterance(text.slice(0,300));
  utt.lang='ru-RU';utt.rate=0.92;utt.pitch=1.05;
  // Выбрать русский голос если есть
  const voices=window.speechSynthesis.getVoices();
  const ruVoice=voices.find(v=>v.lang.startsWith('ru'));
  if(ruVoice)utt.voice=ruVoice;
  window.speechSynthesis.speak(utt);
}

let _agentCardTimer=null;
function _showAgentCardDebounced(intent,response,params,options){
  // Если уже есть карточка ожидающая показа — заменяем на новую (агент выдал лучший ответ)
  if(_agentCardTimer){clearTimeout(_agentCardTimer);}
  const needsImmediate=['CLARIFY','QUESTION','FIND_DOCTOR','MAKE_PLAN','DAILY_BRIEFING']; // требуют ответа — сразу
  const delay=needsImmediate.includes(intent)?0:1200;
  _agentCardTimer=setTimeout(()=>{_agentCardTimer=null;_showAgentCard(intent,response,params,options);},delay);
}
function _showAgentCard(intent,response,params,options){
  document.getElementById('agent-card')?.remove();
  const icons={CREATE_NOTE:'📝',SET_REMINDER:'🔔',SET_RECURRING:'🔁',CLARIFY:'🤔',CREATE_TAG_FOLDER:'🗂',TAG_NOTE:'🏷',OPEN_NOTE:'📖',ANALYZE_NOTE:'🔍',QUESTION:'💬',FIND_DOCTOR:'🏥',READ_NOTE_ALOUD:'🔊',DAILY_BRIEFING:'📅',MAKE_PLAN:'🗺',FIND_NOTES:'🔎'};
  const hasOpts=Array.isArray(options)&&options.length>0;
  // Не закрываем автоматически если есть варианты выбора — пользователь должен успеть нажать
  const autoClose=!hasOpts&&!['QUESTION','FIND_DOCTOR','CLARIFY','MAKE_PLAN','DAILY_BRIEFING','READ_NOTE_ALOUD','CREATE_TAG_FOLDER'].includes(intent);

  // ── КНОПКИ НАВИГАЦИИ — ведут к тому что агент только что создал/нашёл ──
  let openBtn='';

  if(intent==='CREATE_NOTE'){
    // Если заметка сразу попала в раздел — ведём туда
    if(params?.section){
      openBtn=`<button class="agent-card-open" onclick="_agentOpenFolder(${jsAttr(params.section)})">Открыть в «${esc(String(params.section).slice(0,25))}»</button>`;
    } else {
      // Ведём к самой свежей заметке (index 0 после prepend)
      const newNote=getNotes()[0];
      const noteTitle=newNote?.title||'заметку';
      const noteId=newNote?.id||'';
      openBtn=noteId
        ?`<button class="agent-card-open" onclick="document.getElementById('agent-card')?.remove();openNoteSheetById(${jsAttr(noteId)})">Открыть «${esc(noteTitle.slice(0,28))}»</button>`
        :`<button class="agent-card-open" onclick="_agentOpenNote(0)">Открыть заметку</button>`;
    }
  } else if(['SET_REMINDER','SET_RECURRING'].includes(intent)){
    const newNote=getNotes()[0];
    const noteTitle=newNote?.title||'напоминание';
    const noteId=newNote?.id||'';
    openBtn=noteId
      ?`<button class="agent-card-open" onclick="document.getElementById('agent-card')?.remove();openNoteSheetById(${jsAttr(noteId)})">Открыть «${esc(noteTitle.slice(0,28))}»</button>`
      :`<button class="agent-card-open" onclick="_agentOpenNote(0)">Открыть напоминание</button>`;
  } else if(['OPEN_NOTE','ANALYZE_NOTE','TAG_NOTE','READ_NOTE_ALOUD'].includes(intent)&&typeof params?.noteIndex==='number'){
    const noteTitle=getNotes()[params.noteIndex]?.title||'заметку';
    openBtn=`<button class="agent-card-open" onclick="_agentOpenNote(${params.noteIndex})">Открыть «${esc(noteTitle.slice(0,28))}»</button>`;
  } else if(intent==='FIND_NOTES'&&typeof params?.noteIndex==='number'){
    const noteTitle=getNotes()[params.noteIndex]?.title||'заметку';
    openBtn=`<button class="agent-card-open" onclick="_agentOpenNote(${params.noteIndex})">Перейти к «${esc(noteTitle.slice(0,28))}»</button>`;
  }

  // CREATE_TAG_FOLDER — открыть папку + промоут в архив
  let openFolderBtn='';
  let promoteBtn='';
  if(intent==='CREATE_TAG_FOLDER'&&params?.tag){
    const folderLabel=params.label||params.tag;
    openFolderBtn=`<button class="agent-card-open" onclick="_agentOpenFolder(${jsAttr(params.tag)})">Открыть «${esc(String(folderLabel).slice(0,25))}»</button>`;
    promoteBtn=`<button class="agent-card-promote" onclick="promoteToSection(${jsAttr(params.tag)});this.closest('.agent-card').remove();">📚 В Архив</button>`;
  }

  // Кнопка «Сохранить план» для MAKE_PLAN
  let savePlanBtn='';
  if(intent==='MAKE_PLAN'&&response&&response.length>20){
    savePlanBtn=`<button class="agent-card-open" onclick="_agentSavePlan(${jsAttr(response)})">Сохранить план</button>`;
  }

  const isClarify=intent==='CLARIFY';

  // Кнопки-опции
  const optBtns=hasOpts
    ?'<div class="agent-card-opts'+(isClarify?' agent-card-opts--clarify':'')+'">'+
      options.map(o=>`<button class="agent-card-opt" onclick="_agentPickOption(${jsAttr(o.query||o.label)})">${esc(o.label)}</button>`).join('')+
      '</div>'
    :'';

  // Для CLARIFY: только варианты + мелкая «Отмена»; для остальных — кнопка «Готово»
  const closeBtn=isClarify
    ?`<button class="agent-card-cancel" onclick="this.closest('.agent-card').classList.remove('show');setTimeout(()=>this.closest('.agent-card')?.remove(),380)">Отмена</button>`
    :`<button class="agent-card-btn" onclick="this.closest('.agent-card').classList.remove('show');setTimeout(()=>this.closest('.agent-card')?.remove(),380)">Готово</button>`;

  const card=document.createElement('div');
  card.id='agent-card';card.className='agent-card';
  const speakBtn=window.speechSynthesis
    ?`<button class="agent-card-speak" onclick="_agentSpeak(${jsAttr(response)})" title="Озвучить">🔊</button>`:'';
  card.innerHTML=`<div class="agent-card-inner">
    <div class="agent-card-head">
      <div class="agent-card-ico">${icons[intent]||'✦'}</div>
      ${speakBtn}
    </div>
    <div class="agent-card-txt">${esc(response)}</div>
    ${optBtns}
    ${openBtn}
    ${openFolderBtn}
    ${savePlanBtn}
    ${promoteBtn}
    ${closeBtn}
  </div>`;
  // Клик на затемнённый фон = закрыть (только для autoClose карточек)
  if(autoClose){
    card.addEventListener('click',e=>{if(e.target===card){card.classList.remove('show');setTimeout(()=>card.remove(),380);}},{passive:true});
  }
  document.body.appendChild(card);
  requestAnimationFrame(()=>card.classList.add('show'));
  if(autoClose)setTimeout(()=>{card.classList.remove('show');setTimeout(()=>card.remove(),380);},7000);
}

// Переход к папке или разделу из карточки агента
function _agentOpenFolder(tag){
  document.getElementById('agent-card')?.remove();
  go('notes');
  // Небольшая пауза чтобы секция успела активироваться
  setTimeout(()=>{drillGo(1,{aiTag:tag});},160);
}

function _agentOpenNote(idx){
  document.getElementById('agent-card')?.remove();
  const notes=getNotes();
  const note=notes[idx];
  if(!note)return;
  if(note.id)openNoteSheetById(note.id);
  else openNoteSheet(idx);
}

// ── SEARCH ──────────────────────────────────────────────────────────────────
let _searchTimer=null;

function openSearch(prefill){
  const ov=document.getElementById('search-overlay');
  if(!ov)return;
  ov.classList.add('show');
  const inp=document.getElementById('search-input');
  if(inp){
    inp.value=prefill||'';
    setTimeout(()=>inp.focus(),100);
    if(prefill)onSearchInput(prefill);
  }
}

function closeSearch(){
  const ov=document.getElementById('search-overlay');
  if(!ov)return;
  ov.classList.remove('show');
  const inp=document.getElementById('search-input');
  if(inp)inp.value='';
  const res=document.getElementById('search-results');
  if(res)res.innerHTML='<div class="search-hint">Начни вводить — найду по тексту, тегам и смыслу</div>';
}

function onSearchInput(q){
  clearTimeout(_searchTimer);
  _searchTimer=setTimeout(()=>_renderSearch(q.trim()),120);
}

function _searchNotes(q){
  if(!q||q.length<2)return{active:[],trash:[]};
  const lq=q.toLowerCase();
  function match(n){
    return (n.title||'').toLowerCase().includes(lq)
      ||(n.body||'').toLowerCase().includes(lq)
      ||(n.aiSummary||'').toLowerCase().includes(lq)
      ||(n.aiTags||[]).filter(t=>!_isFiledFolderTag(t)).some(t=>t.toLowerCase().includes(lq))
      ||(n.items||[]).some(i=>(i.t||i.text||'').toLowerCase().includes(lq));
  }
  function sortFn(arr){
    return arr.filter(match).sort((a,b)=>{
      const at=(a.title||'').toLowerCase().includes(lq)?1:0;
      const bt=(b.title||'').toLowerCase().includes(lq)?1:0;
      if(at!==bt)return bt-at;
      return(b.updatedAt||0)-(a.updatedAt||0);
    });
  }
  return{
    active:sortFn(getNotes()).slice(0,25),
    trash:sortFn(getTrash()).slice(0,5)
  };
}

function _hl(text,q){
  if(!text||!q)return esc(text||'');
  const idx=text.toLowerCase().indexOf(q.toLowerCase());
  if(idx<0)return esc(text);
  return esc(text.slice(0,idx))+'<mark class="sr-hl">'+esc(text.slice(idx,idx+q.length))+'</mark>'+esc(text.slice(idx+q.length));
}

function _renderSearch(q){
  const res=document.getElementById('search-results');
  if(!res)return;
  if(!q||q.length<2){
    res.innerHTML='<div class="search-hint">Начни вводить — найду по тексту, тегам и смыслу</div>';
    return;
  }
  const{active,trash}=_searchNotes(q);
  if(!active.length&&!trash.length){
    res.innerHTML='<div class="search-none">Ничего не нашёл по «'+esc(q)+'»</div>';
    return;
  }
  function renderItem(n,inTrash){
    const previewBody=(n.body||(n.items||[]).map(i=>i.t||i.text||'').join(' ')||'').slice(0,120);
    const tags=(n.aiTags||[]).filter(t=>!_isFiledFolderTag(t)).slice(0,3).map(t=>`<span class="sr-tag">${esc(t)}</span>`).join('');
    const clickFn=inTrash?`closeSearch();go('trash')`:`closeSearch();openNoteSheetById(${JSON.stringify(n.id)})`;
    return `<div class="sr-item${inTrash?' sr-item--trash':''}" onclick="${clickFn}">
      <div class="sr-title">${inTrash?'<span class="sr-trash-ico">🗑</span>':''}${_hl(n.title||'Без названия',q)}</div>
      ${previewBody?`<div class="sr-body">${_hl(previewBody,q)}</div>`:''}
      ${tags?`<div class="sr-tags">${tags}</div>`:''}
    </div>`;
  }
  let html=active.map(n=>renderItem(n,false)).join('');
  if(trash.length){
    html+=`<div class="sr-sep">В корзине:</div>`;
    html+=trash.map(n=>renderItem(n,true)).join('');
  }
  res.innerHTML=html;
}

function _agentSavePlan(planText){
  document.getElementById('agent-card')?.remove();
  if(!planText||planText.length<5)return;
  const ts=Date.now();const id=genId();const notes=getNotes();
  const title='План — '+new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  notes.unshift({id,title,body:planText,label:'заметка',createdAt:ts,updatedAt:ts});
  saveNotes(notes);loadHomeFeed();loadNotes();
  showToast('✅ План сохранён в заметки');
  setTimeout(()=>openNoteSheetById(id),300);
}

// ── CLEANUP PAST REMINDERS ──
// Убирает просроченные не-повторяющиеся напоминания из заметок и с сервера
async function _cleanupPastReminders(){
  try{
    const now=Date.now();
    const notes=getNotes();
    let dirty=false;
    const toDelete=[];
    notes.forEach(n=>{
      if(!n.reminder)return;
      const dt=parseDt(n.reminder);if(!dt)return;
      // Если прошло более 5 минут и напоминание не повторяющееся — чистим
      if(dt.getTime()<now-5*60*1000&&!n.recurring?.times?.length){
        n.reminder=null;n.updatedAt=Date.now();
        dirty=true;toDelete.push(n.id);
      }
    });
    if(dirty){
      saveNotes(notes);
      toDelete.forEach(id=>_deleteReminderFromServer(id));
      updateReminderDot();
      if(document.getElementById('remind-overlay')?.classList.contains('open'))renderReminderPanel();
      console.log('🧹 Cleared',toDelete.length,'past reminder(s)');
    }
  }catch(e){console.warn('_cleanupPastReminders error',e);}
}

// ── LOAD ALL ──
function loadAll(){
  _deduplicateRecurringNotes();
  loadHomeFeed();
  loadNotes();
  loadNotepad();
  updTrashBadge();
  if('requestIdleCallback'in window){
    requestIdleCallback(()=>{_cleanupPastReminders();scheduleAll();calRender();updCalTrigger();updateReminderDot();checkDueReminders();});
  } else {
    setTimeout(()=>{_cleanupPastReminders();scheduleAll();calRender();updCalTrigger();updateReminderDot();checkDueReminders();},200);
  }
}

// ── SERVICE WORKER ──
window.addEventListener('load',()=>{
  if(!('serviceWorker'in navigator))return;
  navigator.serviceWorker.register('sw.js').then(reg=>{
    // Принудительно проверяем обновление SW при каждом запуске
    // Это критично для iOS PWA — иначе кэш может не обновляться сутками
    reg.update().catch(()=>{});
    // updatefound → НЕ перезагружаем здесь.
    // skipWaiting() в sw.js → controllerchange → одна перезагрузка ниже.
    // Без этого было две перезагрузки подряд (мигание при каждом обновлении).
  }).catch(()=>{});

  // Единственный reload — когда новый SW взял управление (после skipWaiting).
  // refreshing — флаг на текущую страницу, предотвращает двойной вызов.
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(refreshing)return;
    refreshing=true;
    window.location.reload();
  });
});

// ── INIT ──
// Лого появляется только когда Playfair Display загружен — без джерка font-swap.
// document.fonts.load() запускает загрузку и резолвит как только шрифт готов.
(function(){
  const _showWordmark=()=>{
    const wm=document.querySelector('.auth-wordmark');
    if(wm&&!document.getElementById('auth-screen').classList.contains('gone'))
      wm.classList.add('wm-ready');
  };
  if(document.fonts&&document.fonts.load){
    document.fonts.load('400 49px "Playfair Display"')
      .then(_showWordmark).catch(_showWordmark);
  } else {
    // Старый браузер без Font Loading API — показываем через 300ms
    setTimeout(_showWordmark,300);
  }
})();

initAuth();
