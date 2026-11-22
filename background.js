// background.js — service worker：解鎖狀態、解密、回應其他頁面、閒置自動鎖定
//
// 解密只在這裡進行。其他頁面以 chrome.runtime.sendMessage({ type, ...參數 }) 呼叫，
// 回應一律是 { ok: true, ...結果 } 或 { ok: false, error: 錯誤代碼, message: 說明 }。
//
// ## 兩種解鎖狀態（互不影響）
//
// - 檢舉頁：所有檢舉頁共用一份解鎖狀態（storage.session 的 reportKey）。
//   解鎖一次後連續檢舉都不用再解鎖；閒置 10 分鐘或關閉瀏覽器時鎖定。
// - 選項頁：每個分頁各自解鎖。解鎖時回傳一個隨機 token，選項頁只把它放在 JS 變數裡，
//   之後每個請求都要帶 token。分頁關閉或重新整理後 token 就不見了，必須重新輸入密碼；
//   分頁關閉時也會刪掉該分頁的金鑰。同樣閒置 10 分鐘鎖定。
// - 修改主密碼、清除所有資料時，檢舉頁的解鎖狀態與其他選項頁分頁的解鎖狀態都會清除。
//
// ## 訊息來源（三種）
//
// - 選項頁（options）：options/options.html
// - 檢舉頁（report）：檢舉頁面上的 content script（content/*.js）
// - 解鎖視窗（unlockWindow）：unlock/unlock.html，由 background 以 chrome.windows.create 開啟的小視窗。
//   檢舉頁的主密碼只在這個擴充功能自己的視窗裡輸入，不會出現在檢舉網站的頁面上，
//   content script 與網站本身都碰不到主密碼。同一時間只開一個（視窗 id 存在 storage.session）。
//
// ## 訊息類型（「來源」為允許送出該訊息的頁面）
//
//   type             參數                          回傳                                    來源
//   ---------------  ----------------------------  --------------------------------------  ------------
//   status           —                             setUp, unlocked                         選項頁、檢舉頁
//   unlock           password                      選項頁：token                           選項頁、解鎖視窗
//   lock             —                             —                                       選項頁、檢舉頁
//   setup            password                      token（設定後此分頁即為解鎖狀態）       選項頁
//   getData          —                             data（完整資料）                        選項頁
//   savePersonal     personal                      —                                       選項頁
//   changePassword   oldPassword, newPassword      —（此分頁以新密碼保持解鎖）             選項頁
//   clearAll         —                             —（清除所有資料並全部鎖定）             選項頁
//   getD0101Fields   —                             fields：D0101 需要的五個欄位            檢舉頁（限 D0101）
//   openOptions      —                             —（打開設定頁）                         檢舉頁
//   openUnlock       —                             —（打開解鎖視窗；已開著就拉到前面）     檢舉頁
//   getPresets       —                             combos, places, limit（清單與每種的筆數上限）檢舉頁
//   addCombo         combo                         id（新增常用組合）                      檢舉頁
//   addPlace         place                         id（新增常用地點）                      檢舉頁
//   renamePreset     kind（combo|place）, id, name —                                       選項頁
//   deletePreset     kind（combo|place）, id       —                                       選項頁
//   exportPresets    —                             combos, places（不含 id，供匯出成檔案）  選項頁
//   importPresets    file（匯出檔解析後的物件）    addedCombos, addedPlaces, skipped       選項頁
//
// 閒置計時（10 分鐘）：只有「實際用到金鑰」而且成功的請求才重新計時（RENEWS_TIMER）。
//   重新計時：unlock、setup、getData、savePersonal、changePassword、getD0101Fields、
//             getPresets、addCombo、addPlace、renamePreset、deletePreset、exportPresets、importPresets
//   不重新計時：status、lock、openOptions、openUnlock、clearAll（只查詢或切換狀態；
//             例如一直重新整理檢舉頁，面板每次都呼叫 status，10 分鐘後仍會鎖定）
//   檢舉頁與選項頁套用同一個原則。unlock、setup 本來就會從現在開始計時。
//   請求附上 passive: true 時不重新計時：D0102 面板載入時自動取得清單（getPresets）用這個，
//   所以一直重新整理 D0102 也不會延長解鎖時間。passive 只能讓請求「不延長」，不能延長。
//
// getD0101Fields 只接受 /TTPB/D0101；getPresets、addCombo、addPlace 只接受 /TTPB/D0102
// （完整比對路徑，查詢參數與 # 不影響）。檢舉頁一律只接受 port 3444。
// 選項頁送出的每個訊息都要附上 token（unlock、setup 前還沒有，可省略）。token 只對取得它的那個分頁有效。
// unlocked 指的是「送出請求的這一方」是否已解鎖：檢舉頁與解鎖視窗看 reportKey，選項頁看自己的 token。
// 檢舉頁永遠不能呼叫 getData，只能拿到「這一頁填表需要的欄位」：D0101 的五個個人資料欄位，
// 或 D0102 的常用組合／常用地點清單（不含個人資料）。檢舉頁只能新增常用組合／地點，改名與刪除只能在選項頁。
//
// 常用資料的筆數上限（SPEC「常用資料的筆數上限」）：
//   - 常用地點、常用違規各自最多 PRESET_LIMIT 筆，由這裡強制執行（addPlace、addCombo、importPresets）
//   - 舊版留下超過上限的資料保留不動，只是不能再新增
//
// 常用資料的匯出與匯入（SPEC「常用資料的匯出與匯入」）：
//   - 只包含 combos、places；不含個人資料、主密碼、salt 或任何金鑰
//   - 匯出檔：{ app: 'walkers-gavel', type: 'presets', formatVersion: 1, exportedAt, combos, places }，
//     由選項頁組成並下載（沒有加密）；每一筆不含 id
//   - 匯入：整份檔案視為不可信任的資料，全部驗證通過才寫入（任何一筆不符 → 錯誤，現有資料完全不變）；
//     合併到現有清單後面並產生新的 id；與現有項目內容（name 以外的欄位）完全相同的略過
//
// 資料格式（存在加密資料的 combos、places 陣列中）：
//   combo: { id, name, choseType: {value, text}, law: {value, text} }
//   place: { id, name, city: {value, text}, village: {value, text}, road: {value, text}, road2: {value, text},
//            street, alley, lane, subLane, no }
//
// ## 通知檢舉頁（background → content script）
//
// 檢舉頁的解鎖狀態改變時（解鎖、手動鎖定、自動鎖定、修改主密碼、清除資料），
// 以 chrome.tabs.sendMessage 送 { event: 'reportLockChanged' } 給所有檢舉頁分頁的 content script，
// 面板收到後重新查詢 status 並更新畫面。訊息不含任何資料。
//
// 錯誤代碼：LOCKED（未解鎖）、NOT_SET_UP、ALREADY_SET_UP、WRONG_PASSWORD、
//           BAD_REQUEST、FORBIDDEN（來源不允許）、UNKNOWN_TYPE、LIMIT（常用資料已達上限）、
//           BAD_VAULT（加密資料格式不支援或已損毀）、INTERNAL
//
// ## chrome.storage.session 的內容（只在記憶體，關閉瀏覽器即消失）
//
//   reportKey            檢舉頁的金鑰（raw bytes，base64）
//   reportLastActivity   檢舉頁最後一次請求的時間（ms）
//   optionsSessions      { [token]: { key, tabId, lastActivity } }：選項頁各分頁的解鎖狀態
//   unlockWindowId       目前開著的解鎖視窗 id（沒有開著時不存在）

