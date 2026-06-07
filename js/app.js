const SUPABASE_URL='https://izvwgyudjbxlixzrgpuv.supabase.co';
const SUPABASE_ANON_KEY='sb_publishable_YtwehFnevo4R3UpmOnTTXQ_j4PQY21D';
const sbConfigured=/^https:\/\//.test(SUPABASE_URL)&&SUPABASE_ANON_KEY&&!SUPABASE_ANON_KEY.startsWith('PASTE_');
const sb=sbConfigured&&window.supabase?window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
  auth:{detectSessionInUrl:true,persistSession:true,autoRefreshToken:true,flowType:'pkce'}
}):null;

let CU=null,ST=null,EI=null;
let CLOUD_READY_UID=null,CLOUD_SAVE_TIMER=null,CLOUD_LOADING=false,CLOUD_SAVE_PENDING=false;
let _cardSwiping=false; // флаг: карточка перехватила свайп, подавить навигацию

function userScope(){return CU&&CU.id?CU.id:'signed-out';}
function scopedKey(key){return key.startsWith('rz_')?'rz_'+userScope()+'_'+key.slice(3):key;}
function readJson(key,fallback){try{const raw=localStorage.getItem(scopedKey(key));return raw?JSON.parse(raw):fallback;}catch(e){return fallback;}}
function writeJson(key,value){localStorage.setItem(scopedKey(key),JSON.stringify(value));queueCloudSave();}
function readText(key){return localStorage.getItem(scopedKey(key))||'';}
function writeText(key,value){localStorage.setItem(scopedKey(key),String(value||''));queueCloudSave();}
function migrateLegacyLocal(){['rz_notes','rz_trash','rz_history','rz_name','rz_tag_folders'].forEach(key=>{const target=scopedKey(key);if(localStorage.getItem(target)!==null)return;const legacy=localStorage.getItem(key);if(legacy!==null)localStorage.setItem(target,legacy);});}