import * as store from './lib/store.js';
import { toBase64, fromBase64 } from './lib/crypto.js';

const AUTO_LOCK_MS = 10 * 60 * 1000; // 閒置自動鎖定，固定 10 分鐘
const REPORT_ALARM = 'autolock-report';
const OPTIONS_ALARM = 'autolock-options';
const MIN_PASSWORD_LENGTH = 8;
const OPTIONS_URL = chrome.runtime.getURL('options/options.html');
const REPORT_PAGE = /^https:\/\/tvrweb\.typd\.gov\.tw:3444\/TTPB\//; // 只接受檢舉系統的 port 3444
const REPORT_MATCH = 'https://tvrweb.typd.gov.tw:3444/TTPB/*'; // 與 manifest 的 matches 相同
const UNLOCK_URL = chrome.runtime.getURL('unlock/unlock.html');
const UNLOCK_WINDOW = { width: 380, height: 210 };
const session = chrome.storage.session;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 所有會讀寫解鎖狀態的工作依序執行，避免同時進來的請求互相覆蓋
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

// ---- 檢舉頁的解鎖狀態 ----

async function setReportKey(rawKey) {
  await session.set({ reportKey: toBase64(rawKey), reportLastActivity: Date.now() });
  await chrome.alarms.create(REPORT_ALARM, { when: Date.now() + AUTO_LOCK_MS });
}