const IDEA_TAG='идея';
const IDEA_INBOX_LABEL='Входящие';
const IDEA_TAG_ALIASES=new Set(['идея','идеи','idea','ideas','idei','ideya','ideja']);
function _cleanTag(raw){return String(raw||'').replace(/^#/,'').trim();}
function _tagKey(raw){
  const clean=_cleanTag(raw).toLowerCase().replace(/\s+/g,'_');
  return IDEA_TAG_ALIASES.has(clean)?IDEA_TAG:clean;
}
function tagKey(raw){return _tagKey(raw);}
function normalizeIdeaTag(raw){
  const clean=_cleanTag(raw);
  if(!clean)return '';
  return _tagKey(clean)===IDEA_TAG?IDEA_TAG:clean;
}
function isIdeaTag(raw){return _tagKey(raw)===IDEA_TAG;}
function normalizeAiTags(tags){
  if(!Array.isArray(tags))return [];
  const seen=new Set();
  const out=[];
  tags.forEach(raw=>{
    const clean=_cleanTag(raw);
    if(!clean)return;
    const normalized=clean.startsWith('_filed_in:')?clean:normalizeIdeaTag(clean);
    const key=clean.startsWith('_filed_in:')?clean.toLowerCase():_tagKey(normalized);
    if(seen.has(key))return;
    seen.add(key);out.push(normalized);
  });
  return out;
}
function _sameTags(a,b){
  const aa=Array.isArray(a)?a:[];
  const bb=Array.isArray(b)?b:[];
  return aa.length===bb.length&&aa.every((v,i)=>v===bb[i]);
}
function _noteHasAiTag(note,tag){
  const key=_tagKey(tag);
  return !!key&&Array.isArray(note?.aiTags)&&note.aiTags.some(t=>_tagKey(t)===key);
}
function _noteHasIdea(note){
  return isIdeaTag(note?.label)||_noteHasAiTag(note,IDEA_TAG);
}
function _noteToneClass(note){
  return _noteHasIdea(note)?' idea-note':'';
}
function _notePreviewTags(note,{limit=3,currentTag=''}={}){
  const tags=normalizeAiTags(note?.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
  const currentKey=_tagKey(currentTag||'');
  const out=[];
  const push=tag=>{
    const clean=normalizeIdeaTag(tag);
    if(!clean)return;
    if(!out.some(t=>_tagKey(t)===_tagKey(clean)))out.push(clean);
  };
  tags.filter(tag=>!currentKey||_tagKey(tag)!==currentKey).forEach(push);
  if(!out.length)tags.forEach(push);
  const label=safeLabel(note?.label||'заметка');
  if(label&&label!=='заметка'&&!out.some(t=>_tagKey(t)===_tagKey(label)))out.unshift(label);
  return out.slice(0,limit);
}
function textLooksLikeIdea(text){
  return /^\s*(?:есть\s+)?иде[яи](?:[^а-яёa-zA-Z]|$)/i.test(String(text||'').trim());
}
function _hasIdeaContext({text,tags,label}={}){
  return isIdeaTag(label)||normalizeAiTags(tags||[]).some(isIdeaTag)||textLooksLikeIdea(text);
}
function normalizeTagFolderList(arr){
  if(!Array.isArray(arr))return [];
  const out=[];
  arr.forEach(item=>{
    if(!item)return;
    const rawTag=item.tag||item.label||'';
    const key=_tagKey(rawTag);
    if(!key)return;
    const label=isIdeaTag(rawTag)?IDEA_INBOX_LABEL:(_cleanTag(item.label||item.tag)||key);
    const existing=out.find(f=>_tagKey(f.tag)===key);
    if(existing){
      existing.label=existing.label||label;
      existing.pinned=!!(existing.pinned||item.pinned);
      existing.createdAt=Math.min(existing.createdAt||Date.now(),item.createdAt||Date.now());
      return;
    }
    out.push({...item,tag:key,label});
  });
  return out;
}
function _sameJson(a,b){return JSON.stringify(a||[])===JSON.stringify(b||[]);}
function _mergeByKey(local,cloud,keyFn,mergeFn){
  const out=[];
  const put=item=>{
    const key=keyFn(item);
    if(!key)return;
    const existing=out.find(x=>keyFn(x)===key);
    if(existing)Object.assign(existing,mergeFn(existing,item));
    else out.push({...item});
  };
  (Array.isArray(local)?local:[]).forEach(put);
  (Array.isArray(cloud)?cloud:[]).forEach(put);
  return out;
}
function _mergeUserFolderList(local,cloud){
  const merged=_mergeByKey(local,cloud,item=>String(item?.name||'').trim().toLowerCase(),(a,b)=>({
    ...a,...b,
    name:a.name||b.name,
    // Берём наименьший idx — созданный раньше имеет приоритет
    idx:Math.min(
      a.idx!==undefined?a.idx:Infinity,
      b.idx!==undefined?b.idx:Infinity
    ),
    createdAt:Math.min(a.createdAt||Date.now(),b.createdAt||Date.now())
  }));
  // Сортируем по idx чтобы порядок был одинаковым на всех устройствах
  return merged
    .map((folder,i)=>({...folder,idx:isFinite(folder.idx)?folder.idx:i}))
    .sort((a,b)=>a.idx-b.idx);
}
function _mergeTagFolderList(local,cloud){
  return normalizeTagFolderList(_mergeByKey(
    normalizeTagFolderList(local),
    normalizeTagFolderList(cloud),
    item=>_tagKey(item?.tag||item?.label||''),
    (a,b)=>({
      ...a,...b,
      tag:_tagKey(a.tag||b.tag),
      label:isIdeaTag(a.tag||b.tag)?IDEA_INBOX_LABEL:(b.label||a.label||b.tag||a.tag),
      pinned:!!(a.pinned||b.pinned),
      createdAt:Math.min(a.createdAt||Date.now(),b.createdAt||Date.now())
    })
  ));
}
function getNotes(){
  const notes=readJson('rz_notes',[]);
  // Миграция: назначаем id заметкам без него (старые заметки)
  let dirty=false;
  notes.forEach(n=>{
    if(!n.id){n.id=genId();dirty=true;}
    const normalizedTags=normalizeAiTags(n.aiTags||[]);
    if(!_sameTags(n.aiTags||[],normalizedTags)){n.aiTags=normalizedTags;dirty=true;}
    if(isIdeaTag(n.label)&&!normalizedTags.some(isIdeaTag)){
      n.aiTags=normalizeAiTags([...normalizedTags,IDEA_TAG]);dirty=true;
    }
  });
  if(dirty)writeJson('rz_notes',notes);
  return notes;
}
function saveNotes(notes){writeJson('rz_notes',notes);}
function getTrash(){return readJson('rz_trash',[]);}
function saveTrash(trash){writeJson('rz_trash',trash);}
function getHistory(){return readJson('rz_history',[]);}
function saveHistory(hist){writeJson('rz_history',hist);}

// Удалены: _noteToRow, _rowToNote, _migrateNotesToTable, _syncFromNotesTable, _syncNotesToTable
// Единственный источник правды — user_state. Таблица notes больше не используется.
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
// Timestamp последнего успешного cloud-push (ISO string)
function _getLocalSyncedAt(){return localStorage.getItem('rz_folders_synced_at')||'';}
function _setLocalSyncedAt(ts){if(ts)localStorage.setItem('rz_folders_synced_at',ts);}

// Простой last-write-wins: если облако новее нашего последнего пуша — берём папки с облака.
// Для личного приложения этого достаточно: один пользователь редко меняет папки одновременно на двух устройствах.
function _mergeCloudFolders(cloudUserFolders,cloudTagFolders,cloudUpdatedAt){
  let changed=false;
  const localSyncedAt=_getLocalSyncedAt();
  const cloudIsNewer=!localSyncedAt||(cloudUpdatedAt&&cloudUpdatedAt>localSyncedAt);

  if(cloudIsNewer){
    if(Array.isArray(cloudUserFolders)){
      const local=getUserFolders();
      // Если облако пустое, а локально есть данные — доверяем локальным
      const next=cloudUserFolders.length===0&&local.length>0?local:_mergeUserFolderList(local,cloudUserFolders);
      if(!_sameJson(local,next)){localStorage.setItem(scopedKey('rz_user_folders'),JSON.stringify(next));changed=true;}
    }
    if(Array.isArray(cloudTagFolders)&&typeof getTagFolders==='function'){
      const localTags=getTagFolders();
      const next=cloudTagFolders.length===0&&localTags.length>0?localTags:_mergeTagFolderList(localTags,cloudTagFolders);
      if(!_sameJson(localTags,next)){localStorage.setItem(scopedKey('rz_tag_folders'),JSON.stringify(next));changed=true;}
    }
  } else {
    // Локальное новее — пушим в облако
    queueCloudSave();
  }
  return changed;
}
// Мусорный тег: односимвольный, повтор одной буквы (ооо, ааа), без букв/цифр.
// Системные "идея" и "_filed_in:" — не трогаем.
function _isJunkTag(tag){
  const t=String(tag||'').trim().toLowerCase();
  if(!t)return true;
  if(isIdeaTag(t)||t.startsWith('_filed_in:'))return false;
  if(t.length<2)return true;
  const uniq=new Set(t.replace(/\s/g,'').split(''));
  if(uniq.size<=1)return true;           // "ооо", "аа", "жжжж"
  if(!/[\p{L}\p{N}]/u.test(t))return true; // нет ни одной буквы/цифры
  return false;
}
function _ensureIdeaInboxTagFolder(notes){
  if(typeof getTagFolders!=='function'||typeof saveTagFolders!=='function')return typeof getTagFolders==='function'?getTagFolders():[];
  let folders=getTagFolders();
  // Чистим мусорные тег-папки (ооо и пр.) и проталкиваем в облако, чтобы не возвращались
  const cleaned=folders.filter(f=>!_isJunkTag(f.tag));
  if(cleaned.length!==folders.length){
    folders=cleaned;
    saveTagFolders(folders);
    if(typeof queueCloudSave==='function')queueCloudSave();
  }
  // Папка уже есть (пришла с облака или создана ранее) — просто возвращаем
  if(folders.some(f=>isIdeaTag(f.tag)))return folders;
  // Создаём только если есть хотя бы одна заметка с тегом идея
  const list=Array.isArray(notes)?notes:getNotes();
  if(!list.some(_noteHasIdea))return folders;
  const next=normalizeTagFolderList([...folders,{tag:IDEA_TAG,label:IDEA_INBOX_LABEL,system:true,createdAt:Date.now()}]);
  saveTagFolders(next);
  return next;
}
// Применить данные из облака в localStorage. Merge по id — офлайн-заметки не теряются.
function _applyCloudData(data){
  if(!data)return false;
  if(Array.isArray(data.notes)){
    const local=getNotes();
    const merged=_mergeNoteArrays(local,data.notes);
    localStorage.setItem(scopedKey('rz_notes'),JSON.stringify(merged));
    // Если в локале были заметки которых нет в облаке (офлайн) — пушим обратно
    if(merged.length>data.notes.length)queueCloudSave();
  }
  if(Array.isArray(data.trash)){
    const merged=_mergeTrashArrays(getTrash(),data.trash);
    localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(merged));
  }
  if(Array.isArray(data.history))localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
  if(Array.isArray(data.ai_memory))localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
  _mergeCloudFolders(data.user_folders,data.tag_folders,data.updated_at);
  if(typeof data.name==='string')localStorage.setItem(scopedKey('rz_name'),data.name);
  return true;
}

async function loadCloudData(){
  if(!cloudAllowed()||CLOUD_READY_UID===CU.id)return;
  CLOUD_LOADING=true;
  const _finish=()=>{CLOUD_LOADING=false;if(CLOUD_SAVE_PENDING){CLOUD_SAVE_PENDING=false;queueCloudSave();}};
  const _fetch=async()=>{
    const{data,error}=await sb.from('user_state')
      .select('*')
      .eq('user_id',CU.id).maybeSingle();
    if(error)throw error;
    return data;
  };
  try{
    const data=await _fetch();
    if(data){_applyCloudData(data);}
    else if(getNotes().length||getTrash().length||getHistory().length||getAiMemory().length||readText('rz_name')){
      await saveCloudNow();
    }
    CLOUD_READY_UID=CU.id;
    _finish();
  }catch(e){
    _finish();
    setTimeout(async()=>{
      if(CLOUD_READY_UID===CU?.id)return;
      CLOUD_LOADING=true;
      try{
        const data=await _fetch();
        if(_applyCloudData(data))loadAll();
        CLOUD_READY_UID=CU?.id;
      }catch(e2){console.warn('[rz:sync] load failed (attempt 2)',e2);}
      finally{_finish();}
    },800);
  }
}
function queueCloudSave(){
  if(!cloudAllowed())return;
  if(CLOUD_LOADING){CLOUD_SAVE_PENDING=true;return;}
  clearTimeout(CLOUD_SAVE_TIMER);
  CLOUD_SAVE_TIMER=setTimeout(saveCloudNow,700);
}
async function saveCloudNow(){
  if(!cloudAllowed())return;
  try{
    const payload={user_id:CU.id,notes:getNotes(),trash:getTrash(),history:getHistory(),ai_memory:getAiMemory(),user_folders:getUserFolders(),tag_folders:typeof getTagFolders==='function'?getTagFolders():[],name:readText('rz_name'),updated_at:new Date().toISOString()};
    const{error}=await sb.from('user_state').upsert(payload,{onConflict:'user_id'});
    if(error)throw error;
    _setLocalSyncedAt(payload.updated_at);
    // Broadcast: сигналим другим устройствам что данные обновились
    // Не ждём postgres_changes — устройство само говорит «я сохранил»
    if(_realtimeChannel){
      _realtimeChannel.send({type:'broadcast',event:'saved',payload:{at:payload.updated_at}}).catch(()=>{});
    }
  }catch(e){
    console.warn('cloud save failed',e);
    if(navigator.onLine)showToast('Не удалось сохранить в облако');
  }
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
      CU=null;CLOUD_READY_UID=null;_unsubscribeRealtime();
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
  CU=user;migrateLegacyLocal();
  // Показываем приложение сразу — облако загружается параллельно.
  // Если данные придут позже — _pullCloudIfStale и Realtime синхронизируют автоматически.
  showApp();updUI(user);loadAll();
  loadCloudData().then(()=>loadAll()); // применить облако и перерисовать когда придёт
  _maybeOnboard();
  // Realtime WebSocket — задержка 1.5с чтобы auth-сессия успела установиться
  setTimeout(_subscribeRealtime, 1500);
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
const _appStartTs=Date.now();
function showApp(){
  const a=document.getElementById('auth-screen');
  const m=document.getElementById('main-app');
  // Минимум 80ms — даём браузеру закончить первый paint прежде чем убирать заставку.
  // Было 300ms жёсткого ожидания — убрали, т.к. это ощущается как тормоза.
  const elapsed=Date.now()-_appStartTs;
  const delay=Math.max(0,80-elapsed);
  if(m)m.style.display='flex';
  setTimeout(()=>{
    if(a){a.classList.add('hidden');setTimeout(()=>a.classList.add('gone'),240);}
  },delay);
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
function toggleSceneBg(){
  const on=document.documentElement.classList.toggle('scene-on');
  localStorage.setItem('rz_bg_scene',on?'1':'0');
  syncSceneMenu();
}
function syncSceneMenu(){
  const on=document.documentElement.classList.contains('scene-on');
  const s=document.getElementById('bg-scene-s');
  if(s)s.textContent=on?'Природа · луг':'Стандартный';
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
  m.classList.contains('open')?closeMenu():(syncThemeMenu(),syncSceneMenu(),m.classList.add('open'),b.classList.add('open'));
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
  CU=null;CLOUD_READY_UID=null;_unsubscribeRealtime();closeMenu();go('home');
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
  if(!btn)return;
  const label=btn.querySelector('.sheet-ai-btn-label');
  if(label){
    const text={idle:'Разобраться в заметке',loading:'Разбираюсь...',ready:'Разбор готов',retry:'Попробовать снова'};
    label.textContent=text[state]||text.idle;
  }
  btn.classList.toggle('is-thinking',state==='loading');
}

function toggleAiPanel(){
  if(_aiOn){closeAiOverlay();return;}
  _aiOn=true;
  const btn=document.getElementById('sheet-ai-btn');
  if(btn)btn.classList.add('ai-on');
  const overlay=document.getElementById('ai-overlay');
  if(!overlay)return;
  // Открыть overlay
  overlay.style.display='flex';
  requestAnimationFrame(()=>overlay.classList.add('show'));
  const f=document.getElementById('sh1');
  const text=(f?.value||'').trim();
  const bodyEl=document.getElementById('ai-overlay-body');
  if(text.length<15){
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">Напишите немного больше — тогда AI сможет помочь.</div></div>`;
    _setSheetAiButtonState('retry');
    return;
  }
  // ── Кэш: если заметка уже анализировалась и текст не менялся — показать без API ──
  if(EI){
    const list=getNotes();
    const idx=list.findIndex(n=>n.id===EI);
    const note=idx>=0?list[idx]:null;
    if(note?.aiCache&&note.aiCache.bodyKey===text.slice(0,80)){
      if(!Array.isArray(note.aiTags)||!note.aiTags.length){
        list[idx].aiTags=normalizeAiTags(note.aiCache.tags||[]);
        list[idx].aiSummary=note.aiCache.summary||'';
        saveNotes(list);
      }
      _renderAiResult(note.aiCache.summary,note.aiCache.tags,note.aiCache.actions,null,text);
      return;
    }
  }
  _setSheetAiButtonState('loading');
  runAiAnalysis(text,null);
}

function closeAiOverlay(){
  _aiOn=false;
  const btn=document.getElementById('sheet-ai-btn');
  if(btn)btn.classList.remove('ai-on');
  _setSheetAiButtonState('idle');
  const overlay=document.getElementById('ai-overlay');
  if(!overlay)return;
  overlay.classList.remove('show');
  setTimeout(()=>{overlay.style.display='none';},300);
}

function rerunAiAnalysis(){
  if(EI){
    const list=getNotes();const idx=list.findIndex(n=>n.id===EI);
    if(idx>=0){list[idx].aiCache=null;saveNotes(list);}
  }
  _aiOn=false;
  toggleAiPanel();
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
async function runAiAnalysis(text,_unused,attempt=0){
  let autoLabel=null;
  _setSheetAiButtonState('loading');
  const bodyEl=document.getElementById('ai-overlay-body');
  if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-loading"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-dasharray="40" stroke-dashoffset="40"><animate attributeName="stroke-dashoffset" values="40;0;40" dur=".8s" repeatCount="indefinite"/></path></svg>${attempt?'AI занят, пробую ещё раз...':'Анализирую...'}</div></div>`;
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
        return runAiAnalysis(text,null,attempt+1);
      }
      throw new Error(friendlyAiError(errText,res.status));
    }
    const data=await res.json();
    const summary=typeof data.summary==='string'?data.summary:'';
    const tags=normalizeAiTags(data.tags||[]);
    const actions=Array.isArray(data.actions)?data.actions:[];
    autoLabel=tagsToPrimaryLabel(tags);
    if(autoLabel){
      const curCat=document.getElementById('sheet-cat-btn')?.dataset.label||'заметка';
      if(curCat==='заметка'){showSheetCat(autoLabel);showCatHint(autoLabel);}
    }
    _renderAiResult(summary,tags,actions,null,text);
    if(EI){
      const list=getNotes();
      const idx=list.findIndex(n=>n.id===EI);
      if(idx>=0){
        const filedTags=(list[idx].aiTags||[]).filter(_isFiledFolderTag);
        list[idx].aiCache={summary:summary||'',tags,actions,bodyKey:text.slice(0,80)};
        list[idx].aiTags=normalizeAiTags([...tags,...filedTags]);
        list[idx].aiSummary=summary||'';
        saveNotes(list);
      }
    }
    const nid=document.getElementById('sheet-wrap')?.dataset.noteId||EI||'';
    _maybeSaveIdeaToRepo({text,summary:summary||'',tags,actions,noteId:nid,label:autoLabel,source:'analysis'})
      .catch(e=>console.warn('save_idea failed',e));
  }catch(e){
    console.warn('AI error',e);
    const msg=String(e?.message||'').startsWith('Ошибка AI:')||String(e?.message||'').startsWith('AI ')||String(e?.message||'').startsWith('Войдите')||String(e?.message||'').startsWith('Не получилось')?String(e?.message):friendlyAiError(e?.message);
    if(bodyEl)bodyEl.innerHTML=`<div class="ai-panel-inner"><div class="ai-err">${esc(msg)}</div></div>`;
    _setSheetAiButtonState('retry');
  }
}

// ── RENDER AI RESULT ──
function _renderAiResult(summary,tags,actions,_unused,text){
  tags=normalizeAiTags(tags||[]);
  actions=Array.isArray(actions)?actions:[];
  const bodyEl=document.getElementById('ai-overlay-body');
  let html='<div class="ai-panel-inner">';
  if(summary){html+=`<div class="ai-section"><div class="ai-label">Суть</div><div class="ai-text">${esc(summary)}</div></div>`;}
  if(tags?.length){
    // Текущая открытая папка (если открыта из drill)
    const currentFolderTag=_tagKey(drillAiTag||'');
    const tagBtns=tags.map(t=>{
      const tl=_tagKey(t);
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
  }
  _setSheetAiButtonState('ready');
}

// ── SAVE IDEA TO REPO ──
const _ideaRepoInFlight=new Set();
function _simpleHash(str){
  let h=5381;const s=String(str||'');
  for(let i=0;i<s.length;i++)h=((h<<5)+h)^s.charCodeAt(i);
  return (h>>>0).toString(36);
}
function _ideaRepoKey(text){return 'idea:'+_simpleHash(String(text||'').trim());}
function _getIdeaRepoSavedKeys(){
  try{return JSON.parse(localStorage.getItem(scopedKey('rz_idea_repo_saved'))||'[]');}catch(e){return[];}
}
function _markIdeaRepoSaved(key){
  const arr=_getIdeaRepoSavedKeys().filter(x=>x!==key);
  arr.unshift(key);
  localStorage.setItem(scopedKey('rz_idea_repo_saved'),JSON.stringify(arr.slice(0,80)));
}
function _isIdeaRepoSaved(key){return _getIdeaRepoSavedKeys().includes(key);}
async function _maybeSaveIdeaToRepo({text,summary,tags,actions,noteId,label,source}){
  const clean=String(text||'').trim();
  let normalizedTags=normalizeAiTags(tags||[]);
  if(!_hasIdeaContext({text:clean,tags:normalizedTags,label}))return false;
  if(!normalizedTags.some(isIdeaTag))normalizedTags=normalizeAiTags([IDEA_TAG,...normalizedTags]);
  const key=_ideaRepoKey(clean);
  if(_isIdeaRepoSaved(key)||_ideaRepoInFlight.has(key))return false;
  _ideaRepoInFlight.add(key);
  try{
    const saved=await _saveIdeaToRepo({text:clean,summary,tags:normalizedTags,actions:actions||[],noteId,source});
    if(saved)_markIdeaRepoSaved(key);
    return saved;
  }finally{
    _ideaRepoInFlight.delete(key);
  }
}
async function _saveIdeaToRepo({text,summary,tags,actions,noteId}){
  try{
    tags=normalizeAiTags(tags||[]);
    if(!tags.some(isIdeaTag))tags=normalizeAiTags([IDEA_TAG,...tags]);
    const session=await sb.auth.getSession();
    const token=session?.data?.session?.access_token;
    if(!token)return false;
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'save_idea',payload:{text,summary,tags,actions,noteId}})
    });
    if(!res.ok){
      const err=await res.text();
      console.warn('save_idea error',res.status,err);
      return false;
    }
    const {saved,file}=await res.json();
    if(saved){showToast('✦ Идея сохранена в репозиторий');}
    console.info('idea saved:',file);
    return !!saved;
  }catch(e){
    console.warn('_saveIdeaToRepo failed',e);
    return false;
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
  const moreWrap=document.getElementById('sheet-more-wrap');
  if(moreWrap)moreWrap.style.display=noteId?'flex':'none';
  const delBtn=document.getElementById('tool-delete-btn');
  if(delBtn)delBtn.style.display=noteId?'inline-flex':'none';
  document.getElementById('sheet-title').textContent='Список';
  if(noteId){
    const n=getNotes().find(x=>x.id===noteId);
    const txt=(n?.items||[]).map(it=>it.t).join('\n');
    document.getElementById('sheet-body').innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Каждый пункт с новой строки">${esc(txt)}</textarea>`;
  } else {
    document.getElementById('sheet-body').innerHTML=`<textarea class="list-sheet-area" id="sh1" placeholder="Молоко&#10;Хлеб&#10;Яйца&#10;&#10;Вставьте или напишите — каждый пункт с новой строки"></textarea>`;
  }
  {const _scc=document.getElementById('sheet-char-count');if(_scc)_scc.textContent='';}
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
  loadAll();
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
// Очистить все уведомления: SW-таймауты + показанные системные
function clearAllNotifications(btn){
  // SW: сбросить запланированные таймауты
  if('serviceWorker'in navigator&&navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage({type:'SCHEDULE',notes:[]});
  }
  // Закрыть видимые системные уведомления в трее
  if(navigator.serviceWorker?.ready){
    navigator.serviceWorker.ready.then(reg=>{
      if(reg.getNotifications)reg.getNotifications().then(ns=>ns.forEach(n=>n.close()));
    }).catch(()=>{});
  }
  // In-page таймауты (баннеры внутри приложения)
  _NT.forEach(t=>clearTimeout(t));_NT=[];
  // Визуальный отклик на кнопке (не зависит от тоста)
  if(btn){const orig=btn.textContent;btn.textContent='✓ Очищено';btn.disabled=true;setTimeout(()=>{btn.textContent=orig;btn.disabled=false;},2500);}
  showToast('🔕 Уведомления очищены');
}

function scheduleAll(){
  _NT.forEach(t=>clearTimeout(t));_NT=[];
  if(!notifGranted())return;
  const notes=getNotes();

  // ── 1. SW — системные уведомления (работает в фоне, без сети) ──
  // SW показывает системный попап. Страница его НЕ дублирует.
  const swNotes=notes.filter(n=>n.reminder&&n.title&&!n.reminderDone).map(n=>({
    id:n.id,title:n.title,body:n.body?.slice(0,100)||'',reminder:n.reminder
  }));
  if('serviceWorker'in navigator&&navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage({type:'SCHEDULE',notes:swNotes});
  }

  // ── 2. setTimeout в странице — только внутренний баннер (без system Notification) ──
  // Если страница открыта в момент напоминания — показываем карточку поверх контента
  notes.forEach(n=>{
    if(!n.reminder||!n.title||n.reminderDone)return;
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

// ── REALTIME SYNC ──
// WebSocket-подписка на изменения user_state — мгновенная синхронизация между устройствами.
// Polling остаётся как fallback если WS отвалился (iOS background, плохая сеть).
let _realtimeChannel=null,_realtimeRetryT=null;
function _subscribeRealtime(){
  if(!cloudAllowed())return;
  _unsubscribeRealtime();
  clearTimeout(_realtimeRetryT);
  _realtimeChannel=sb.channel('rz_sync_'+CU.id)
    // Канал 1: postgres_changes — пассивный, срабатывает при записи в БД
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'user_state',filter:'user_id=eq.'+CU.id},(payload)=>{
      const cloudUpdatedAt=payload.new?.updated_at||'';
      const localSyncedAt=_getLocalSyncedAt();
      if(!localSyncedAt||cloudUpdatedAt>localSyncedAt){_lastPullAt=0;_pullCloudIfStale();}
    })
    // Канал 2: broadcast — активный, Device A сам сигналит при сохранении
    // Работает без postgres_changes миграции, мгновенно
    .on('broadcast',{event:'saved'},(payload)=>{
      const cloudUpdatedAt=payload?.payload?.at||'';
      const localSyncedAt=_getLocalSyncedAt();
      if(!localSyncedAt||!cloudUpdatedAt||cloudUpdatedAt>localSyncedAt){
        _lastPullAt=0;
        _pullCloudIfStale();
      }
    })
    .subscribe((status)=>{
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
        _realtimeChannel=null;
        _realtimeRetryT=setTimeout(()=>{if(cloudAllowed())_subscribeRealtime();},5000);
      }
    });
}
function _unsubscribeRealtime(){
  clearTimeout(_realtimeRetryT);
  if(_realtimeChannel){sb.removeChannel(_realtimeChannel);_realtimeChannel=null;}
}

// Merge заметок по id — не теряем локальные изменения при pull.
// Сценарий: заметка создана офлайн → пуш не прошёл → при pull облако перезапишет её.
// Решение: объединяем по id, для дублей берём более новый updatedAt.
// Важно: заметки из облака, которые уже удалены локально (есть в trash), не восстанавливаем.
function _mergeNoteArrays(local,cloud){
  const trashIds=new Set(getTrash().map(n=>n.id));
  const byId=new Map();
  // Сначала кладём облачные заметки, пропуская те что удалены локально
  (Array.isArray(cloud)?cloud:[]).forEach(n=>{
    if(n.id&&!trashIds.has(n.id))byId.set(n.id,n);
  });
  // Потом локальные — перезаписываем если локальная новее
  (Array.isArray(local)?local:[]).forEach(n=>{
    if(!n.id)return;
    const c=byId.get(n.id);
    if(!c){
      byId.set(n.id,n);
    } else if((n.updatedAt||0)>(c.updatedAt||0)){
      byId.set(n.id,n);
    }
  });
  return Array.from(byId.values());
}

// Merge корзин по id — union, победитель по _deletedAt.
// Защищает от потери локально-удалённых заметок при pull до push.
function _mergeTrashArrays(local,cloud){
  const byId=new Map();
  (Array.isArray(cloud)?cloud:[]).forEach(n=>{if(n.id)byId.set(n.id,n);});
  (Array.isArray(local)?local:[]).forEach(n=>{
    if(!n.id)return;
    const c=byId.get(n.id);
    if(!c||(n._deletedAt||0)>=(c._deletedAt||0))byId.set(n.id,n);
  });
  const result=Array.from(byId.values());
  result.sort((a,b)=>(b._deletedAt||0)-(a._deletedAt||0));
  while(result.length>200)result.pop();
  return result;
}

let _lastPullAt=0;
async function _pullCloudIfStale(){
  if(!cloudAllowed()||!CU)return;
  const age=Date.now()-_lastPullAt;
  if(age<3000)return;
  _lastPullAt=Date.now();
  try{
    const {data}=await sb.from('user_state').select('*').eq('user_id',CU.id).maybeSingle();
    if(!data)return;
    let changed=false;
    const cloudUpdatedAt=data.updated_at||'';
    const localSyncedAt=_getLocalSyncedAt();
    const cloudHasNewer=!localSyncedAt||(cloudUpdatedAt&&cloudUpdatedAt>localSyncedAt);
    if(cloudHasNewer&&Array.isArray(data.notes)){
      const localNotes=getNotes();
      const merged=_mergeNoteArrays(localNotes,data.notes);
      const mergedJson=JSON.stringify(merged);
      const localJson=localStorage.getItem(scopedKey('rz_notes'));
      if(localJson!==mergedJson){localStorage.setItem(scopedKey('rz_notes'),mergedJson);changed=true;}
    }
    if(cloudHasNewer&&Array.isArray(data.trash)){
      const merged=_mergeTrashArrays(getTrash(),data.trash);
      localStorage.setItem(scopedKey('rz_trash'),JSON.stringify(merged));
    }
    if(cloudHasNewer&&Array.isArray(data.history)){
      localStorage.setItem(scopedKey('rz_history'),JSON.stringify(data.history));
    }
    if(cloudHasNewer&&Array.isArray(data.ai_memory)){
      localStorage.setItem(scopedKey('rz_ai_memory'),JSON.stringify(data.ai_memory));
    }
    const foldersChanged=_mergeCloudFolders(data.user_folders,data.tag_folders,cloudUpdatedAt);
    if(changed||foldersChanged)loadAll();
    // Если после merge локальные заметки отличаются от облака — пушим мерж в облако
    if(changed)queueCloudSave();
  }catch(_){}
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(notifGranted())scheduleAll();
    _lastPullAt=0;
    _pullCloudIfStale();
  }
});
window.addEventListener('focus',()=>{_lastPullAt=0;_pullCloudIfStale();});
// При появлении сети — сначала пушим локальные изменения, потом тянем облако
window.addEventListener('online',()=>{
  queueCloudSave(); // пушим всё что не успело сохраниться офлайн
  _lastPullAt=0;
  // Если начальная загрузка с облака не удалась (стартовали без сети) — грузим сейчас
  if(CLOUD_READY_UID!==CU?.id&&cloudAllowed()){
    loadCloudData().then(()=>loadAll());
  } else {
    setTimeout(_pullCloudIfStale,1500);
  }
});
setInterval(()=>{
  if(document.visibilityState==='visible'&&cloudAllowed())_pullCloudIfStale();
},8000);

// ── Pull-to-refresh на ленте и списке заметок ──
let _ptrActive=false,_ptrSY=0,_ptrTriggered=false,_activePtrBar=null;
function _ptrBarFor(scrollEl){
  if(scrollEl?.closest?.('#s-notes'))return document.getElementById('notes-ptr-bar');
  return document.getElementById('ptr-bar');
}
function _setNotesRefreshBusy(busy){
  const btn=document.getElementById('drill-refresh-btn');
  if(!btn)return;
  btn.classList.toggle('refreshing',!!busy);
  btn.disabled=!!busy;
}
function _initPTR(scrollEl){
  if(!scrollEl||scrollEl._ptrInited)return;
  scrollEl._ptrInited=true;
  const bar=_ptrBarFor(scrollEl);
  const THRESHOLD=72;
  scrollEl.addEventListener('touchstart',e=>{
    if(scrollEl.scrollTop===0){_ptrActive=true;_ptrSY=e.touches[0].clientY;_ptrTriggered=false;}
  },{passive:true});
  scrollEl.addEventListener('touchmove',e=>{
    if(!_ptrActive)return;
    const dy=e.touches[0].clientY-_ptrSY;
    if(dy>0&&scrollEl.scrollTop===0){
      const pull=Math.min(dy*0.45,THRESHOLD);
      if(bar){bar.style.height=pull+'px';}
      _activePtrBar=bar;
      _ptrTriggered=pull>=THRESHOLD*0.75;
      if(bar)bar.style.opacity=String(Math.min(pull/(THRESHOLD*0.5),1));
    }
  },{passive:true});
  scrollEl.addEventListener('touchend',()=>{
    if(!_ptrActive)return;
    _ptrActive=false;
    if(bar){bar.style.height='0';bar.style.opacity='';}
    if(_ptrTriggered)_doPTR();
    _ptrTriggered=false;
  },{passive:true});
}
let _ptrRunning=false;
async function _doPTR(){
  if(_ptrRunning)return;
  _ptrRunning=true;
  const bar=_activePtrBar||document.getElementById(cur==='notes'?'notes-ptr-bar':'ptr-bar')||document.getElementById('ptr-bar');
  _setNotesRefreshBusy(true);
  try{
    if(bar){bar.style.height='36px';bar.classList.add('spinning');}
    _lastPullAt=0;
    CLOUD_READY_UID=null; // принудительно перегружаем с облака
    await loadCloudData();
    loadAll();
    await new Promise(r=>setTimeout(r,600));
    showToast('Обновлено ✓');
  }finally{
    if(bar){bar.classList.remove('spinning');bar.style.height='0';}
    _setNotesRefreshBusy(false);
    _activePtrBar=null;
    _ptrRunning=false;
  }
}

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
    if(!n.reminder||n.reminderDone)return false;
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
    if(!n.reminder||n.reminderDone)return;
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
  if(!overlay)return;
  overlay.classList.add('closing');
  setTimeout(()=>{overlay.classList.remove('open','closing');},210);
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
function _remItemHTML(n,isDone){
  const now=Date.now();
  const dt=parseDt(n.reminder);
  const isPast=dt&&dt.getTime()<now;
  const isSoon=dt&&!isPast&&(dt.getTime()-now)<3*3600000;
  const whenCls=isDone?'done':isPast?'overdue':isSoon?'soon':'future';
  const itemCls=(isDone?' rem-done':isPast?' rem-overdue':isSoon?' rem-soon':'');
  const whenTxt=dt?_remindWhenTxt(dt,now):fmtDt(n.reminder);
  const title=n.title||(n.body||'').split('\n')[0].slice(0,60)||'Заметка';
  const recurLine=n.recurring?.times?.length&&!isDone
    ?`<span class="rem-recur">🔁 ${esc(n.recurring.times.join(' · '))}</span>`:'';
  const cbAction=isDone
    ?`_markReminderUndone('${esc(n.id)}')`
    :`_remCheckDone('${esc(n.id)}')`;
  return `<div class="remind-item2${itemCls}" data-rid="${esc(n.id)}">
    <button class="rem-cb${isDone?' done':''}" onclick="event.stopPropagation();${cbAction}" aria-label="${isDone?'Вернуть':'Выполнено'}">
      <svg class="rem-cb-check" viewBox="0 0 12 9" width="12" height="9" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,4.5 4.5,8 11,1"/></svg>
    </button>
    <div class="rem-body" onclick="closeReminderPanel();setTimeout(()=>openNoteSheetById(${jsAttr(n.id)}),260)">
      <div class="rem-name${isDone?' rem-name-done':''}">${esc(title)}</div>
      <div class="rem-when rem-when-${whenCls}">${esc(whenTxt)}${recurLine}</div>
    </div>
    <button class="rem-edit-btn" onclick="event.stopPropagation();_toggleRemMenu(this,${jsAttr(n.id)},${isDone})" aria-label="Действия">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/></svg>
    </button>
  </div>`;
}

// ── Мини-меню ··· у напоминания ──
function _closeRemMenus(){document.querySelectorAll('.rem-menu').forEach(m=>m.remove());}
function _toggleRemMenu(btn,noteId,isDone){
  const existing=btn.querySelector('.rem-menu');
  if(existing){existing.remove();return;}
  _closeRemMenus();
  const n=getNotes().find(x=>x.id===noteId);
  const isRecurring=!!(n?.recurring?.times?.length);
  const menu=document.createElement('div');
  menu.className='rem-menu';
  menu.onclick=e=>e.stopPropagation();
  if(isDone){
    // Меню для выполненного напоминания
    menu.innerHTML=`
      <button class="rem-menu-item" onclick="_closeRemMenus();closeReminderPanel();setTimeout(()=>openNoteSheetById(${jsAttr(noteId)}),260)">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Открыть заметку
      </button>
      <button class="rem-menu-item danger" onclick="_closeRemMenus();_removeDoneReminder(${jsAttr(noteId)})">
        <svg viewBox="0 0 24 24" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        Убрать из списка
      </button>`;
  } else {
    // Меню для активного напоминания
    menu.innerHTML=`
      <button class="rem-menu-item" onclick="_closeRemMenus();closeReminderPanel();setTimeout(()=>openNoteSheetById(${jsAttr(noteId)}),260)">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Открыть заметку
      </button>
      <button class="rem-menu-item" onclick="_closeRemMenus();openRemEditForNote(${jsAttr(noteId)})">
        <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Изменить время
      </button>
      <button class="rem-menu-item danger" onclick="_closeRemMenus();_deleteNoteReminder(${jsAttr(noteId)})">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        ${isRecurring?'Остановить':'Удалить'} напоминание
      </button>
      <button class="rem-menu-item danger" onclick="_closeRemMenus();_trashNoteWithReminder(${jsAttr(noteId)})">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        Удалить заметку тоже
      </button>`;
  }
  btn.appendChild(menu);
  setTimeout(()=>document.addEventListener('click',_closeRemMenus,{once:true}),0);
}

function _removeDoneReminder(noteId){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  const el=document.querySelector(`.remind-item2[data-rid="${noteId}"]`);
  const doRemove=()=>{
    delete n.reminder;delete n.recurring;delete n.reminderDone;delete n.reminderDoneAt;
    n.updatedAt=Date.now();
    saveNotes(notes);updateReminderDot();renderReminderPanel();
  };
  if(el){
    el.style.transition='opacity .22s,transform .22s,max-height .28s .1s,margin .28s .1s';
    el.style.maxHeight=el.offsetHeight+'px';el.style.overflow='hidden';
    el.style.opacity='0';el.style.transform='translateX(14px)';
    setTimeout(()=>{el.style.maxHeight='0';el.style.marginBottom='0';},160);
    setTimeout(doRemove,380);
  }else{doRemove();}
  showToast('Удалено из списка');
}
function _trashNoteWithReminder(noteId){
  const el=document.querySelector(`.remind-item2[data-rid="${noteId}"]`);
  const doDelete=()=>{
    delNoteById(noteId);
    scheduleAll();updateReminderDot();renderReminderPanel();
    showToast('Заметка удалена');
  };
  if(el){
    el.style.transition='opacity .22s,transform .22s,max-height .28s .1s,margin .28s .1s';
    el.style.maxHeight=el.offsetHeight+'px';el.style.overflow='hidden';
    el.style.opacity='0';el.style.transform='translateX(14px)';
    setTimeout(()=>{el.style.maxHeight='0';el.style.marginBottom='0';},160);
    setTimeout(doDelete,380);
  }else doDelete();
}
function _deleteNoteReminder(noteId){
  const notes=getNotes();
  const n=notes.find(x=>x.id===noteId);
  if(!n)return;
  const el=document.querySelector(`.remind-item2[data-rid="${noteId}"]`);
  // Анимация исчезновения
  if(el){
    el.style.maxHeight=el.offsetHeight+'px';
    el.style.overflow='hidden';
    el.style.opacity='0';
    el.style.transform='translateX(12px)';
    setTimeout(()=>{el.style.maxHeight='0';el.style.marginBottom='0';el.style.paddingTop='0';el.style.paddingBottom='0';},160);
    setTimeout(()=>{
      n.reminder=null;
      n.recurring=null;
      n.updatedAt=Date.now();
      saveNotes(notes);
      if(n.reminder)_deleteReminderFromServer(noteId);
      scheduleAll();updateReminderDot();
      renderReminderPanel();
    },400);
  } else {
    n.reminder=null;n.recurring=null;n.updatedAt=Date.now();
    saveNotes(notes);scheduleAll();updateReminderDot();renderReminderPanel();
  }
  showToast('Напоминание удалено');
}

let _remDoneOpen=false; // состояние аккордеона «Выполненные»

function toggleRemDone(){
  _remDoneOpen=!_remDoneOpen;
  const body=document.getElementById('rem-done-body');
  const arrow=document.getElementById('rem-done-arrow');
  if(!body)return;
  if(_remDoneOpen){
    body.style.display='block';
    if(arrow)arrow.textContent='▲';
  }else{
    body.style.display='none';
    if(arrow)arrow.textContent='▼';
  }
}

function renderReminderPanel(){
  const scroll=document.getElementById('remind-scroll');if(!scroll)return;
  const notes=getNotes();
  const now=Date.now();
  // Активные — reminder есть, не выполнено, в пределах 3 суток
  const active=notes.filter(n=>{
    if(!n.reminder||n.reminderDone)return false;
    const dt=parseDt(n.reminder);if(!dt)return false;
    return dt.getTime()>now-86400000*3;
  }).sort((a,b)=>{
    const da=parseDt(a.reminder),db=parseDt(b.reminder);
    return(da?da.getTime():Infinity)-(db?db.getTime():Infinity);
  });
  // Выполненные — все, без лимита по времени и количеству
  const done=notes.filter(n=>n.reminderDone&&n.reminder)
    .sort((a,b)=>(b.reminderDoneAt||0)-(a.reminderDoneAt||0));
  const settings=getReminderSettings();
  let html='';
  if(active.length){
    active.forEach(n=>{html+=_remItemHTML(n,false);});
  } else if(!done.length){
    html+=`<div class="remind-empty"><div class="remind-empty-ico">🔔</div><div class="remind-empty-txt">Нет активных напоминаний</div></div>`;
  }
  if(done.length){
    const open=_remDoneOpen;
    html+=`<div class="rem-done-hdr" onclick="toggleRemDone()">
      <span>Выполненные (${done.length})</span>
      <span id="rem-done-arrow" class="rem-done-arrow">${open?'▲':'▼'}</span>
    </div>`;
    html+=`<div id="rem-done-body" style="display:${open?'block':'none'}">`;
    done.forEach(n=>{html+=_remItemHTML(n,true);});
    html+='</div>';
  }
  html+='<div class="remind-section-label">Настройки</div>';
  html+=`<div class="remind-settings">
    <div class="remind-set-row">
      <span class="remind-set-lbl">Напомнить заранее</span>
      <button class="remind-set-val" id="remind-adv-btn" onclick="cycleAdvance()">${advanceLabel(settings.advanceMinutes)}</button>
    </div>
    <div class="remind-set-row">
      <span class="remind-set-lbl">Очистить уведомления</span>
      <button class="remind-set-val remind-set-danger" onclick="clearAllNotifications(this)">Очистить</button>
    </div>
  </div>`;
  scroll.innerHTML=html;
}

// Отметить напоминание как выполненное (с анимацией, не удаляет)
function _remCheckDone(id){
  const el=document.querySelector(`.remind-item2[data-rid="${id}"]`);
  if(!el){_markReminderDone(id);return;}
  const cb=el.querySelector('.rem-cb');
  if(cb)cb.classList.add('done');
  el.style.maxHeight=el.offsetHeight+'px';
  el.style.overflow='hidden';
  setTimeout(()=>{
    el.style.opacity='0';
    el.style.transform='translateY(6px)';
    el.style.maxHeight='0';
    el.style.marginBottom='0';
    el.style.paddingTop='0';
    el.style.paddingBottom='0';
    setTimeout(()=>{_markReminderDone(id);renderReminderPanel();},290);
  },180);
}

// Сохранить reminderDone=true, напоминание НЕ удаляется
function _markReminderDone(id){
  const notes=getNotes();
  const n=notes.find(x=>x.id===id);
  if(!n)return;
  // Циклические — старое поведение (перепланировать)
  if(n.recurring?.times?.length){doneReminder(id);return;}
  n.reminderDone=true;
  n.reminderDoneAt=Date.now();
  n.updatedAt=Date.now();
  saveNotes(notes);
  scheduleAll();
  updateReminderDot();
  _reloadViews(); // убрать карточку с главного экрана
}