async function lockReport() {
  const { reportKey } = await session.get('reportKey');
  await session.remove(['reportKey', 'reportLastActivity']);
  await chrome.alarms.clear(REPORT_ALARM);
  if (reportKey) notifyReportTabs();
}

// 取得金鑰；若已超過閒置時間（例如 alarm 未觸發），立即鎖定
async function getReportKey() {
  const { reportKey, reportLastActivity } = await session.get(['reportKey', 'reportLastActivity']);
  if (!reportKey) return null;
  if (!reportLastActivity || Date.now() - reportLastActivity >= AUTO_LOCK_MS) {
    await lockReport();
    return null;
  }
  return fromBase64(reportKey);
}

// 通知所有檢舉頁分頁的面板重新查詢狀態（不等待結果；沒有面板的分頁會失敗，忽略即可）
function notifyReportTabs() {
  chrome.tabs.query({ url: REPORT_MATCH }).then(tabs => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { event: 'reportLockChanged' }, { frameId: 0 }).catch(() => {});
    }
  }).catch(() => {});
}

// 重新計時（只在用到金鑰的請求成功後呼叫）
async function touchReport() {
  const key = await getReportKey();
  if (key) await setReportKey(key);
}

// ---- 選項頁各分頁的解鎖狀態 ----

// 讀出所有分頁的狀態，順便移除已閒置逾時的
async function getSessions() {
  const { optionsSessions = {} } = await session.get('optionsSessions');
  const now = Date.now();
  let changed = false;
  for (const [t, s] of Object.entries(optionsSessions)) {
    if (now - s.lastActivity >= AUTO_LOCK_MS) { delete optionsSessions[t]; changed = true; }
  }
  if (changed) await putSessions(optionsSessions);
  return optionsSessions;
}

// 寫回，並把 alarm 排在最早會逾時的那個分頁
async function putSessions(sessions) {
  const list = Object.values(sessions);
  if (list.length === 0) {
    await session.remove('optionsSessions');
    await chrome.alarms.clear(OPTIONS_ALARM);
    return;
  }
  await session.set({ optionsSessions: sessions });
  const earliest = Math.min(...list.map(s => s.lastActivity));
  await chrome.alarms.create(OPTIONS_ALARM, { when: earliest + AUTO_LOCK_MS });
}

function dropTab(sessions, tabId) {
  for (const [t, s] of Object.entries(sessions)) if (s.tabId === tabId) delete sessions[t];
}

async function openOptionsSession(rawKey, tabId) {
  const sessions = await getSessions();
  dropTab(sessions, tabId); // 同一分頁重新整理前留下的舊狀態
  const token = crypto.randomUUID();
  sessions[token] = { key: toBase64(rawKey), tabId, lastActivity: Date.now() };
  await putSessions(sessions);
  return token;
}

// token 必須存在，而且是由送出請求的這個分頁取得的
function validSession(sessions, token, tabId) {
  if (typeof token !== 'string' || !Object.hasOwn(sessions, token)) return null;
  return sessions[token].tabId === tabId ? sessions[token] : null;
}

async function getOptionsKey(token, tabId) {
  const s = validSession(await getSessions(), token, tabId);
  return s ? fromBase64(s.key) : null;
}

// 沒有有效 token → 清掉這個分頁殘留的狀態（例如重新整理過）。不重新計時。
async function dropStaleOptions(ctx) {
  const sessions = await getSessions();
  if (validSession(sessions, ctx.token, ctx.tabId)) return;
  dropTab(sessions, ctx.tabId);
  await putSessions(sessions);
}

// 有效 token → 重新計時（只在用到金鑰的請求成功後呼叫）
async function touchOptions(ctx) {
  const sessions = await getSessions();
  const s = validSession(sessions, ctx.token, ctx.tabId);
  if (!s) return;
  s.lastActivity = Date.now();
  await putSessions(sessions);
}

// 只保留指定 token（修改主密碼後，其他分頁的舊金鑰全部失效）
async function keepOnlySession(token, rawKey) {
  const sessions = await getSessions();
  const s = sessions[token];
  await putSessions(s ? { [token]: { ...s, key: toBase64(rawKey), lastActivity: Date.now() } } : {});
}

// ---- 依來源取得金鑰 ----

function keyFor(ctx) {
  return ctx.kind === 'options' ? getOptionsKey(ctx.token, ctx.tabId) : getReportKey();
}

async function requireKey(ctx) {
  const key = await keyFor(ctx);
  if (!key) throw new AppError('LOCKED', '尚未解鎖');
  return key;
}

// ---- 自動鎖定 ----

chrome.alarms.onAlarm.addListener(alarm => serial(async () => {
  if (alarm.name === REPORT_ALARM) await getReportKey(); // 逾時會在這裡鎖定
  if (alarm.name === OPTIONS_ALARM) await putSessions(await getSessions());
}));

// ---- 解鎖視窗 ----

async function openUnlockWindow(sender) {
  const { unlockWindowId } = await session.get('unlockWindowId');
  if (unlockWindowId !== undefined) {
    try {
      await chrome.windows.update(unlockWindowId, { focused: true });
      return;
    } catch {
      // 視窗已不存在（例如 onRemoved 沒有收到），重新開一個
    }
  }
  const opts = { url: UNLOCK_URL, type: 'popup', focused: true, ...UNLOCK_WINDOW };
  // 盡量放在檢舉頁視窗的正中央
  try {
    const w = await chrome.windows.get(sender.tab.windowId);
    opts.left = Math.round(w.left + (w.width - UNLOCK_WINDOW.width) / 2);
    opts.top = Math.round(w.top + (w.height - UNLOCK_WINDOW.height) / 3);
  } catch {}
  const win = await chrome.windows.create(opts);
  await session.set({ unlockWindowId: win.id });
}

chrome.windows.onRemoved.addListener(windowId => serial(async () => {
  const { unlockWindowId } = await session.get('unlockWindowId');
  if (unlockWindowId === windowId) await session.remove('unlockWindowId');
}));

chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const sessions = await getSessions();
  dropTab(sessions, tabId);
  await putSessions(sessions);
}));

// ---- 參數檢查 ----

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('BAD_REQUEST', `至少 ${MIN_PASSWORD_LENGTH} 個字元`);
  }
}

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new AppError('BAD_REQUEST', '請輸入名稱');
  return name.trim();
}

function cleanOption(o) {
  if (!o || typeof o !== 'object' || typeof o.value !== 'string' || typeof o.text !== 'string') {
    throw new AppError('BAD_REQUEST', '格式錯誤');
  }
  return { value: o.value, text: o.text };
}

function cleanString(v) {
  if (typeof v !== 'string') throw new AppError('BAD_REQUEST', '格式錯誤');
  return v;
}

function cleanCombo(c) {
  if (!c || typeof c !== 'object') throw new AppError('BAD_REQUEST', '格式錯誤');
  return { id: crypto.randomUUID(), name: cleanName(c.name), choseType: cleanOption(c.choseType), law: cleanOption(c.law) };
}

const PLACE_OPTIONS = ['city', 'village', 'road', 'road2'];
const PLACE_TEXTS = ['street', 'alley', 'lane', 'subLane', 'no'];

function cleanPlace(p) {
  if (!p || typeof p !== 'object') throw new AppError('BAD_REQUEST', '格式錯誤');
  const out = { id: crypto.randomUUID(), name: cleanName(p.name) };
  for (const k of PLACE_OPTIONS) out[k] = cleanOption(p[k]);
  for (const k of PLACE_TEXTS) out[k] = cleanString(p[k]);
  return out;
}