// Снять галочку — вернуть напоминание в активные
function _markReminderUndone(id){
  const notes=getNotes();
  const n=notes.find(x=>x.id===id);
  if(!n)return;
  delete n.reminderDone;
  delete n.reminderDoneAt;
  n.updatedAt=Date.now();
  saveNotes(notes);
  scheduleAll();
  updateReminderDot();
  renderReminderPanel();
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
      // Автоматически открываем календарь для разового напоминания
      if(!isRec)setTimeout(()=>_remCalToggle(),80);
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

// ── УНИВЕРСАЛЬНЫЙ РЕНДЕР КАЛЕНДАРЯ ──────────────────────────────────────────
// ctx = 'rem' | 'rmp' | 'qrem'
// opts.saveBtn = false → не рисовать кнопку «Напомнить» (для qrem — своя кнопка снаружи)
const _WH=44; // высота одного элемента барабана, px

function _renderCalInto(wrapId, cal, ctx, opts={}){
  const wrap=document.getElementById(wrapId);
  if(!wrap||!cal)return;
  const {year,month,day,hour,min}=cal;
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
    const click=isPast?'':`onclick="_${ctx}CalPick(${year},${month},${d})"`;
    cells+=`<div class="${cls}" ${click}>${d}</div>`;
  }
  const total=startOff+dInMonth;const rem=total%7?7-total%7:0;
  for(let d=1;d<=rem;d++)cells+=`<div class="rcal-day other">${d}</div>`;
  // Барабаны часов и минут
  const hPad='<div class="rcal-wp"></div>';
  const hItems=Array.from({length:24},(_,i)=>`<div class="rcal-wi">${String(i).padStart(2,'0')}</div>`).join('');
  const mItems=Array.from({length:60},(_,i)=>`<div class="rcal-wi">${String(i).padStart(2,'0')}</div>`).join('');
  const lSvg=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  const rSvg=`<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  const hS=String(hour).padStart(2,'0'),mS=String(min).padStart(2,'0');
  const saveBtn=opts.saveBtn===false?''
    :`<button class="rcal-save" id="${ctx}-rcal-save" onclick="_${ctx}CalSave()">Напомнить ${hS}:${mS} · ${day} ${MS[month]}</button>`;
  wrap.innerHTML=`<div class="rcal">
    <div class="rcal-hdr">
      <button class="rcal-nav" onclick="_${ctx}CalPrevMonth()">${lSvg}</button>
      <div class="rcal-month">${MONTHS[month]} ${year}</div>
      <button class="rcal-nav" onclick="_${ctx}CalNextMonth()">${rSvg}</button>
    </div>
    <div class="rcal-dhdr">${DHDR.map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="rcal-grid">${cells}</div>
    <div class="rcal-wheels">
      <div class="rcal-wsel"></div>
      <div class="rcal-wheel-col">
        <div class="rcal-wheel" id="${ctx}-hw">${hPad}${hItems}${hPad}</div>
      </div>
      <div class="rcal-wsep">:</div>
      <div class="rcal-wheel-col">
        <div class="rcal-wheel" id="${ctx}-mw">${hPad}${mItems}${hPad}</div>
      </div>
    </div>
    ${saveBtn}
  </div>`;
  // Инициализируем барабаны после вставки в DOM
  requestAnimationFrame(()=>_initCalWheels(document.getElementById(wrapId),cal,ctx));
}

function _initCalWheels(wrap,cal,ctx){
  if(!wrap||!cal)return;
  const hw=wrap.querySelector(`#${ctx}-hw`);
  const mw=wrap.querySelector(`#${ctx}-mw`);
  if(hw){
    hw.scrollTop=cal.hour*_WH;
    let _ht=null;
    hw.addEventListener('scroll',()=>{
      clearTimeout(_ht);_ht=setTimeout(()=>{
        cal.hour=Math.max(0,Math.min(23,Math.round(hw.scrollTop/_WH)));
        _onCalWheelChange(ctx,cal,wrap);
      },100);
    },{passive:true});
  }
  if(mw){
    mw.scrollTop=cal.min*_WH;
    let _mt=null;
    mw.addEventListener('scroll',()=>{
      clearTimeout(_mt);_mt=setTimeout(()=>{
        cal.min=Math.max(0,Math.min(59,Math.round(mw.scrollTop/_WH)));
        _onCalWheelChange(ctx,cal,wrap);
      },100);
    },{passive:true});
  }
}

function _onCalWheelChange(ctx,cal,wrap){
  const MS=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  const hS=String(cal.hour).padStart(2,'0'),mS=String(cal.min).padStart(2,'0');
  // Обновить текст кнопки «Напомнить» внутри календаря (rem/rmp)
  const saveBtn=wrap?.querySelector(`#${ctx}-rcal-save`);
  if(saveBtn)saveBtn.textContent=`Напомнить ${hS}:${mS} · ${cal.day} ${MS[cal.month]}`;
  // Для qrem: обновить основную кнопку снаружи
  if(ctx==='qrem'){
    _qremDate=new Date(cal.year,cal.month,cal.day,cal.hour,cal.min,0,0);
    _qremUpdateSave(_qremDate);
  }
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

function _renderRemCal(){_renderCalInto('rem-cal-wrap',_remCal,'rem');}
// алиасы для контекста 'rem' (вызываются из _renderCalInto)
function _remCalPick(y,m,d){if(!_remCal)return;_remCal.year=y;_remCal.month=m;_remCal.day=d;_renderRemCal();}
function _remCalPrevMonth(){if(!_remCal)return;_remCal.month--;if(_remCal.month<0){_remCal.month=11;_remCal.year--;}_renderRemCal();}
function _remCalNextMonth(){if(!_remCal)return;_remCal.month++;if(_remCal.month>11){_remCal.month=0;_remCal.year++;}_renderRemCal();}
function _remCalH(d){if(!_remCal)return;_remCal.hour=(_remCal.hour+d+24)%24;_renderRemCal();}
function _remCalM(d){if(!_remCal)return;_remCal.min=(_remCal.min+d*5+60)%60;_renderRemCal();}

function _remCalSave(){
  if(!_remCal)return;
  const {year,month,day,hour,min}=_remCal;
  const d=new Date(year,month,day,hour,min,0,0);
  if(d.getTime()<Date.now()){showToast('Время уже прошло — выбери будущее');return;}
  _remEditSave(_rmpLocalStr(d));
  // Не закрываем календарь — остаётся виден для изменений
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
function remEditDeleteNote(){
  if(!_remEditNoteId)return;
  const id=_remEditNoteId;
  closeRemEdit();
  setTimeout(()=>{
    delNoteById(id);
    scheduleAll();updateReminderDot();
    renderReminderPanel();
    showToast('Заметка удалена');
  },350);
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
  loadAll();
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
// ── ЕДИНЫЙ ЛИСТ "НОВОЕ НАПОМИНАНИЕ" (заменяет двухшаговый флоу) ──
let _qremCal=null;
let _qremDate=null;
let _qremLinkedNoteId=null;

function openInputSheetWithReminder(){
  closeReminderPanel();
  setTimeout(()=>openQrem(),180);
}

function _qremResetPicker(){
  _qremLinkedNoteId=null;
  const lbl=document.getElementById('qrem-note-link-lbl');
  if(lbl)lbl.textContent='Привязать к заметке';
  const clr=document.getElementById('qrem-note-link-clear');
  if(clr)clr.style.display='none';
  const btn=document.getElementById('qrem-note-link-btn');
  if(btn)btn.classList.remove('linked');
  const picker=document.getElementById('qrem-note-picker');
  if(picker)picker.style.display='none';
  const inp=document.getElementById('qrem-inp');
  if(inp)inp.placeholder='Что напомнить?…';
}

function openQrem(){
  _qremDate=null;_qremCal=null;
  _qremResetPicker();
  // Инициализируем календарь сразу на +1 час
  const base=new Date(Date.now()+3600000);base.setSeconds(0,0);
  const rm=Math.round(base.getMinutes()/5)*5;
  if(rm>=60){base.setHours(base.getHours()+1);base.setMinutes(0);}else base.setMinutes(rm);
  _qremCal={year:base.getFullYear(),month:base.getMonth(),day:base.getDate(),hour:base.getHours(),min:base.getMinutes()};
  const ov=document.getElementById('qrem-ov');
  if(!ov)return;
  ov.style.display='flex';
  const inp=document.getElementById('qrem-inp');
  if(inp)inp.value='';
  document.querySelectorAll('.qrem-chip').forEach(b=>b.classList.remove('active'));
  // Кнопка активна сразу — дефолтное время (+1 час) уже выбрано
  _qremDate=new Date(_qremCal.year,_qremCal.month,_qremCal.day,_qremCal.hour,_qremCal.min,0,0);
  _qremUpdateSave(_qremDate);
  requestAnimationFrame(()=>{
    const sheet=document.getElementById('qrem-sheet');
    if(sheet)sheet.style.transform='translateY(0)';
    _renderCalInto('qrem-cal-wrap',_qremCal,'qrem',{saveBtn:false});
    setTimeout(()=>inp?.focus(),350);
  });
}

function closeQrem(){
  const sheet=document.getElementById('qrem-sheet');
  if(sheet)sheet.style.transform='translateY(100%)';
  setTimeout(()=>{
    const ov=document.getElementById('qrem-ov');
    if(ov)ov.style.display='none';
    _qremCal=null;_qremDate=null;
    _qremResetPicker();
  },320);
}

// ── ПИКЕР ЗАМЕТОК В QREM ──
function qremToggleNotePicker(){
  const picker=document.getElementById('qrem-note-picker');
  if(!picker)return;
  const open=picker.style.display!=='none';
  if(open){picker.style.display='none';return;}
  picker.style.display='block';
  const search=document.getElementById('qrem-picker-search');
  if(search){search.value='';setTimeout(()=>search.focus(),80);}
  _qremRenderPickerList('');
}

function qremPickerSearch(q){_qremRenderPickerList(q.trim());}

function _qremRenderPickerList(q){
  const list=document.getElementById('qrem-picker-list');
  if(!list)return;
  let notes=getNotes();
  if(q){
    const lq=q.toLowerCase();
    notes=notes.filter(n=>(n.title||'').toLowerCase().includes(lq)||(n.body||'').toLowerCase().includes(lq));
  }
  notes=notes.slice(0,10);
  if(!notes.length){list.innerHTML=`<div class="qrem-picker-empty">Заметок не найдено</div>`;return;}
  list.innerHTML=notes.map(n=>{
    const title=esc(n.title||(n.body||'').slice(0,60)||'Заметка');
    const sel=n.id===_qremLinkedNoteId;
    return `<div class="qrem-picker-item${sel?' selected':''}" onclick="qremPickNote(${JSON.stringify(n.id)})">${title}</div>`;
  }).join('');
}

function qremPickNote(id){
  const n=getNotes().find(x=>x.id===id);
  if(!n)return;
  _qremLinkedNoteId=id;
  const lbl=document.getElementById('qrem-note-link-lbl');
  if(lbl)lbl.textContent=n.title||(n.body||'').slice(0,40)||'Заметка';
  const clr=document.getElementById('qrem-note-link-clear');
  if(clr)clr.style.display='inline-block';
  const btn=document.getElementById('qrem-note-link-btn');
  if(btn)btn.classList.add('linked');
  const inp=document.getElementById('qrem-inp');
  if(inp)inp.placeholder='Добавить текст к напоминанию (необязательно)…';
  const picker=document.getElementById('qrem-note-picker');
  if(picker)picker.style.display='none';
}

function qremClearLinkedNote(){
  _qremResetPicker();
}

function qremQuick(minutes,btn){
  const dt=new Date(Date.now()+minutes*60000);dt.setSeconds(0,0);
  const rm=Math.round(dt.getMinutes()/5)*5;
  if(rm>=60){dt.setHours(dt.getHours()+1);dt.setMinutes(0);}else dt.setMinutes(rm);
  _qremDate=dt;
  _qremCal={year:dt.getFullYear(),month:dt.getMonth(),day:dt.getDate(),hour:dt.getHours(),min:dt.getMinutes()};
  _renderCalInto('qrem-cal-wrap',_qremCal,'qrem');
  document.querySelectorAll('.qrem-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  _qremUpdateSave(dt);
}

function qremTomorrow(h,m,btn){
  const dt=new Date();dt.setDate(dt.getDate()+1);dt.setHours(h,m,0,0);
  _qremDate=dt;
  _qremCal={year:dt.getFullYear(),month:dt.getMonth(),day:dt.getDate(),hour:dt.getHours(),min:dt.getMinutes()};
  _renderCalInto('qrem-cal-wrap',_qremCal,'qrem');
  document.querySelectorAll('.qrem-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  _qremUpdateSave(dt);
}

function _qremUpdateSave(dt){
  const saveBtn=document.getElementById('qrem-save');
  if(!saveBtn)return;
  if(dt){saveBtn.textContent='Напомнить · '+fmtDt(_rmpLocalStr(dt));saveBtn.classList.add('ready');}
  else{saveBtn.textContent='Напомнить';saveBtn.classList.remove('ready');}
}

// Контекст 'qrem' — функции вызываются из _renderCalInto
function _qremCalPick(y,m,d){
  if(!_qremCal)return;
  _qremCal.year=y;_qremCal.month=m;_qremCal.day=d;
  // Сразу обновляем дату — клик на день мгновенно активирует кнопку
  _qremDate=new Date(_qremCal.year,_qremCal.month,_qremCal.day,_qremCal.hour,_qremCal.min,0,0);
  document.querySelectorAll('.qrem-chip').forEach(b=>b.classList.remove('active'));
  _qremUpdateSave(_qremDate);
  _renderCalInto('qrem-cal-wrap',_qremCal,'qrem',{saveBtn:false});
}
function _qremCalPrevMonth(){if(!_qremCal)return;_qremCal.month--;if(_qremCal.month<0){_qremCal.month=11;_qremCal.year--;}_renderCalInto('qrem-cal-wrap',_qremCal,'qrem',{saveBtn:false});}
function _qremCalNextMonth(){if(!_qremCal)return;_qremCal.month++;if(_qremCal.month>11){_qremCal.month=0;_qremCal.year++;}_renderCalInto('qrem-cal-wrap',_qremCal,'qrem',{saveBtn:false});}
function _qremCalH(){}
function _qremCalM(){}
function _qremCalSave(){}

function qremSave(){
  const text=(document.getElementById('qrem-inp')?.value||'').trim();
  if(!_qremLinkedNoteId&&!text){showToast('Напишите что напомнить');return;}
  if(!_qremDate){showToast('Выберите время');return;}
  if(_qremDate.getTime()<Date.now()){showToast('Время уже прошло');return;}
  const reminderStr=_rmpLocalStr(_qremDate);

  if(_qremLinkedNoteId){
    const notes=getNotes();
    const n=notes.find(x=>x.id===_qremLinkedNoteId);
    if(!n){showToast('Заметка не найдена');return;}
    n.reminder=reminderStr;
    n.reminderDone=false;
    delete n.reminderDoneAt;
    n.updatedAt=Date.now();
    saveNotes(notes);
    _reloadViews();scheduleAll();updateReminderDot();
    closeQrem();
    showToast('🔔 Напомним '+fmtDt(reminderStr));
    return;
  }

  const ts=Date.now();const id=genId();
  const auto=analyzeText(text);
  const notes=getNotes();
  notes.push({id,title:auto.title||text.slice(0,60),body:text,label:'заметка',reminder:reminderStr,createdAt:ts,updatedAt:ts});
  saveNotes(notes);
  _reloadViews();
  scheduleAll();updateReminderDot();
  closeQrem();
  showToast('🔔 Напомним '+fmtDt(reminderStr));
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
// Короткое время напоминания: «сегодня 21:30», «завтра 09:00», «3 июн 21:30»
function _fmtRemShort(ts){
  if(!ts)return'';
  const d=new Date(ts),now=new Date();
  const M=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  const sameDay=(a,b)=>a.getDate()===b.getDate()&&a.getMonth()===b.getMonth()&&a.getFullYear()===b.getFullYear();
  const tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);
  const hm=pad(d.getHours())+':'+pad(d.getMinutes());
  if(sameDay(d,now))return'сегодня '+hm;
  if(sameDay(d,tomorrow))return'завтра '+hm;
  return d.getDate()+' '+M[d.getMonth()]+' '+hm;
}
function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7);}

// ── CALENDAR ──
let CY=new Date().getFullYear(),CM=new Date().getMonth(),CS=null,YP=false;
let calSwipeX=0;
const MRU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MGN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function openCal(){
  YP=false;
  document.getElementById('year-picker').classList.remove('open');
  const det=document.getElementById('cal-detail');
  if(det){det.innerHTML='';det.style.display='none';}
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
  // Собираем события по дням: dayEvents[d] = массив цветов
  const dayEvents={};
  notes.forEach(n=>{
    const dates=[];
    if(n.reminder){const s=n.reminder.slice(0,10);const p=s.split('-').map(Number);if(p[0]===CY&&p[1]-1===CM)dates.push(p[2]);}
    if(n.createdAt){const s=new Date(n.createdAt).toISOString().slice(0,10);const p=s.split('-').map(Number);if(p[0]===CY&&p[1]-1===CM&&!dates.includes(p[2]))dates.push(p[2]);}
    dates.forEach(d=>{
      if(!dayEvents[d])dayEvents[d]=[];
      const col=STRIPES[n.label]||'oklch(0.70 0.03 210)';
      dayEvents[d].push(col);
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
    const evColors=dayEvents[d]||[];
    const b=mkDay(d,ds,false,isT,CS===ds,evColors);
    b.onclick=()=>{CS=CS===ds?null:ds;calRender();calRenderDetail();};
    grid.appendChild(b);
  }
  updCalTrigger();
}
function mkDay(num, ds, other, isT, isSel, eventColors=[]) {
  const b = document.createElement('button');
  b.className = 'cal-day' + (other?' other':'') + (isT?' today':'') + (isSel?' sel':'');
  const dots = eventColors.slice(0,3).map(c =>
    `<span class="cal-dot" style="background:${isSel?'oklch(1 0 0/0.85)':c}"></span>`
  ).join('');
  b.innerHTML = `<span class="cal-day-num">${num}</span>${dots?`<span class="cal-dots-row">${dots}</span>`:''}`;
  return b;
}
function calRenderDetail() {
  const wrap = document.getElementById('cal-detail');
  if (!wrap) return;
  if (!CS) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
  const [y,m,d] = CS.split('-').map(Number);
  const dayNames = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  const monthNames = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const dow = dayNames[new Date(y,m-1,d).getDay()];
  const dateLabel = dow.charAt(0).toUpperCase()+dow.slice(1)+', '+d+' '+monthNames[m-1];
  const notes = getNotes();
  const events = notes.filter(n => {
    const remDate = n.reminder ? n.reminder.slice(0,10) : null;
    const creDate = n.createdAt ? new Date(n.createdAt).toISOString().slice(0,10) : null;
    return remDate === CS || creDate === CS;
  }).sort((a,b) => {
    const at = a.reminder ? new Date(a.reminder).getTime() : (a.createdAt||0);
    const bt = b.reminder ? new Date(b.reminder).getTime() : (b.createdAt||0);
    return at - bt;
  });
  const STRIPES_LOCAL = typeof STRIPES !== 'undefined' ? STRIPES : {};
  const timeStr = n => {
    if (!n.reminder) return '';
    const dt = new Date(n.reminder);
    return dt.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  };
  let evHTML = events.length
    ? events.map(n => {
        const col = STRIPES_LOCAL[n.label] || 'oklch(0.70 0.03 210)';
        const t = timeStr(n);
        const title = esc(n.title || (n.body||'').slice(0,50) || 'Заметка');
        return `<div class="cal-ev-row" onclick="closeCal();setTimeout(()=>openNoteSheetById(${JSON.stringify(n.id)}),260)">
          <div class="cal-ev-dot" style="background:${col}"></div>
          <div class="cal-ev-body">
            <div class="cal-ev-title">${title}</div>
            ${t?`<div class="cal-ev-time">${t}</div>`:''}
          </div>
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="var(--fg-l)" stroke-width="2" fill="none" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`;
      }).join('')
    : `<div class="cal-ev-empty">Событий нет — нажми + чтобы добавить</div>`;
  wrap.innerHTML = `
    <div class="cal-detail-hdr">
      <span class="cal-detail-date">${dateLabel}</span>
      <button class="cal-detail-add" onclick="calOpenAddEvent()" title="Добавить событие">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
    <div class="cal-ev-list">${evHTML}</div>`;
  wrap.style.display = 'block';
  wrap.style.animation = 'calDetailIn .22s cubic-bezier(.22,1,.36,1)';
}
function calOpenAddEvent() {
  if (!CS) return;
  const [y,m,d] = CS.split('-').map(Number);
  const dt = new Date(y, m-1, d, 12, 0, 0);
  if (dt.getTime() < Date.now()) dt.setHours(new Date().getHours()+2, 0, 0, 0);
  const ov = document.getElementById('cal-add-ov');
  if (!ov) return;
  document.getElementById('cal-add-inp').value = '';
  document.getElementById('cal-add-date-lbl').textContent = d+' '+['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'][m-1];
  window._calAddType = 'событие';
  document.querySelectorAll('.cal-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type==='событие'));
  ov.style.display = 'flex';
  requestAnimationFrame(() => {
    document.getElementById('cal-add-sheet').style.transform = 'translateY(0)';
    setTimeout(() => document.getElementById('cal-add-inp').focus(), 200);
  });
}
function closeCalAddEvent() {
  const sheet = document.getElementById('cal-add-sheet');
  if (sheet) sheet.style.transform = 'translateY(100%)';
  setTimeout(() => {
    const ov = document.getElementById('cal-add-ov');
    if (ov) ov.style.display = 'none';
  }, 320);
}
function calPickType(type, btn) {
  window._calAddType = type;
  document.querySelectorAll('.cal-type-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}
function calSaveEvent() {
  const text = (document.getElementById('cal-add-inp').value || '').trim();
  if (!text) { showToast('Введите название события'); return; }
  if (!CS) return;
  const [y,m,d] = CS.split('-').map(Number);
  const type = window._calAddType || 'событие';
  const reminder = y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0')+'T12:00';
  const ts = Date.now();
  const id = genId();
  const notes = getNotes();
  notes.unshift({
    id, title: text, body: text, label: type,
    reminder, createdAt: ts, updatedAt: ts
  });
  saveNotes(notes);
  scheduleAll(); updateReminderDot(); _reloadViews();
  closeCalAddEvent();
  calRender();
  calRenderDetail();
  showToast('✓ Добавлено: ' + text);
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
const _FOLDER_COLORS=['oklch(0.56 0.09 178)','oklch(0.62 0.08 72)','oklch(0.60 0.09 292)','oklch(0.62 0.09 25)','oklch(0.56 0.09 268)','oklch(0.56 0.08 220)'];
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
  const tint=_folderTint(folder.colorIndex,'.10');
  const line=_folderTint(folder.colorIndex,'.14');
  return '';
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
  if(isIdeaTag(tag))return IDEA_INBOX_LABEL;
  if(typeof getTagFolders==='function'){
    const folder=getTagFolders().find(item=>_tagKey(item.tag)===_tagKey(tag));
    if(folder?.label)return folder.label;
  }
  const raw=normalizeIdeaTag(tag||'');
  return raw?raw.charAt(0).toUpperCase()+raw.slice(1):'Папка';
}
let _fmodType='section'; // 'section' | 'tag'
function fmodSetType(type){
  _fmodType=type;
  const tSect=document.getElementById('fmod-tab-sect');
  const tTag=document.getElementById('fmod-tab-tag');
  const hSect=document.getElementById('fmod-hint-sect');
  const hTag=document.getElementById('fmod-hint-tag');
  const inp=document.getElementById('folder-modal-inp');
  const active='background:oklch(1 0 0);color:var(--fg);box-shadow:0 1px 4px oklch(0 0 0/.10);';
  const idle='background:transparent;color:var(--fg-l);box-shadow:none;';
  if(tSect)tSect.style.cssText=tSect.style.cssText.replace(/background:[^;]+;color:[^;]+;box-shadow:[^;]+;/,type==='section'?active:idle);
  if(tTag)tTag.style.cssText=tTag.style.cssText.replace(/background:[^;]+;color:[^;]+;box-shadow:[^;]+;/,type==='tag'?active:idle);
  if(hSect)hSect.style.display=type==='section'?'':'none';
  if(hTag)hTag.style.display=type==='tag'?'':'none';
  if(inp)inp.placeholder=type==='section'?'Название раздела…':'Тема папки (например: работа)';
}
function openFolderModal(){
  const m=document.getElementById('folder-modal');
  const inner=document.getElementById('folder-modal-inner');
  const inp=document.getElementById('folder-modal-inp');
  if(!m)return;
  _fmodType='section';
  fmodSetType('section');
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
  if(_fmodType==='tag'){
    // Создать папку-входящие (tag folder)
    if(typeof getTagFolders==='function'){
      const tagLow=_tagKey(name);
      const existing=getTagFolders();
      if(!existing.find(f=>_tagKey(f.tag)===tagLow)){
        existing.push({tag:tagLow,label:normalizeIdeaTag(name),pinned:false,createdAt:Date.now()});
        saveTagFolders(existing);
        _drillP0();
        showToast('Папка «'+name+'» создана');
      }
    }
  } else {
    // Создать раздел (user folder)
    const folders=getUserFolders();
    if(!folders.find(f=>f.name.toLowerCase()===name.toLowerCase())){
      folders.push({name,idx:folders.length});
      saveUserFolders(folders);
      loadNotes();
      showToast('Раздел «'+name+'» создан');
    }
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
  здоровье:'oklch(0.61 0.11 25)',
  покупки:'oklch(0.57 0.085 255)',
  контакт:'oklch(0.56 0.080 210)',
  событие:'oklch(0.64 0.095 82)',
  идея:'oklch(0.58 0.095 292)',
  рецепт:'oklch(0.63 0.085 62)',
  адрес:'oklch(0.58 0.080 195)',
  заметка:'oklch(0.70 0.030 210)',
  день_рождения:'oklch(0.62 0.14 340)',
  праздник:'oklch(0.65 0.14 55)'
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
  заметка:'📝',
  день_рождения:'🎂',
  праздник:'🎊'
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
  идея:'идея',идеи:'идея',idea:'идея',ideas:'идея',мысль:'идея',план:'идея',желание:'идея',
  мечта:'идея',проект:'идея',концепция:'идея',придумал:'идея',
  рецепт:'рецепт',готовить:'рецепт',блюдо:'рецепт',кулинария:'рецепт',
  ингредиенты:'рецепт',приготовить:'рецепт',
  адрес:'адрес',улица:'адрес',место:'адрес',навигатор:'адрес',маршрут:'адрес'
};

function tagsToPrimaryLabel(tags){
  if(!Array.isArray(tags)||!tags.length)return null;
  const score={};
  tags.forEach(rawTag=>{
    const t=_tagKey(rawTag);
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

// ── AI Context Engine ──────────────────────────────────────────────────────
// Трекинг поведения: сколько раз открыта каждая заметка, где сейчас пользователь
let _noteStats=null; // {id:{opens,last}} — lazy-load из localStorage
let _agentViewCtx={type:'home',name:null,tag:null}; // где сейчас пользователь

function _getNoteStats(){
  if(!_noteStats){
    try{_noteStats=JSON.parse(localStorage.getItem('rz_note_stats')||'{}');}
    catch{_noteStats={};}
  }
  return _noteStats;
}

function _trackNoteOpen(id){
  if(!id)return;
  const s=_getNoteStats();
  if(!s[id])s[id]={opens:0,last:0};
  s[id].opens++;
  s[id].last=Date.now();
  try{localStorage.setItem('rz_note_stats',JSON.stringify(s));}catch{}
  // Если заметку открыли 5+ раз — она важна, пишем в ai_memory
  if(s[id].opens===5){
    const note=getNotes().find(n=>n.id===id);
    if(note){
      const mem=getAiMemory();
      const key=`important:${id}`;
      if(!mem.find(m=>m.key===key)){
        mem.push({key,summary:`Важная заметка (открыл 5+ раз): «${(note.title||'').slice(0,60)}»`,ts:Date.now()});
        if(mem.length>30)mem.shift();
        _saveAiMemoryRaw(mem);
      }
    }
  }
}

function _buildAgentContext(){
  const stats=_getNoteStats();
  const allNotes=getNotes();
  const sections=getUserFolders?.()??[];
  const tagFolders=_ensureIdeaInboxTagFolder(allNotes);

  // Топ часто открываемых заметок
  const topNotes=allNotes
    .filter(n=>stats[n.id]?.opens>0)
    .sort((a,b)=>(stats[b.id]?.opens||0)-(stats[a.id]?.opens||0))
    .slice(0,5)
    .map(n=>({
      title:n.title||'Без названия',
      opens:stats[n.id]?.opens||0,
      section:n.aiTags?.find(t=>t.startsWith('_filed_in:'))?.slice(10)||null,
      hasReminder:!!n.reminder
    }));

  // Заметок в каждом разделе
  const sectionStats=sections.map(s=>({
    name:s.name,
    noteCount:allNotes.filter(n=>Array.isArray(n.aiTags)&&n.aiTags.includes(`_filed_in:${s.name}`)).length
  }));

  // Заметок в каждой папке входящих
  const inboxStats=tagFolders.map(f=>({
    tag:f.tag, label:f.label||f.tag,
    noteCount:allNotes.filter(n=>_noteHasAiTag(n,f.tag)).length
  })).filter(f=>f.noteCount>0);

  // Ближайшие напоминания (до 4)
  const now=Date.now();
  const upcoming=allNotes
    .filter(n=>n.reminder&&new Date(n.reminder).getTime()>now)
    .sort((a,b)=>new Date(a.reminder).getTime()-new Date(b.reminder).getTime())
    .slice(0,4)
    .map(n=>({title:n.title||'',reminder:String(n.reminder).slice(0,16)}));

  return{
    currentView:_agentViewCtx,
    topOpenedNotes:topNotes,
    sectionStats,
    inboxStats,
    upcoming,
    totalNotes:allNotes.length,
    totalSections:sections.length,
    totalInbox:tagFolders.length,
    trashCount:getTrash().length,
  };
}

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
  // Убираем старый [фото] placeholder из превью — фото хранится в note.images[]
  const body=(n.body||n.title||'').replace(/\[фото\]/g,'').trim();
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
  if(data&&data.aiTag!==undefined){drillAiTag=normalizeIdeaTag(data.aiTag);drillCategory=null;}
  if(data&&data.noteId!==undefined)drillNoteId=data.noteId;
  drillLevel=level;
  // Обновляем контекст для агента — он знает где пользователь
  if(level===0)_agentViewCtx={type:'all',name:null,tag:null};
  else if(data?.category)_agentViewCtx={type:'section',name:data.category,tag:null};
  else if(data?.aiTag)_agentViewCtx={type:'folder',name:null,tag:normalizeIdeaTag(data.aiTag)};
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
  const tagLow=_tagKey(tag);
  const folders=getTagFolders();
  const f=folders.find(x=>_tagKey(x.tag)===tagLow);
  if(!f)return;
  f.pinned=true;
  saveTagFolders(folders);
  loadNotes();
  showToast(`«${f.label||f.tag}» закреплена в разделах`);
}
function unpinTagFolder(tag){
  if(typeof getTagFolders!=='function')return;
  const tagLow=_tagKey(tag);
  const folders=getTagFolders();
  const f=folders.find(x=>_tagKey(x.tag)===tagLow);
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
  const _savedScroll=el.scrollTop; // сохранить скролл перед перерисовкой
  const notes=getNotes();
  _initPTR(el);
  const userFolders=getUserFolders();
  const tagFolders=_ensureIdeaInboxTagFolder(notes);
  const userFolderNames=userFolders.map(f=>String(f.name||'').trim().toLowerCase()).filter(Boolean);
  const tagHasUserSection=f=>!isIdeaTag(f.tag)&&userFolderNames.includes(String(f.tag||'').trim().toLowerCase());
  const pinnedFolders=tagFolders.filter(f=>f.pinned&&!tagHasUserSection(f));
  const aiOnlyFolders=tagFolders.filter(f=>!f.pinned&&!tagHasUserSection(f));

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
      const cnt=notes.filter(n=>_noteHasAiTag(n,f.tag)).length;
      h+=`<div class="sect-card sect-card-pinned" data-nav-folder="${esc(f.tag)}">
        <button type="button" class="sect-card-del" onclick="unpinTagFolder(${jsAttr(f.tag)})" title="Открепить">${_PIN_SVG}</button>
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
    const totalIncoming=aiOnlyFolders.reduce((acc,f)=>acc+notes.filter(n=>_noteHasAiTag(n,f.tag)&&!isNoteResolved(n)).length,0);
    const badge=totalIncoming>0?`<span class="drill-incoming-badge">${totalIncoming}</span>`:'';
    h+=`<div class="sect-hdr-row sect-hdr-incoming" onclick="toggleP0Inbox()">
      <span class="sect-hdr-label">Входящие</span>${badge}
      <span class="sect-hdr-chev${_p0InboxCollapsed?' collapsed':''}">${_CHEV_SVG}</span>
    </div>`;
    if(!_p0InboxCollapsed){
      aiOnlyFolders.forEach(f=>{
        const cnt=notes.filter(n=>_noteHasAiTag(n,f.tag)&&!isNoteResolved(n)).length;
        h+=`<div class="drill-sec-row drill-sec-tag drill-folder-ai" data-nav-folder="${esc(f.tag)}">
          <div class="drill-sec-ico" style="background:oklch(0.52 0.10 202 / .07);color:oklch(0.45 0.10 202);">${_TAG_SVG}</div>
          <div class="drill-sec-name">${esc(f.label||f.tag)}</div>
          <div class="drill-sec-count">${cnt}</div>
          <button type="button" class="folder-pin-btn" title="Закрепить" onclick="pinTagFolder(${jsAttr(f.tag)})">${_PIN_SVG}</button>
          <button type="button" class="folder-del-btn" title="Удалить" onclick="deleteTagFolder(${jsAttr(f.tag)})">${_X_SVG}</button>
        </div>`;
      });
    }
  }

  // ── ВСЕ ЗАМЕТКИ ──
  h+=`<button type="button" class="drill-all-notes-btn" onclick="drillGo(1,{category:null})">
    Все заметки <span class="drill-all-count">${notes.length}</span>
  </button>`;

  el.innerHTML=h;
  el.scrollTop=_savedScroll; // восстановить позицию
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
  return; // строка пилюль убрана — заменена tag picker sheet
}

function selectSectPill(type,value,label){
  if(type==='user')selectUserFolderTag(value);
  else if(type==='ai')selectAiTagFolder(value,label||value);
  else selectCat(value);
}

function deleteTagFolder(tag){
  if(typeof getTagFolders!=='function')return;
  const tagLow=_tagKey(tag);
  const folders=getTagFolders();
  const f=folders.find(x=>_tagKey(x.tag)===tagLow);
  if(!f)return;
  const label=f.label||f.tag;
  saveTagFolders(folders.filter(x=>_tagKey(x.tag)!==tagLow));
  loadNotes();
  showToast(`Папка «${label}» удалена`);
}

// Повысить AI-папку до постоянного Раздела (архива)
function promoteToSection(tag){
  const tFolders=typeof getTagFolders==='function'?getTagFolders():[];
  const tagLow=_tagKey(tag);
  const f=tFolders.find(x=>_tagKey(x.tag)===tagLow);
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
    if(Array.isArray(n.aiTags)&&n.aiTags.some(t=>_tagKey(t)===tagLow)){
      if(!getFiledFolderName(n)){
        n.aiTags=[...n.aiTags,_filedFolderTag(sectionName)];
        n.updatedAt=Date.now();filed++;
      }
    }
  });
  saveNotes(notes);
  if(typeof getTagFolders==='function'){
    saveTagFolders(tFolders.filter(x=>_tagKey(x.tag)!==tagLow));
  }
  loadAll();
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
  loadAll();
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
  // Нейтральное прозрачное стекло. Новизна = непрозрачность (новее → чуть плотнее,
  // старее → прозрачнее), без цвета. Через прозрачность виден общий фон.
  const t=total>1?i/(total-1):0;
  const a=(0.24-t*0.13).toFixed(2); // 0.24 новые → 0.11 старые (больше стекла)
  return `oklch(1 0 0 / ${a})`;
}

// ── КОМПАКТНЫЙ ВИД ЛЕНТЫ ──
let _feedView=localStorage.getItem('rz_feed_view')||(localStorage.getItem('rz_home_grid')?'grid':(localStorage.getItem('rz_compact_feed')?'compact':'list'));
const _VIEW_ICONS={
  list:'<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  compact:'<line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="13" x2="21" y2="13"/><line x1="3" y1="17" x2="21" y2="17"/><line x1="3" y1="21" x2="21" y2="21"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
};
function toggleViewMenu(e){
  if(e)e.stopPropagation();
  const m=document.getElementById('view-menu');if(!m)return;
  const willOpen=!m.classList.contains('open');
  m.classList.toggle('open',willOpen);
  if(willOpen)setTimeout(()=>document.addEventListener('click',_closeViewMenuOutside),0);
}
function _closeViewMenuOutside(ev){
  const m=document.getElementById('view-menu');
  if(m&&!m.contains(ev.target)&&!ev.target.closest('#view-mode-btn'))closeViewMenu();
}
function closeViewMenu(){
  const m=document.getElementById('view-menu');if(m)m.classList.remove('open');
  document.removeEventListener('click',_closeViewMenuOutside);
}
function setFeedView(v){
  _feedView=v;
  localStorage.setItem('rz_feed_view',v);
  localStorage.removeItem('rz_home_grid');localStorage.removeItem('rz_compact_feed');
  _applyCompactFeedState();
  closeViewMenu();
}
function _applyCompactFeedState(){
  const wrap=document.getElementById('home-feed');
  if(wrap){
    wrap.classList.toggle('compact',_feedView==='compact');
    wrap.classList.toggle('hf-grid',_feedView==='grid');
  }
  const ico=document.getElementById('view-mode-ico');
  if(ico)ico.innerHTML=_VIEW_ICONS[_feedView]||_VIEW_ICONS.list;
  document.querySelectorAll('#view-menu .view-menu-item').forEach(b=>{
    b.classList.toggle('active',b.dataset.view===_feedView);
  });
}
function _agentInboxCard(note,index){
  const preview=_notePreview(note);
  const tags=_notePreviewTags(note,{limit:3,currentTag:drillAiTag});
  const tagChips=tags.map(tag=>`<span class="agent-note-tag${isIdeaTag(tag)?' idea-tag-chip':''}">${esc(tag)}</span>`).join('');
  return `<article class="agent-note${_noteToneClass(note)}" onclick="drillPickNote(${index})" data-nid="${esc(note.id)}">
    <div class="agent-note-top">
      <span class="agent-note-dot"></span>
      <span class="agent-note-copy">
        <span class="agent-note-title">${esc(note.title)}</span>
        ${preview?`<span class="agent-note-body">${esc(preview)}</span>`:''}
        ${tagChips?`<span class="agent-note-tags">${tagChips}</span>`:''}
      </span>
      <span class="agent-note-time">${esc(fmtMeta(note.updatedAt||note.createdAt))}</span>
      <button class="inbox-del-btn" onclick="event.stopPropagation();_deleteInboxNote('${esc(note.id)}')" aria-label="Удалить">&#215;</button>
    </div>
  </article>`;
}
function _deleteInboxNote(nid){
  const all=getNotes();
  const idx=all.findIndex(n=>n.id===nid);
  if(idx>=0){
    const d=all.splice(idx,1)[0];
    d._deletedAt=Date.now();
    const tr=getTrash();
    tr.unshift(d);
    if(tr.length>50)tr.pop();
    saveTrash(tr);saveNotes(all);
    if(d.reminder)_deleteReminderFromServer(d.id);
  }
  scheduleAll();loadHomeFeed();loadNotepad();
  showToast('В корзину · можно восстановить');
  updTrashBadge();
  _drillP1();
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
  _initPTR(el);
  let notes=getNotes();
  if(drillCategory!==null)notes=notes.filter(n=>safeLabel(n.label||'\u0437\u0430\u043c\u0435\u0442\u043a\u0430')===drillCategory);
  const viewingUserFolder=drillAiTag!==null&&isUserFolderName(drillAiTag);
  if(drillAiTag!==null){
    const t=viewingUserFolder?drillAiTag.toLowerCase():_tagKey(drillAiTag);
    notes=viewingUserFolder
      ?notes.filter(n=>getFiledFolderName(n)===t)
      :notes.filter(n=>_noteHasAiTag(n,t));
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
      const cardClass=(sectionStyle?' section-glass-note':'')+_noteToneClass(n);
      const bg=sectionStyle?sectionStyle:`background:${_drillCardBg(i,notes.length)};`;
      const selGrid=_selectMode&&_selectedNoteIds.has(n.id);
      h+=`<div class="drill-grid-card${resolved?' resolved':''}${cardClass}${selGrid?' note-selected':''}" style="${bg}" data-nid="${esc(n.id)}" onclick="drillPickNote(${i})">
        <div class="note-select-circle${selGrid?' note-sel-checked':''}"></div>
        <div class="drill-grid-title">${esc(n.title)}</div>
        ${preview?`<div class="drill-grid-preview">${esc(preview)}</div>`:''}
        <div class="drill-grid-foot">
          <span class="drill-note-time">${esc(fmtMeta(n.createdAt||n.updatedAt))}</span>
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
      const tagChips=visibleTags.slice(0,3).map(t=>`<span class="drill-note-tag-chip${isIdeaTag(t)?' idea-tag-chip':''}" onclick="event.stopPropagation();drillGo(1,{aiTag:${jsAttr(t)}})">${esc(t)}</span>`).join('');
      const selRow=_selectMode&&_selectedNoteIds.has(n.id);
      h+=`<div class="drill-note-row${resolved?' resolved':''}${sectionStyle?' section-glass-note':''}${_noteToneClass(n)}${selRow?' note-selected':''}" ${sectionStyle?`style="${sectionStyle}"`:''} data-nid="${esc(n.id)}" onclick="drillPickNote(${i})">
        <div class="note-select-circle${selRow?' note-sel-checked':''}"></div>
        <div class="drill-note-body">
          <div class="drill-note-title">${esc(n.title)}</div>
          ${preview?`<div class="drill-note-preview">${esc(preview)}</div>`:''}
          <div class="drill-note-foot">
            <span class="drill-note-time">${esc(fmtMeta(n.createdAt||n.updatedAt))}</span>
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
  _attachDrillNoteSwipe(el);
}
function _drillShowMore(){
  const el=document.getElementById('drill-p1');
  const prev=el?el.scrollTop:0;
  _drillP1Limit+=10;
  _drillP1();
  if(el)requestAnimationFrame(()=>{el.scrollTop=prev;});
}
function _attachDrillNoteSwipe(root){
  if(_drillGrid||_selectMode||!root)return;
  root.querySelectorAll('.drill-note-row[data-nid]').forEach(card=>{
    if(card.parentElement?.classList.contains('drill-note-swipe-wrap'))return;
    const nid=card.dataset.nid;
    const wrap=document.createElement('div');
    wrap.className='drill-note-swipe-wrap';
    card.parentNode.insertBefore(wrap,card);
    const panel=buildNoteSwipePanel('row',20,()=>delNoteById(nid));
    wrap.appendChild(panel);
    wrap.appendChild(card);
    attachSwipeDelete(card,panel);
  });
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
  el.className='note-swipe-panel';
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
  card.addEventListener('click',e=>{
    if((_cardSwiping||isOpen)&&!e.target.closest('.del-x-btn')){
      e.preventDefault();
      e.stopImmediatePropagation();
      if(isOpen)reset();
      setTimeout(()=>{_cardSwiping=false;},0);
    }
  },true);
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
  _trackNoteOpen(id);
  _openNoteWith(n);
}
function _openNoteWith(n){
  if(n.type==='list'){openListSheet(n.id);return;}
  ST='note';EI=n.id||null;
  const delBtn=document.getElementById('tool-delete-btn');
  if(delBtn)delBtn.style.display='inline-flex';
  const moreWrap=document.getElementById('sheet-more-wrap');
  if(moreWrap)moreWrap.style.display='flex';
  document.getElementById('sheet-title').textContent='Заметка';
  document.getElementById('sheet-body').innerHTML=noteForm(n.body||n.title||'');
  {const _scc=document.getElementById('sheet-char-count');if(_scc)_scc.textContent=(n.body||n.title||'').length+' символов';}
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
  _chatNoteId=n.id;
  window._draftImages=null;
  _openSheet();
  if(n.images?.length)setTimeout(()=>_renderNoteImages(n.images),80);
}

function openSheet(type){
  ST=type;EI=null;_chatNoteId=null;
  const delBtn=document.getElementById('tool-delete-btn');
  if(delBtn)delBtn.style.display='none';
  const moreWrap=document.getElementById('sheet-more-wrap');
  if(moreWrap)moreWrap.style.display='none';
  closeSheetMoreMenu();
  document.getElementById('sheet-title').textContent='Новая заметка';
  document.getElementById('sheet-body').innerHTML=noteForm('');
  {const _scc=document.getElementById('sheet-char-count');if(_scc)_scc.textContent='0 символов';}
  // Если открываем из категории — подставляем её по умолчанию
  const defaultCat=(drillCategory&&typeof drillCategory==='string')?drillCategory:'заметка';
  showSheetCat(defaultCat);
  initSheetReminder('');
  initSheetRecurring(null);
  initSheetUndo('');
  window._draftImages=null;
  // убрать старые фото из предыдущей заметки
  document.getElementById('note-images-wrap')?.remove();
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
  // Закрываем AI overlay при открытии новой заметки
  closeAiOverlay();
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
      sa.scrollTop=0;
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
  closeAiOverlay();
  closeSheetMoreMenu();
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
  // btn всегда виден в шапке как тег-пилл
  btn.style.display='inline-flex';
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
    sheet.style.background=`radial-gradient(ellipse 120% 40% at 50% 0%, oklch(1 0 0 / 0.18), transparent 60%), oklch(0.98 ${c} ${h} / 0.20)`;
  }
  renderSectPills();
}

// ── TAG INLINE POPOVER ──
function toggleCatDropdown(){
  const dd=document.getElementById('cat-dropdown');if(!dd)return;
  if(dd.classList.contains('open')){dd.classList.remove('open');return;}
  _renderCatPills(dd);
  dd.classList.add('open');
  setTimeout(()=>document.addEventListener('click',_closeCatDD,{once:true}),10);
}
function _closeCatDD(e){
  const dd=document.getElementById('cat-dropdown');
  const btn=document.getElementById('sheet-cat-btn');
  if(dd&&!dd.contains(e.target)&&e.target!==btn&&!btn?.contains(e.target))dd.classList.remove('open');
}
function _renderCatPills(dd){
  const curBtn=document.getElementById('sheet-cat-btn');
  const curLabel=curBtn?.dataset.label||'заметка';
  const isUserFolder=curBtn?.dataset.userFolder==='1';
  const curAiTag=curBtn?.dataset.aiTagFolder||'';
  const curNote=EI?getNotes().find(n=>n.id===EI):null;
  const userFolders=getUserFolders();
  const tagFoldersList=typeof getTagFolders==='function'?getTagFolders():[];
  const pinnedList=tagFoldersList.filter(f=>f.pinned);
  const unpinnedList=tagFoldersList.filter(f=>!f.pinned);
  const close=`document.getElementById('cat-dropdown').classList.remove('open')`;
  let html=`<div class="cat-pills-wrap">`;
  // Встроенные типы
  Object.keys(STRIPES).forEach(l=>{
    const active=!isUserFolder&&!curAiTag&&curLabel===l;
    const bg=active?`background:${STRIPES[l]};border-color:transparent;`:'' ;
    html+=`<button class="cat-pill-btn${active?' active':''}" style="${bg}" onclick="selectCat('${l}');${close}">
      <span class="cat-pill-dot" style="background:${STRIPES[l]}${active?';box-shadow:0 0 0 2px oklch(1 0 0/0.4)':''}"></span>${l}</button>`;
  });
  // Мои разделы
  if(userFolders.length||pinnedList.length){
    html+=`<div class="cat-pill-sep">Мои разделы</div>`;
    userFolders.forEach((f,i)=>{
      const col=_folderColor(f.idx!==undefined?f.idx:i);
      const active=isUserFolder&&curLabel.toLowerCase()===f.name.toLowerCase();
      const bg=active?`background:${col};border-color:transparent;`:'';
      html+=`<button class="cat-pill-btn${active?' active':''}" style="${bg}" onclick="selectUserFolderTag(${jsAttr(f.name)});${close}">
        <span class="cat-pill-dot" style="background:${col}${active?';box-shadow:0 0 0 2px oklch(1 0 0/0.4)':''}"></span>${esc(f.name)}</button>`;
    });
    pinnedList.forEach(f=>{
      const col='oklch(0.55 0.12 270)';
      const active=curNote&&_noteHasAiTag(curNote,f.tag);
      const bg=active?`background:${col};border-color:transparent;`:'';
      html+=`<button class="cat-pill-btn${active?' active':''}" style="${bg}" onclick="selectAiTagFolder(${jsAttr(f.tag)},${jsAttr(f.label||f.tag)});${close}">
        <span class="cat-pill-dot" style="background:${col}${active?';box-shadow:0 0 0 2px oklch(1 0 0/0.4)':''}"></span>${esc(f.label||f.tag)}</button>`;
    });
  }
  if(unpinnedList.length){
    html+=`<div class="cat-pill-sep">Входящие</div>`;
    unpinnedList.forEach(f=>{
      const col='oklch(0.55 0.13 290)';
      const active=curNote&&_noteHasAiTag(curNote,f.tag);
      const bg=active?`background:${col};border-color:transparent;`:'';
      html+=`<button class="cat-pill-btn${active?' active':''}" style="${bg}" onclick="selectAiTagFolder(${jsAttr(f.tag)},${jsAttr(f.label||f.tag)});${close}">
        <span class="cat-pill-dot" style="background:${col}"></span>${esc(f.label||f.tag)}</button>`;
    });
  }
  html+=`<button class="cat-pill-btn cat-pill-add" onclick="openFolderModal();${close}">+ Новый раздел</button>`;
  html+='</div>';
  dd.innerHTML=html;
}
function openTagPicker(){toggleCatDropdown();}
function closeTagPicker(){document.getElementById('cat-dropdown')?.classList.remove('open');}
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
    if(sheet)sheet.style.background=`radial-gradient(ellipse 120% 40% at 50% 0%, oklch(1 0 0 / 0.18), transparent 60%), oklch(0.98 0.012 205 / 0.20)`;
  }
  document.getElementById('cat-dropdown')?.classList.remove('open');
  renderSectPills();
  saveSheetDraft();
}

function selectAiTagFolder(tag,label){
  tag=_tagKey(tag);
  label=isIdeaTag(tag)?IDEA_INBOX_LABEL:(label||tag);
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
    if(sheet)sheet.style.background='radial-gradient(ellipse 120% 40% at 50% 0%, oklch(1 0 0 / 0.18), transparent 60%), oklch(0.98 0.010 290 / 0.20)';
  }
  document.getElementById('cat-dropdown')?.classList.remove('open');
  renderSectPills();
  saveSheetDraft();
}

function initSheetReminder(val){
  const row=document.getElementById('sheet-reminder-row');
  const inp=document.getElementById('sheet-reminder-in');
  const btn=document.getElementById('sheet-reminder-btn');
  const bellBtn=document.getElementById('sheet-rem-btn');
  if(row)row.style.display=val?'flex':'none';
  if(inp)inp.value=val||'';
  if(btn)btn.textContent=val?fmtDt(val):'Выбрать время';
  if(bellBtn)bellBtn.classList.toggle('reminder-on',!!val);
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

let _rmpCal=null; // состояние кастомного календаря в rmp-ov

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
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  // Инициализируем кастомный календарь вместо нативного пикера
  _rmpCalInit();
  const ov=document.getElementById('rmp-ov');
  ov.style.display='flex';
}

function _rmpLocalStr(d){
  const pad=n=>String(n).padStart(2,'0');
  return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── RMP кастомный календарь (контекст 'rmp') ──
function _rmpCalInit(){
  let base=_rmpDate||new Date(Date.now()+3600000);
  base=new Date(base);base.setSeconds(0,0);
  const rm=Math.round(base.getMinutes()/5)*5;
  if(rm>=60){base.setHours(base.getHours()+1);base.setMinutes(0);}else base.setMinutes(rm);
  _rmpCal={year:base.getFullYear(),month:base.getMonth(),day:base.getDate(),hour:base.getHours(),min:base.getMinutes()};
  _renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');
}
function _rmpCalPick(y,m,d){if(!_rmpCal)return;_rmpCal.year=y;_rmpCal.month=m;_rmpCal.day=d;_renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');}
function _rmpCalPrevMonth(){if(!_rmpCal)return;_rmpCal.month--;if(_rmpCal.month<0){_rmpCal.month=11;_rmpCal.year--;}_renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');}
function _rmpCalNextMonth(){if(!_rmpCal)return;_rmpCal.month++;if(_rmpCal.month>11){_rmpCal.month=0;_rmpCal.year++;}_renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');}
function _rmpCalH(d){if(!_rmpCal)return;_rmpCal.hour=(_rmpCal.hour+d+24)%24;_renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');}
function _rmpCalM(d){if(!_rmpCal)return;_rmpCal.min=(_rmpCal.min+d*5+60)%60;_renderCalInto('rmp-cal-wrap',_rmpCal,'rmp');}
function _rmpCalSave(){
  if(!_rmpCal)return;
  const {year,month,day,hour,min}=_rmpCal;
  _rmpDate=new Date(year,month,day,hour,min,0,0);
  if(_rmpDate.getTime()<Date.now()){showToast('Время уже прошло — выбери будущее');return;}
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  rmpConfirm();
}

// Quick picks: offset in minutes from now
function rmpPickQuick(minutes,btn){
  _rmpDate=new Date(Date.now()+minutes*60000);
  _rmpCalInit();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
// Today at given hour:minute (if in past → tomorrow)
function rmpPickToday(h,m,btn){
  const d=new Date();d.setHours(h,m,0,0);
  if(d<=new Date())d.setDate(d.getDate()+1);
  _rmpDate=d;_rmpCalInit();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
// Tomorrow at given hour:minute
function rmpPickTomorrow(h,m,btn){
  const d=new Date();d.setDate(d.getDate()+1);d.setHours(h,m,0,0);
  _rmpDate=d;_rmpCalInit();
  document.querySelectorAll('.rmp-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
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
    const bellBtn=document.getElementById('sheet-rem-btn');
    if(inp)inp.value=val;
    if(row)row.style.display='flex';
    if(btn)btn.textContent=fmtDt(val);
    if(bellBtn)bellBtn.classList.add('reminder-on');
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

let _sheetSaveLock=false;
function saveSheet(){
  if(_sheetSaveLock)return;
  _sheetSaveLock=true;
  try{
    return _saveSheetCore();
  }finally{
    setTimeout(()=>{_sheetSaveLock=false;},700);
  }
}
function _saveSheetCore(){
  if(ST==='list'){saveListSheet();return;}
  const f=document.getElementById('sh1');
  const v1=f?f.value:'';
  const catBtn=document.getElementById('sheet-cat-btn');
  const isUserFolder=catBtn?.dataset.userFolder==='1';
  const _selectedAiTag=catBtn?.dataset.aiTagFolder?normalizeIdeaTag(catBtn.dataset.aiTagFolder):'';
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
  let aiTags=Array.isArray(prev?.aiTags)?prev.aiTags:[];
  let aiSummary=prev?.aiSummary||'';
  let aiCache=prev?.aiCache||null;
  // Если создаём заметку из тег-папки — добавляем её тег автоматически
  const drillTag=drillAiTag?normalizeIdeaTag(drillAiTag):'';
  if(existingIdx<0&&drillTag&&!aiTags.map(_tagKey).includes(_tagKey(drillTag))){
    aiTags=[...aiTags,drillTag];
  }
  // Если пользователь выбрал раздел из пикера — добавляем тег
  if(_selectedUserFolder&&!aiTags.map(t=>t.toLowerCase()).includes(_selectedUserFolder.toLowerCase())){
    aiTags=[...aiTags,_selectedUserFolder];
  }
  // Если пользователь выбрал AI-папку из пикера — добавляем её тег
  if(_selectedAiTag&&!aiTags.map(_tagKey).includes(_tagKey(_selectedAiTag))){
    aiTags=[...aiTags,_selectedAiTag];
  }
  aiTags=normalizeAiTags(aiTags.filter(tag=>!_isFiledFolderTag(tag)));
  if(_hasIdeaContext({text:v1,tags:aiTags,label:v3})){
    aiTags=normalizeAiTags([IDEA_TAG,...aiTags]);
  }
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
  // Прикреплённые фото
  const draftImgs=window._draftImages;
  if(existingIdx>=0){
    item.images=list[existingIdx].images||[];
  } else if(draftImgs?.length){
    item.images=draftImgs;
  }
  window._draftImages=null;
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
  _reloadViews();
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
  _maybeSaveIdeaToRepo({
    text:item.body,
    summary:aiSummary||`Идея: ${title}`,
    tags:aiTags,
    actions:aiCache?.actions||[],
    noteId:item.id,
    label:item.label,
    source:'save'
  }).catch(e=>console.warn('save_idea after save failed',e));
  // AI-ответ — только для новых заметок (не редактирование)
  if(wasNew&&v1.trim().length>=15){
    _fetchChatReply(item.id, v1.trim());
  }
}

function editNote(i){openNoteSheet(i);}
function editNoteById(id){openNoteSheetById(id);}

function closeSheetMoreMenu(){
  document.getElementById('sheet-more-menu')?.classList.remove('open');
  document.getElementById('sheet-more-btn')?.classList.remove('open');
}
function toggleSheetMoreMenu(event){
  event?.stopPropagation();
  const menu=document.getElementById('sheet-more-menu');
  const btn=document.getElementById('sheet-more-btn');
  if(!menu||!btn)return;
  const open=!menu.classList.contains('open');
  menu.classList.toggle('open',open);
  btn.classList.toggle('open',open);
}
function deleteOpenNoteFromMenu(){
  closeSheetMoreMenu();
  deleteOpenNote();
}
document.addEventListener('click',e=>{
  if(!e.target.closest?.('.sheet-more-wrap'))closeSheetMoreMenu();
});

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
    if(trash.length>200)trash.pop();
    saveTrash(trash);
    // Снять напоминание с сервера (иначе cron продолжит слать пуши)
    if(deleted.reminder)_deleteReminderFromServer(deleted.id);
  }
  saveNotes(notes);
  scheduleAll();
  _reloadViews();
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
  loadTrash();_reloadViews();
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
    loadTrash();_reloadViews();
  } else {
    // Note was deleted — restore from history snapshot
    sn._restoredFromHistory=true;
    delete sn._deletedAt;
    notes.push(sn);
    saveNotes(notes);
    showToast('Заметка восстановлена из истории ✓');
    loadTrash();_reloadViews();
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
      <div class="pad-meta">${esc(fmtMeta(n.createdAt||n.updatedAt))}</div>`;
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
  _reloadViews();
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

// ── ПРИКРЕПЛЕНИЕ ФОТО ──
function attachPhoto(){
  document.getElementById('photo-file-input')?.click();
}
function onPhotoFileSelected(input){
  const file=input.files?.[0];if(!file)return;
  input.value='';
  if(!file.type.startsWith('image/')){showToast('Только изображения');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image();
    img.onload=()=>{
      // Сжимаем до max 1024px по длинной стороне, JPEG 0.75
      const MAX=1024;
      let w=img.width,h=img.height;
      if(w>MAX||h>MAX){if(w>h){h=Math.round(h*MAX/w);w=MAX;}else{w=Math.round(w*MAX/h);h=MAX;}}
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const dataUrl=canvas.toDataURL('image/jpeg',0.75);
      _insertPhotoIntoNote(dataUrl);
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function _insertPhotoIntoNote(dataUrl){
  if(!EI&&!ST){showToast('Сначала открой заметку');return;}
  // Фото хранится в note.images[] и показывается как превью-плитка ниже текста.
  // Текстовый placeholder [фото] не нужен — он выглядел некрасиво в ленте.
  // Сохраняем base64 в note.images[]
  if(EI){
    const notes=getNotes();
    const n=notes.find(x=>x.id===EI);
    if(n){
      if(!n.images)n.images=[];
      n.images.push({id:genId(),data:dataUrl,addedAt:Date.now()});
      saveNotes(notes);
      _renderNoteImages(n.images);
      showToast('Фото добавлено ✓');
    }
  } else {
    // новая заметка — пока просто в draft
    if(!window._draftImages)window._draftImages=[];
    window._draftImages.push({id:genId(),data:dataUrl,addedAt:Date.now()});
    _renderNoteImages(window._draftImages);
    showToast('Фото добавлено ✓');
  }
}
function _renderNoteImages(images){
  if(!images||!images.length)return;
  let wrap=document.getElementById('note-images-wrap');
  if(!wrap){
    wrap=document.createElement('div');wrap.id='note-images-wrap';wrap.className='note-images-wrap';
    const sa=document.getElementById('sheet-scroll-area');
    if(sa)sa.appendChild(wrap);
  }
  wrap.innerHTML=images.map(img=>`
    <div class="note-img-thumb" onclick="_viewPhoto('${img.id}')">
      <img src="${img.data}" alt="фото" loading="lazy">
      <button class="note-img-del" type="button" onclick="event.stopPropagation();_deleteNotePhoto('${img.id}')" title="Удалить">×</button>
    </div>`).join('');
}
function _viewPhoto(id){
  const notes=getNotes();const n=EI?notes.find(x=>x.id===EI):null;
  const images=(n?.images||window._draftImages||[]);
  const img=images.find(x=>x.id===id);if(!img)return;
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:99999;background:oklch(0 0 0/0.85);display:flex;align-items:center;justify-content:center;';
  ov.onclick=()=>ov.remove();
  ov.innerHTML=`<img src="${img.data}" style="max-width:95vw;max-height:90vh;border-radius:12px;box-shadow:0 8px 40px oklch(0 0 0/0.5);">`;
  document.body.appendChild(ov);
}
function _deleteNotePhoto(id){
  if(EI){
    const notes=getNotes();const n=notes.find(x=>x.id===EI);
    if(n&&n.images){n.images=n.images.filter(x=>x.id!==id);saveNotes(notes);_renderNoteImages(n.images);}
  } else {
    if(window._draftImages){window._draftImages=window._draftImages.filter(x=>x.id!==id);_renderNoteImages(window._draftImages);}
  }
}

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
    .sort((a,b)=>(b.createdAt||b.updatedAt||0)-(a.createdAt||a.updatedAt||0));
  const sorted=[...pinned,...withRem,...rest].slice(0,25);
  _homeFeedNotes=sorted;

  el.innerHTML='';
  sorted.forEach((n,i)=>{
    // 🚦 Светофор: 🔴 просрочено → 🟡 есть напоминание → 🟢 просто заметка
    const remDt=n.reminder?new Date(n.reminder).getTime():0;
    const remOverdue=remDt&&remDt<=now&&!n.reminderDone;
    const remFuture=remDt&&remDt>now&&!n.reminderDone;
    const visibleTags=(n.aiTags||[]).filter(tag=>!_isFiledFolderTag(tag));
    const hasAi=!!(n.aiSummary||visibleTags.length);
    let dotClass=hasAi?'hf-dot-green':'hf-dot-none';
    if(remFuture)dotClass='hf-dot-amber';
    if(remOverdue)dotClass='hf-dot-red';

    const title=n.title||(n.body||'').split('\n')[0].trim().slice(0,60)||'Заметка';
    const preview=_notePreview(n);
    const timeStr=fmtMeta(n.createdAt||n.updatedAt);
    const aiBadge=hasAi?`<span class="hf-ai-badge">✶︎ AI</span>`:'';
    const typeTag=n.type==='list'?`<span class="hf-ai-badge" style="color:var(--accent-d);background:oklch(0.52 0.10 210/0.08);border-color:oklch(0.52 0.10 210/0.20);">☰ список</span>`:'';
    const tagChips=_notePreviewTags(n,{limit:2}).map(tag=>`<span class="hf-tag-chip${isIdeaTag(tag)?' idea-tag-chip':''}">${esc(tag)}</span>`).join('');

    // Обёртка со свайпом
    const wrap=document.createElement('div');
    wrap.className='hf-wrap';

    // Карточка
    const isRem=!!remFuture; // будущее напоминание → компактная строка с рамкой
    const card=document.createElement('button');
    const sectionStyle=_sectionNoteStyle(n);
    card.className='hf-card'+(isRem?' hf-reminder':'')+(sectionStyle?' section-glass-note':'')+_noteToneClass(n);
    if(sectionStyle)card.style.cssText=sectionStyle;
    if(!isRem)card.style.background=_drillCardBg(i,sorted.length);
    const isPinned=!!n.pinned;
    const pinIcon=isPinned?`<span class="hf-pin-mark"><svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0015 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z"/></svg></span>`:'';
    if(isPinned)card.classList.add('pinned');
    if(isRem){
      // Компактная строка напоминания: колокольчик · заголовок · время срабатывания
      card.innerHTML=`
        <span class="hf-rem-ico"><span class="hf-rem-pulse"></span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></span>
        <span class="hf-rem-title">${esc(title)}${pinIcon}</span>
        <span class="hf-rem-time">${esc(_fmtRemShort(remDt))}</span>`;
    }else{
      card.innerHTML=`
      <div class="hf-sig"><div class="hf-dot ${dotClass}"></div></div>
      <div class="hf-body">
        <div class="hf-title">${esc(title)}${pinIcon}</div>
        ${preview?`<div class="hf-preview">${esc(preview)}</div>`:''}
        ${tagChips?`<div class="hf-tags">${tagChips}</div>`:''}
        <div style="margin-top:${(hasAi||n.type==='list')?'4px':'0'}">${aiBadge}${typeTag}</div>
      </div>
      <div class="hf-right">
        <div class="hf-time">${esc(timeStr)}</div>
        <div class="hf-arr">&rsaquo;</div>
      </div>`;
    }
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
      scheduleAll();loadAll();
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
  // PTR на ленте
  _initPTR(el);
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
  _reloadViews();
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
  _reloadViews();
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
      const t=document.getElementById('sh1')?.value||'';
      if(_aiOn&&t.length>14)runAiAnalysis(t,null);
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
      _reloadViews();
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
let _agentAlts=[];
let _agentStopWAV=null; // функция остановки AudioContext-записи
const AGENT_LEAD_SILENCE_MS=250;
const AGENT_TAIL_RECORD_MS=320;
const AGENT_TRAIL_SILENCE_MS=450;

function agentTap(){
  // Разблокировка TTS на iOS — должна быть в обработчике жеста
  if(window.speechSynthesis&&!window._ttsPrimed){
    window._ttsPrimed=true;
    const u=new SpeechSynthesisUtterance('');u.volume=0;
    window.speechSynthesis.speak(u);
  }
  _agentRecording?stopAgentVoice():startAgentVoice();
}

// ── AGENT VOICE — Groq Whisper ──
// Запись: AudioContext → WAV → единый формат для серверной транскрибации
function startAgentVoice(){
  if(_agentRecording||_agentRec||_agentStopWAV)return;
  if(!CU){showToast('Сначала войдите в аккаунт');return;}
  if(navigator.mediaDevices?.getUserMedia&&(window.AudioContext||window.webkitAudioContext)){
    _startAgentVoiceWAV();
  } else {
    _startAgentVoiceSR(); // абсолютный fallback для очень старых браузеров
  }
}

// WAV-энкодер: Float32Array → ArrayBuffer (WAV/PCM)
function _encodeWAV(samples,sampleRate){
  const buf=new ArrayBuffer(44+samples.length*2);
  const v=new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');v.setUint32(4,36+samples.length*2,true);ws(8,'WAVE');
  ws(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*2,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);
  ws(36,'data');v.setUint32(40,samples.length*2,true);
  let off=44;
  for(let i=0;i<samples.length;i++,off+=2){
    const s=Math.max(-1,Math.min(1,samples[i]));
    v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);
  }
  return buf;
}

function _bufToBase64(buf){
  const b=new Uint8Array(buf);let s='';
  for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);
  return btoa(s);
}

function _padAgentPCM(pcm,sampleRate){
  const lead=Math.round(sampleRate*AGENT_LEAD_SILENCE_MS/1000);
  const trail=Math.round(sampleRate*AGENT_TRAIL_SILENCE_MS/1000);
  const padded=new Float32Array(lead+pcm.length+trail);
  padded.set(pcm,lead);
  return padded;
}

async function _startAgentVoiceWAV(){
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{
      channelCount:1,
      echoCancellation:true,
      noiseSuppression:true,
      autoGainControl:true
    }});
    const AC=window.AudioContext||window.webkitAudioContext;
    const ctx=new AC({sampleRate:16000});
    if(ctx.state==='suspended'&&ctx.resume)await ctx.resume();
    const actualRate=ctx.sampleRate;
    const src=ctx.createMediaStreamSource(stream);
    const proc=ctx.createScriptProcessor(4096,1,1);
    const gain=ctx.createGain();gain.gain.value=0; // без фидбека в колонки
    const chunks=[];
    proc.onaudioprocess=e=>{chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));};
    src.connect(proc);proc.connect(gain);gain.connect(ctx.destination);
    _agentRecording=true;_setAgentState('listening');

    _agentStopWAV=async()=>{
      _agentStopWAV=null;
      await new Promise(r=>setTimeout(r,AGENT_TAIL_RECORD_MS));
      proc.disconnect();src.disconnect();stream.getTracks().forEach(t=>t.stop());
      ctx.close();_agentRecording=false;

      const total=chunks.reduce((s,c)=>s+c.length,0);
      if(total<actualRate*0.3){showToast('Не услышал — попробуйте ещё раз');_setAgentState('idle');return;}

      const localStart=performance.now();
      const pcm=new Float32Array(total);let off=0;
      chunks.forEach(c=>{pcm.set(c,off);off+=c.length;});
      const wav=_encodeWAV(_padAgentPCM(pcm,actualRate),actualRate);
      const b64=_bufToBase64(wav);
      const encodeMs=Math.round(performance.now()-localStart);

      _setAgentState('transcribing');
      try{
        const sess=await sb.auth.getSession();
        const token=sess?.data?.session?.access_token;
        if(!token){showToast('Войдите в аккаунт');_setAgentState('idle');return;}
        const sttStart=performance.now();
        const res=await fetch(SUPABASE_EDGE_URL,{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
          body:JSON.stringify({action:'transcribe',payload:{audio_base64:b64}})
        });
        const data=await res.json();
        console.info('[rz] agent voice timing', {
          encode_ms: encodeMs,
          stt_roundtrip_ms: Math.round(performance.now()-sttStart),
          provider: data?.provider,
          provider_ms: data?.duration_ms,
          audio_sec: Math.round((total/actualRate)*10)/10,
          wav_kb: Math.round(wav.byteLength/1024)
        });
        if(!res.ok||data.error){
          console.warn('[rz] transcribe failed:',data.error,data.groq_status,data.groq_detail);
          const diag=data.groq_status?` [${data.groq_status}${data.groq_detail?': '+String(data.groq_detail).slice(0,60):''}]`:'';
          showToast('Не удалось распознать'+diag);
          _setAgentState('idle');return;
        }
        const text=(data.text||'').trim();
        if(!text){showToast('Не услышал — попробуйте ещё раз');_setAgentState('idle');return;}
        showToast('🎙 «'+text.slice(0,50)+(text.length>50?'…':'')+'»');
        _processAgentQuery(text,[]);
      }catch(e){
        console.warn('[rz] transcribe network error:',e);
        showToast('Нет сети — попробуйте ещё раз');
        _setAgentState('idle');
      }
    };
  }catch(e){
    console.warn('[rz] AudioContext unavailable:',e);
    showToast('Нет доступа к микрофону');
    _setAgentState('idle');
  }
}

// Абсолютный fallback: Web Speech API (только если AudioContext недоступен)
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
    if(text){showToast('🎙 «'+text.slice(0,50)+(text.length>50?'…':'')+'»');_processAgentQuery(text,_agentAlts);}
    else{showToast('Не услышал — попробуйте ещё раз');_setAgentState('idle');}
  };
  _agentRec.start();
}

function stopAgentVoice(){
  if(_agentStopWAV){_agentStopWAV();}
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
  }else if(state==='speaking'){
    btn?.classList.add('agent-thinking');
    if(lbl){lbl.textContent='Говорю...';lbl.style.opacity='1';}
  }else{
    if(lbl){lbl.textContent='';lbl.style.opacity='0';}
  }
}

// ── Сессионная память разговора с агентом ─────────────────────────────────
let _agentHistory=[];      // [{user,agent,intent}] — последние 4 хода
let _agentHistoryTs=0;     // timestamp последнего хода
const _HISTORY_TTL=15*60*1000; // 15 мин без активности → сброс

function _pushAgentHistory(userText,agentResponse,intent){
  const now=Date.now();
  if(now-_agentHistoryTs>_HISTORY_TTL)_agentHistory=[];  // пауза → чистый лист
  _agentHistoryTs=now;
  _agentHistory.push({
    user:userText.slice(0,160),
    agent:(agentResponse||'').slice(0,300),
    intent:intent||''
  });
  if(_agentHistory.length>4)_agentHistory.shift();  // держим только 4 хода
}

function _syncAppVersionBadge(){
  const el=document.getElementById('app-version-badge');
  if(!el)return;
  fetch('sw.js?v='+Date.now(),{cache:'no-store'})
    .then(r=>r.ok?r.text():'')
    .then(t=>{
      const m=String(t).match(/const CACHE = ['"]rz-v(\d+)['"]/);
      if(m?.[1])el.textContent=m[1]; // только цифра: "286"
    })
    .catch(()=>{});
}

function _agentRouteWord(text,variants){
  return new RegExp(`(^|[^a-zа-я0-9_])(?:${variants})(?=$|[^a-zа-я0-9_])`).test(text);
}
function _agentRouteStarts(text,variants){
  return new RegExp(`^(?:${variants})(?=$|[^a-zа-я0-9_])`).test(text);
}

function _agentRoutingPlan(text){
  const t=String(text||'').toLowerCase().replace(/ё/g,'е').trim();
  // Продолжение — ссылки на уже сказанное: «это/этом/которую/него» и т.д.
  const continuation=_agentRouteWord(t,'это|эту|этот|эта|этом|этого|этому|этими|той|ту|ее|него|ней|них|последн[a-zа-я0-9_]*|предыдущ[a-zа-я0-9_]*|перв[a-zа-я0-9_]*|здесь|сюда|туда|тогда|давай|которую|которого|которой|которые|которых');
  const quickWrite=_agentRouteStarts(t,'запиши|запомни|создай|добавь|сохрани')
    && !_agentRouteWord(t,'найди|покажи|напомни|напоминай|напоминани[а-я]*|удали|отмени|прочитай|озвуч[a-zа-я0-9_]*|разбер[a-zа-я0-9_]*|проанализ[a-zа-я0-9_]*');
  const reminder=_agentRouteWord(t,'напомни|напоминай|напоминалк[а-я]*|поставь напоминание|добавь напоминание|создай напоминание|будильник');
  // Напоминание со ссылкой на контекст заметок — нужны notes
  const reminderNeedsNotes=reminder&&(continuation||/что (я |мне |мы |нам |нужно |надо |было |хотел|хотела|планировал|собирался|собиралась)/.test(t));
  const destructive=_agentRouteWord(t,'удали|сотри|отмени|убери');
  const noteAction=_agentRouteWord(t,'найди|покажи|открой|прочитай|расскажи|перечисли|озвуч[a-zа-я0-9_]*|разбер[a-zа-я0-9_]*|разбери|проанализ[a-zа-я0-9_]*|посмотри');
  const tagAction=_agentRouteWord(t,'тег|ярлык')&&_agentRouteWord(t,'добавь|поставь|пометь|отнеси|разбери');
  const broadNotes=/(сводк|что у меня|что запис|что есть|за день|все замет|всё что|список дел)/.test(t);
  const plan=_agentRouteWord(t,'план[а-я]*|маршрут|составь|составить|распланируй|порядок дел|расписани[а-я]*');

  let profile='light';
  if(quickWrite||(reminder&&!reminderNeedsNotes))profile='none';
  if(reminderNeedsNotes||destructive||tagAction||noteAction||continuation)profile='notes';
  if(broadNotes||plan)profile='deep';

  const deep=profile==='deep';
  const notes=profile==='notes'||deep;
  return{
    profile,
    noteLimit:deep?40:(notes?12:0),
    bodyLimit:deep?400:(notes?140:0),
    includeMemory:deep,
    includeHistory:continuation&&_agentHistory.length>0,
    includeAppContext:deep
  };
}

async function _processAgentQuery(text,alts=[]){
  window.speechSynthesis?.cancel(); // прерываем озвучку если агент уже говорит
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
    const routing=_agentRoutingPlan(text);
    const memoryContext=routing.includeMemory?(getAiMemoryContext?.()??[]):[];
    const _allNotes=getNotes();
    const _tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const _fmtDate=(ts)=>{
      if(!ts)return null;
      try{return new Date(ts).toLocaleString('sv-SE',{timeZone:_tz}).slice(0,16);}catch{return null;}
    };
    const recentNotes=routing.noteLimit?_allNotes.slice(0,routing.noteLimit).map((n,i)=>({
      index:i,
      title:n.title||'Без названия',
      body:(n.body||n.items?.map(x=>x.text||x).join(', ')||'').slice(0,routing.bodyLimit),
      createdAt:_fmtDate(n.createdAt||n.id),   // когда создана (локальное время)
      updatedAt:_fmtDate(n.updatedAt),           // когда последний раз редактирована
      hasReminder:!!n.reminder,
      isRecurring:!!n.recurring,
      reminderTime:n.reminder||null,
      section:n.aiTags?.find(t=>t.startsWith('_filed_in:'))?.slice(10)||null // в каком разделе
    })):[];
    // Отправляем альтернативы только если они отличаются от основного текста
    const alternatives=alts.filter(a=>a&&a!==text).slice(0,2);
    // Разделы пользователя — агент знает куда предложить сохранить
    const userFolders=(getUserFolders?.()??[]).map(f=>f.name).filter(Boolean);
    const appContext=routing.includeAppContext?_buildAgentContext():{currentView:_agentViewCtx};
    const res=await fetch(SUPABASE_EDGE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({action:'agent_query',payload:{text,alternatives,memoryContext,recentNotes,userFolders,contextProfile:routing.profile,clientNow:new Date().toISOString(),clientTz:Intl.DateTimeFormat().resolvedOptions().timeZone,conversationHistory:routing.includeHistory?_agentHistory:undefined,appContext}}),
      signal:ac.signal
    });
    _cleanTimers();
    let data;
    try{data=await res.json();}catch(e){showToast('Ошибка ответа сервера');_setAgentState('idle');return;}
    _setAgentState('idle');
    if(!res.ok||data.error){showToast('Агент: '+(data.error||'ошибка '+res.status));return;}
    if(!data.intent){showToast('Агент не понял намерение');return;}
    _pushAgentHistory(text,data.response,data.intent);
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
    const note={id,title:params.title||auto.title,body:params.body||originalText,
      label:auto.label||'заметка',createdAt:ts,updatedAt:ts,fromPad:true,
      ...(aiTags.length?{aiTags}:{})};
    notes.push(note);
    params.createdNoteId=id;
    params.createdNoteTitle=note.title;
    saveNotes(notes);_reloadViews();
  }

  if(intent==='SET_REMINDER'){
    const ts=Date.now();const notes=getNotes();const id=genId();
    const body=params.body||originalText;
    const reminderTime=parseVoiceReminder(originalText)||parseVoiceReminder(params.when||'')||null;
    const auto=analyzeText(body);
    const note={id,title:params.title||auto.title,body,label:'заметка',
      reminder:reminderTime,  // parseVoiceReminder уже возвращает ISO
      createdAt:ts,updatedAt:ts};
    notes.push(note);
    params.createdNoteId=id;
    params.createdNoteTitle=note.title;
    saveNotes(notes);
    if(reminderTime)_handleReminderAfterSave(reminderTime,id,params.title||auto.title,body.slice(0,200));
    loadAll();
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
    if(count){saveNotes(notes);scheduleAll();loadAll();
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
      _reloadViews();updTrashBadge();
      showToast(count===1?'Заметка в корзине':'В корзину: '+count+' заметок');
    } else showToast('Заметка не найдена');
  }

  if(intent==='CREATE_TAG_FOLDER'){
    const tag=_tagKey(params.tag||params.label||'');
    const label=isIdeaTag(tag)?IDEA_INBOX_LABEL:(params.label||tag);
    if(tag&&!_isJunkTag(tag)&&typeof getTagFolders==='function'){
      const folders=getTagFolders();
      if(!folders.some(f=>_tagKey(f.tag)===tag)){
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
      params.createdNoteId=notes[existIdx].id;
      params.createdNoteTitle=notes[existIdx].title||title;
      saveNotes(notes);
      _handleReminderAfterSave(nextTs,notes[existIdx].id,title,title);
    } else {
      const ts=Date.now();const id=genId();
      const note={id,title,body:title,label:'заметка',
        reminder:_tsToIso(nextTs),recurring:{times,days:params.days||'daily'},
        createdAt:ts,updatedAt:ts};
      notes.push(note);
      params.createdNoteId=id;
      params.createdNoteTitle=note.title;
      saveNotes(notes);
      _handleReminderAfterSave(nextTs,id,title,title);
    }
    loadAll();
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
    const tag=_tagKey(params.tag||'');
    const idx=typeof params.noteIndex==='number'?params.noteIndex:0;
    if(tag){
      const notes=getNotes();
      const note=notes[idx];
      if(note){
        if(!Array.isArray(note.aiTags))note.aiTags=[];
        if(!note.aiTags.map(_tagKey).includes(tag)){
          note.aiTags=normalizeAiTags([...note.aiTags,tag]);
          note.updatedAt=Date.now();
          saveNotes(notes);loadAll();
        }
        // Создать тег-папку если нет (мусорные теги пропускаем)
        if(typeof getTagFolders==='function'&&!_isJunkTag(tag)){
          const folders=getTagFolders();
          if(!folders.some(f=>_tagKey(f.tag)===tag)){
            folders.push({tag,label:isIdeaTag(tag)?IDEA_INBOX_LABEL:(params.tag||tag),createdAt:Date.now()});
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
      saveNotes(notes);loadAll();
    }
  }

}

function _agentPickOption(query){
  document.getElementById('agent-card')?.remove();
  if(query)_processAgentQuery(query);
}

// ── TTS — озвучка ответа агента ──
// ── Голос агента ─────────────────────────────────────────────────────────────
function _agentVoiceEnabled(){return localStorage.getItem('rz_agent_voice')==='1';}
function _setAgentVoice(on){
  localStorage.setItem('rz_agent_voice',on?'1':'0');
  document.querySelectorAll('.agent-card-speak').forEach(b=>{
    b.classList.toggle('voice-on',on);
    b.title=on?'Выключить голос':'Включить голос';
  });
}
function _speakBtnTap(response){
  if(_agentVoiceEnabled()){
    window.speechSynthesis?.cancel();
    _setAgentVoice(false);
    _setAgentState('idle');
  } else {
    _setAgentVoice(true);
    _agentSpeak(response);
  }
}

function _agentSpeak(text){
  if(!text||!window.speechSynthesis)return;
  window.speechSynthesis.cancel();
  const utt=new SpeechSynthesisUtterance(text.slice(0,300));
  utt.lang='ru-RU';utt.rate=0.92;utt.pitch=1.05;
  // Выбрать русский голос если есть
  const voices=window.speechSynthesis.getVoices();
  const ruVoice=voices.find(v=>v.lang.startsWith('ru'));
  if(ruVoice)utt.voice=ruVoice;
  _setAgentState('speaking');
  utt.onend=()=>_setAgentState('idle');
  utt.onerror=()=>_setAgentState('idle');
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
      const noteId=params?.createdNoteId||'';
      const noteTitle=params?.createdNoteTitle||getNotes().find(n=>n.id===noteId)?.title||'заметку';
      openBtn=noteId
        ?`<button class="agent-card-open" onclick="_closeAgentCard(this);openNoteSheetById(${jsAttr(noteId)})">Открыть «${esc(noteTitle.slice(0,28))}»</button>`
        :`<button class="agent-card-open" onclick="_agentOpenNote(0)">Открыть заметку</button>`;
    }
  } else if(['SET_REMINDER','SET_RECURRING'].includes(intent)){
    const noteId=params?.createdNoteId||'';
    const noteTitle=params?.createdNoteTitle||getNotes().find(n=>n.id===noteId)?.title||'напоминание';
    openBtn=noteId
      ?`<button class="agent-card-open" onclick="_closeAgentCard(this);openNoteSheetById(${jsAttr(noteId)})">Открыть «${esc(noteTitle.slice(0,28))}»</button>`
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
    const folderLabel=isIdeaTag(params.tag)?IDEA_INBOX_LABEL:(params.label||params.tag);
    openFolderBtn=`<button class="agent-card-open" onclick="_agentOpenFolder(${jsAttr(params.tag)})">Открыть «${esc(String(folderLabel).slice(0,25))}»</button>`;
    promoteBtn=`<button class="agent-card-promote" onclick="promoteToSection(${jsAttr(params.tag)});_closeAgentCard(this);">📚 В Архив</button>`;
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

  // Строка продолжения диалога — всегда в конце карточки
  const askRow=`<div class="agent-card-ask">
    <input class="agent-card-ask-inp" placeholder="Спросить ещё…"
      onkeydown="if(event.key==='Enter'){const v=this.value.trim();if(v){_closeAgentCard(this);_processAgentQuery(v,[]);}}"
    >
    <button class="agent-card-ask-send" onclick="const inp=this.previousElementSibling;const v=inp?.value?.trim();if(v){_closeAgentCard(this);_processAgentQuery(v,[]);}" title="Отправить">↵</button>
    <button class="agent-card-ask-mic" onclick="_closeAgentCard(this);agentTap()" title="Голос">🎙</button>
  </div>`;

  // Для CLARIFY: только варианты + мелкая «Отмена»; для остальных — кнопка «Готово»
  const closeBtn=isClarify
    ?`<button class="agent-card-cancel" onclick="_closeAgentCard(this)">Отмена</button>`
    :`<button class="agent-card-btn" onclick="_closeAgentCard(this)">Готово</button>`;

  const card=document.createElement('div');
  card.id='agent-card';card.className='agent-card';
  const voiceOn=_agentVoiceEnabled();
  const speakBtn=window.speechSynthesis
    ?`<button class="agent-card-speak${voiceOn?' voice-on':''}" onclick="_speakBtnTap(${jsAttr(response)})" title="${voiceOn?'Выключить голос':'Включить голос'}">🔊</button>`:'';
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
    ${askRow}
    ${closeBtn}
  </div>`;
  // Клик на затемнённый фон = закрыть (только для autoClose карточек)
  if(autoClose){
    card.addEventListener('click',e=>{if(e.target===card){_closeAgentCard(card);}},{passive:true});
  }
  document.body.appendChild(card);
  requestAnimationFrame(()=>card.classList.add('show'));
  if(autoClose)setTimeout(()=>{_closeAgentCard(card);},7000);
  // Автовоспроизведение — если голос включён
  if(voiceOn&&response){setTimeout(()=>_agentSpeak(response),350);}
}

// Закрыть карточку агента — единственная точка закрытия, всегда останавливает TTS
function _closeAgentCard(el){
  const card=el?.closest?.('.agent-card')||document.getElementById('agent-card');
  if(!card)return;
  window.speechSynthesis?.cancel();
  _setAgentState('idle');
  card.classList.remove('show');
  setTimeout(()=>card?.remove(),380);
}

// Переход к папке или разделу из карточки агента
function _agentOpenFolder(tag){
  window.speechSynthesis?.cancel();_setAgentState('idle');
  document.getElementById('agent-card')?.remove();
  go('notes');
  setTimeout(()=>{drillGo(1,{aiTag:tag});},160);
}

function _agentOpenNote(idx){
  window.speechSynthesis?.cancel();_setAgentState('idle');
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
  const tagQuery=_tagKey(q);
  function match(n){
    return (n.title||'').toLowerCase().includes(lq)
      ||(n.body||'').toLowerCase().includes(lq)
      ||(n.aiSummary||'').toLowerCase().includes(lq)
      ||(n.aiTags||[]).filter(t=>!_isFiledFolderTag(t)).some(t=>t.toLowerCase().includes(lq)||(tagQuery&&_tagKey(t).includes(tagQuery)))
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
  window.speechSynthesis?.cancel();_setAgentState('idle');
  document.getElementById('agent-card')?.remove();
  if(!planText||planText.length<5)return;
  const ts=Date.now();const id=genId();const notes=getNotes();
  const title='План — '+new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  notes.unshift({id,title,body:planText,label:'заметка',createdAt:ts,updatedAt:ts});
  saveNotes(notes);loadAll();
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
      if(dt.getTime()<now-5*60*1000&&!n.recurring?.times?.length&&!n.reminderDone){
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

// Перерисовать все основные списки (без idle tasks)
function _reloadViews(){
  loadHomeFeed();
  loadNotes();
  loadNotepad();
}

// ── LOAD ALL — с дебаунсом 40ms ──
// Несколько вызовов в одном тике сливаются в один рендер.
let _loadAllT=null;
function loadAll(){
  clearTimeout(_loadAllT);
  _loadAllT=setTimeout(_doLoadAll,40);
}
function _doLoadAll(){
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

  // НЕ перезагружаемся автоматически при обновлении SW — это давало «рывок»
  // и долгий старт (перезагрузка посреди запуска). Новый SW (skipWaiting+claim)
  // возьмёт управление и отдаст свежие файлы при СЛЕДУЮЩЕМ открытии приложения.
  // Так старт всегда мгновенный, а обновление подхватывается на следующий запуск.
});

// ── INIT ──
// Логотип — чистый CSS-анимация, никакого JS не нужно.
// Google Fonts использует display=swap, поэтому логотип виден сразу.

initAuth();
_syncAppVersionBadge();