// ---- 常用資料的匯出與匯入 ----

const PRESETS_FILE = { app: 'walkers-gavel', type: 'presets', formatVersion: 1 };

// 常用地點、常用違規各自的筆數上限
const PRESET_LIMIT = 20;
const PRESET_LABEL = { combo: '常用違規', place: '常用地點' };

function checkCanAdd(list, kind) {
  if (list.length >= PRESET_LIMIT) {
    throw new AppError('LIMIT', `${PRESET_LABEL[kind]}已達上限 ${PRESET_LIMIT} 筆，請先到設定頁刪除不用的`);
  }
}

function withoutId(item) {
  const { id, ...rest } = item;
  return rest;
}

// 比對「內容是否相同」用的鍵（name、id 以外的欄位）
function comboKey(c) {
  return JSON.stringify([c.choseType.value, c.choseType.text, c.law.value, c.law.text]);
}

function placeKey(p) {
  return JSON.stringify([...PLACE_OPTIONS.flatMap(k => [p[k].value, p[k].text]), ...PLACE_TEXTS.map(k => p[k])]);
}

// 驗證匯入檔（不可信任的資料）。任何一項不符就丟出錯誤；全部通過才回傳整理過的內容（各自有新的 id）
function parsePresetsFile(file) {
  const bad = message => new AppError('BAD_REQUEST', message);
  if (!file || typeof file !== 'object' || Array.isArray(file) ||
      file.app !== PRESETS_FILE.app || file.type !== PRESETS_FILE.type) {
    throw bad('不是本工具匯出的常用資料檔');
  }
  if (file.formatVersion !== PRESETS_FILE.formatVersion) throw bad('不支援這個檔案版本');
  if (!Array.isArray(file.combos) || !Array.isArray(file.places)) throw bad('檔案內容不完整');
  if (file.combos.length > PRESET_LIMIT) throw bad(`檔案中的常用違規超過 ${PRESET_LIMIT} 筆`);
  if (file.places.length > PRESET_LIMIT) throw bad(`檔案中的常用地點超過 ${PRESET_LIMIT} 筆`);
  const each = (list, clean, label) => list.map((item, i) => {
    try {
      return clean(item);
    } catch {
      throw bad(`第 ${i + 1} 筆${label}格式錯誤`);
    }
  });
  return {
    combos: each(file.combos, cleanCombo, '常用違規'),
    places: each(file.places, cleanPlace, '常用地點'),
  };
}

function presetList(data, kind) {
  if (kind === 'combo') return data.combos;
  if (kind === 'place') return data.places;
  throw new AppError('BAD_REQUEST', '格式錯誤');
}

function cleanPersonal(p) {
  if (!p || typeof p !== 'object') throw new AppError('BAD_REQUEST', '格式錯誤');
  const out = {};
  for (const f of store.PERSONAL_FIELDS) {
    const v = p[f] ?? '';
    if (typeof v !== 'string') throw new AppError('BAD_REQUEST', '格式錯誤');
    out[f] = v.trim();
  }
  return out;
}

// ---- 訊息處理 ----

const handlers = {
  async status(msg, ctx) {
    return { setUp: await store.isSetUp(), unlocked: !!(await keyFor(ctx)) };
  },

  async unlock({ password }, ctx) {
    if (typeof password !== 'string' || !password) throw new AppError('BAD_REQUEST', '請輸入主密碼');
    if (!(await store.isSetUp())) throw new AppError('NOT_SET_UP', '尚未設定主密碼');
    const key = await store.unlock(password);
    if (ctx.kind === 'options') return { token: await openOptionsSession(key, ctx.tabId) };
    await setReportKey(key);
    notifyReportTabs();
    return {};
  },

  async lock(msg, ctx) {
    if (ctx.kind === 'options') {
      const sessions = await getSessions();
      if (validSession(sessions, ctx.token, ctx.tabId)) delete sessions[ctx.token];
      await putSessions(sessions);
    } else {
      await lockReport();
    }
    return {};
  },

  async setup({ password }, ctx) {
    checkPassword(password);
    if (await store.isSetUp()) throw new AppError('ALREADY_SET_UP', '已經設定過主密碼');
    return { token: await openOptionsSession(await store.setup(password), ctx.tabId) };
  },

  async getData(msg, ctx) {
    return { data: await store.load(await requireKey(ctx)) };
  },

  async savePersonal({ personal }, ctx) {
    const key = await requireKey(ctx);
    const data = await store.load(key);
    data.personal = cleanPersonal(personal);
    await store.save(key, data);
    return {};
  },

  async changePassword({ oldPassword, newPassword }, ctx) {
    await requireKey(ctx);
    if (typeof oldPassword !== 'string' || !oldPassword) throw new AppError('BAD_REQUEST', '請輸入目前的主密碼');
    checkPassword(newPassword);
    const newKey = await store.changePassword(oldPassword, newPassword);
    await lockReport();
    await keepOnlySession(ctx.token, newKey);
    return {};
  },

  async getD0101Fields(msg, ctx) {
    const { personal } = await store.load(await requireKey(ctx));
    const { name, idNumber, email, phone, address } = personal;
    return { fields: { name, idNumber, email, phone, address } };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return {};
  },

  async openUnlock(msg, ctx, sender) {
    await openUnlockWindow(sender);
    return {};
  },

  async getPresets(msg, ctx) {
    const { combos, places } = await store.load(await requireKey(ctx));
    return { combos, places, limit: PRESET_LIMIT };
  },

  async addCombo({ combo }, ctx) {
    const key = await requireKey(ctx);
    const data = await store.load(key);
    checkCanAdd(data.combos, 'combo');
    const item = cleanCombo(combo);
    data.combos.push(item);
    await store.save(key, data);
    return { id: item.id };
  },

  async addPlace({ place }, ctx) {
    const key = await requireKey(ctx);
    const data = await store.load(key);
    checkCanAdd(data.places, 'place');
    const item = cleanPlace(place);
    data.places.push(item);
    await store.save(key, data);
    return { id: item.id };
  },

  async renamePreset({ kind, id, name }, ctx) {
    const key = await requireKey(ctx);
    const data = await store.load(key);
    const item = presetList(data, kind).find(x => x.id === id);
    if (!item) throw new AppError('BAD_REQUEST', '找不到這一項');
    item.name = cleanName(name);
    await store.save(key, data);
    return {};
  },

  async deletePreset({ kind, id }, ctx) {
    const key = await requireKey(ctx);
    const data = await store.load(key);
    const list = presetList(data, kind);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) throw new AppError('BAD_REQUEST', '找不到這一項');
    list.splice(i, 1);
    await store.save(key, data);
    return {};
  },

  async exportPresets(msg, ctx) {
    const { combos, places } = await store.load(await requireKey(ctx));
    return { combos: combos.map(withoutId), places: places.map(withoutId) };
  },

  async importPresets({ file }, ctx) {
    const key = await requireKey(ctx);
    const incoming = parsePresetsFile(file); // 先全部驗證，失敗就不動現有資料
    const data = await store.load(key);
    const comboKeys = new Set(data.combos.map(comboKey));
    const placeKeys = new Set(data.places.map(placeKey));
    let skipped = 0;
    const newCombos = [], newPlaces = [];
    for (const c of incoming.combos) {
      const k = comboKey(c);
      if (comboKeys.has(k)) { skipped++; continue; }
      comboKeys.add(k);
      newCombos.push(c);
    }
    for (const p of incoming.places) {
      const k = placeKey(p);
      if (placeKeys.has(k)) { skipped++; continue; }
      placeKeys.add(k);
      newPlaces.push(p);
    }
    // 上限：現有＋要新增任一種超過 → 整份不匯入（依 SPEC 字面，要新增 0 筆的那一種也照算）
    const over = (list, adding, kind) => {
      if (list.length + adding.length > PRESET_LIMIT) {
        throw new AppError('LIMIT', `匯入後${PRESET_LABEL[kind]}會超過上限 ${PRESET_LIMIT} 筆` +
          `（現有 ${list.length} 筆，要新增 ${adding.length} 筆），請先刪除不用的`);
      }
    };
    over(data.places, newPlaces, 'place');
    over(data.combos, newCombos, 'combo');
    data.combos.push(...newCombos);
    data.places.push(...newPlaces);
    if (newCombos.length || newPlaces.length) await store.save(key, data);
    return { addedCombos: newCombos.length, addedPlaces: newPlaces.length, skipped };
  },

  async clearAll() {
    await lockReport();
    await putSessions({});
    await store.clearAll();
    return {};
  },
};

const ALLOWED = {
  options: new Set(['status', 'unlock', 'lock', 'setup', 'getData', 'savePersonal', 'changePassword', 'clearAll',
    'renamePreset', 'deletePreset', 'exportPresets', 'importPresets']),
  report: new Set(['status', 'lock', 'getD0101Fields', 'openOptions', 'openUnlock', 'getPresets', 'addCombo', 'addPlace']),
  unlockWindow: new Set(['unlock']),
};

// 檢舉頁的訊息再依頁面限制：個人資料只給 D0101，常用組合／地點只給 D0102。
// （content script 本來就只在對應的頁面送這些訊息；這裡由 service worker 強制執行。）
// 完整比對路徑（URL 的 pathname 不含查詢參數與 #）
const REPORT_PAGE_ONLY = {
  getD0101Fields: '/TTPB/D0101',
  getPresets: '/TTPB/D0102',
  addCombo: '/TTPB/D0102',
  addPlace: '/TTPB/D0102',
};

// 成功後重新計時的訊息（見開頭「閒置計時」）
const RENEWS_TIMER = new Set(['unlock', 'setup', 'getData', 'savePersonal', 'changePassword', 'getD0101Fields',
  'getPresets', 'addCombo', 'addPlace', 'renamePreset', 'deletePreset', 'exportPresets', 'importPresets']);

function reportPageAllowed(type, sender) {
  if (!Object.hasOwn(REPORT_PAGE_ONLY, type)) return true;
  let pathname;
  try { pathname = new URL(sender.url).pathname; } catch { return false; }
  return pathname === REPORT_PAGE_ONLY[type];
}

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return null;
  const page = sender.url.split(/[?#]/)[0];
  if (page === OPTIONS_URL) return 'options';
  if (page === UNLOCK_URL) return 'unlockWindow';
  if (sender.tab && REPORT_PAGE.test(sender.url)) return 'report';
  return null;
}

async function handle(msg, sender) {
  const kind = senderKind(sender);
  if (!kind) throw new AppError('FORBIDDEN', '不允許的來源');
  if (!msg || typeof msg.type !== 'string' || !Object.hasOwn(handlers, msg.type)) {
    throw new AppError('UNKNOWN_TYPE', '未知的訊息類型');
  }
  if (!ALLOWED[kind].has(msg.type)) throw new AppError('FORBIDDEN', '此頁面不能使用這項功能');
  if (kind === 'report' && !reportPageAllowed(msg.type, sender)) {
    throw new AppError('FORBIDDEN', '此頁面不能使用這項功能');
  }
  const ctx = {
    kind,
    token: kind === 'options' && typeof msg.token === 'string' ? msg.token : null,
    tabId: sender.tab ? sender.tab.id : -1,
  };
  if (kind === 'options') await dropStaleOptions(ctx);
  const result = await handlers[msg.type](msg, ctx, sender);
  if (RENEWS_TIMER.has(msg.type) && msg.passive !== true) {
    if (kind === 'options') await touchOptions(ctx);
    else if (kind === 'report') await touchReport();
  }
  return { ok: true, ...result };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => handle(msg, sender)).then(sendResponse, err => {
    if (err instanceof store.WrongPasswordError) {
      sendResponse({ ok: false, error: 'WRONG_PASSWORD', message: '密碼錯誤' });
    } else if (err instanceof store.BadVaultError) {
      sendResponse({ ok: false, error: 'BAD_VAULT', message: err.message });
    } else if (err instanceof AppError) {
      sendResponse({ ok: false, error: err.code, message: err.message });
    } else {
      console.error(err);
      sendResponse({ ok: false, error: 'INTERNAL', message: '內部錯誤' });
    }
  });
  return true; // 非同步回應
});
