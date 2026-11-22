// options/options.js — 選項頁。不直接碰加密或儲存，全部透過 background.js 的訊息處理。
//
// 解鎖後 background 回傳的 token 只存在這個變數裡：分頁關閉或重新整理就消失，必須重新解鎖。

const FIELDS = ['name', 'idNumber', 'email', 'phone', 'address'];
const $ = id => document.getElementById(id);
let token = null;

// 一般的 Enter（中文輸入法組字中按的 Enter 只是選字，不算）
function isSubmitEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

function send(type, params = {}) {
  return chrome.runtime.sendMessage({ type, token, ...params });
}

function showPageError(text) {
  $('msg').textContent = text;
  $('msg').hidden = false;
}

// 按鈕旁邊的訊息。level：'ok'（✓）、'warn'（!）、'err'（✕），也可傳 true／false 代表 ok／err。
// 成功訊息預設 3 秒後消失；keep 為 true 時保留（例如匯入結果）
const noteTimers = new WeakMap();
function showNote(button, text, level, keep = false) {
  if (level === true) level = 'ok';
  if (level === false) level = 'err';
  const note = button.nextElementSibling;
  clearTimeout(noteTimers.get(note));
  note.textContent = text;
  note.className = 'note ' + level;
  if (level === 'ok' && !keep) noteTimers.set(note, setTimeout(() => { note.textContent = ''; }, 3000));
}

function clearNotes() {
  for (const note of document.querySelectorAll('.note')) note.textContent = '';
}

// 清空所有輸入欄位
function clearInputs() {
  for (const input of document.querySelectorAll('input')) input.value = '';
}

// 鎖定時不留下任何解密後的資料在頁面上：輸入欄位清空，常用組合／地點清單從 DOM 移除（不只是隱藏）
function clearDecrypted() {
  clearInputs();
  $('combo-list').replaceChildren();
  $('place-list').replaceChildren();
}

async function render() {
  const s = await send('status');
  if (!s.ok) { showPageError(s.message); return; }
  $('msg').hidden = true;
  if (!s.unlocked) token = null;
  const wasUnlocked = !$('view-unlocked').hidden;
  $('view-setup').hidden = s.setUp;
  $('view-locked').hidden = !s.setUp || s.unlocked;
  $('view-unlocked').hidden = !s.unlocked;
  $('view-clear').hidden = !s.setUp;

  if (!s.unlocked) {
    clearDecrypted();
    if (wasUnlocked) clearNotes();
    return;
  }
  const r = await send('getData');
  if (!r.ok) { showPageError(r.message); return; }
  for (const f of FIELDS) $('p-' + f).value = r.data.personal[f];
  renderPresets($('combo-list'), 'combo', r.data.combos, comboDetail);
  renderPresets($('place-list'), 'place', r.data.places, placeDetail);
}

// ---- 常用組合與常用地點（改名、刪除；新增只能從檢舉頁面）----

const typeLabel = { '1': '動態違規', '2': '靜態違規' };

function comboDetail(c) {
  return `${c.choseType.text || typeLabel[c.choseType.value] || ''}｜${c.law.text}`;
}

function placeDetail(p) {
  const parts = [p.city.text, p.village.text, p.road.text];
  if (p.street) parts.push(`${p.street}街`);
  if (p.alley) parts.push(`${p.alley}巷`);
  if (p.lane) parts.push(`${p.lane}弄`);
  if (p.subLane) parts.push(`${p.subLane}衖`);
  if (p.no) parts.push(`${p.no}號`);
  let s = parts.filter(Boolean).join('');
  if (p.road2.text) s += `（交叉路口：${p.road2.text}）`;
  return s;
}

function el(tag, props = {}, text = '') {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (text) e.textContent = text;
  return e;
}

function renderPresets(container, kind, list, detail) {
  container.replaceChildren();
  if (list.length === 0) {
    container.append(el('p', { className: 'empty' }, '（尚無）'));
    return;
  }
  for (const item of list) {
    const name = el('input', { type: 'text', value: item.name, autocomplete: 'off', spellcheck: false });
    name.setAttribute('aria-label', '名稱');
    const rename = el('button', { type: 'button' }, '改名');
    const del = el('button', { type: 'button', className: 'danger-btn' }, '刪除');
    const note = el('span', { className: 'note' });
    note.setAttribute('role', 'status');
    const row = el('div', { className: 'row' });
    row.append(rename, del, note);
    const box = el('div', { className: 'preset' });
    box.append(name, el('p', { className: 'detail' }, detail(item)), row);
    container.append(box);

    const run = async (fn, okText, rerender) => {
      rename.disabled = del.disabled = true;
      note.textContent = '';
      try {
        const r = await fn();
        if (!r) return;
        if (!r.ok) {
          note.className = 'note err';
          note.textContent = r.message;
          if (r.error === 'LOCKED') await render();
          return;
        }
        if (okText) { note.className = 'note ok'; note.textContent = okText; }
        if (rerender) await render();
      } finally {
        rename.disabled = del.disabled = false;
      }
    };
    rename.addEventListener('click', () => run(async () => {
      const r = await send('renamePreset', { kind, id: item.id, name: name.value });
      if (r.ok) { item.name = name.value.trim(); name.value = item.name; }
      return r;
    }, '已改名', false));
    name.addEventListener('keydown', e => { if (isSubmitEnter(e)) rename.click(); });
    del.addEventListener('click', () => {
      if (!confirm(`確定要刪除「${item.name}」嗎？`)) return;
      run(() => send('deletePreset', { kind, id: item.id }), '', true);
    });
  }
}

// 執行一個動作：按鈕停用、送訊息、在按鈕旁顯示結果
//   okText：成功時顯示的文字（畫面會切換的動作不需要）；fn 回傳的 message 優先
//   rerender：成功後是否重新整理畫面
//   keep：成功訊息不自動消失
//   fn 回傳的 level（'ok'／'warn'／'err'）決定符號與顏色
async function act(button, fn, { okText = '', rerender = true, keep = false } = {}) {
  button.disabled = true;
  showNote(button, '', true);
  try {
    const r = await fn();
    if (r && r.ok === false) {
      showNote(button, r.message, r.level || 'err');
      if (r.error === 'LOCKED') await render(); // 已被自動鎖定
      return;
    }
    const text = (r && r.message) || okText;
    if (text) showNote(button, text, (r && r.level) || 'ok', keep);
    if (rerender) await render();
  } finally {
    button.disabled = false;
  }
}

$('setup-btn').addEventListener('click', e => act(e.target, async () => {
  const password = $('setup-pw1').value;
  if (password !== $('setup-pw2').value) return { ok: false, message: '兩次輸入不一致' };
  const r = await send('setup', { password });
  if (r.ok) { token = r.token; clearInputs(); }
  return r;
}));

$('unlock-btn').addEventListener('click', e => act(e.target, async () => {
  const r = await send('unlock', { password: $('unlock-pw').value });
  $('unlock-pw').value = '';
  if (r.ok) token = r.token;
  return r;
}));

$('unlock-pw').addEventListener('keydown', e => {
  if (isSubmitEnter(e)) $('unlock-btn').click();
});

// 設定主密碼：兩個密碼欄按 Enter 都等同按「設定」
for (const id of ['setup-pw1', 'setup-pw2']) {
  $(id).addEventListener('keydown', e => {
    if (isSubmitEnter(e)) $('setup-btn').click();
  });
}

$('lock-btn').addEventListener('click', e => act(e.target, async () => {
  const r = await send('lock');
  token = null;
  return r;
}));

$('save-personal-btn').addEventListener('click', e => act(e.target, () => {
  const personal = Object.fromEntries(FIELDS.map(f => [f, $('p-' + f).value]));
  return send('savePersonal', { personal });
}, { okText: '已儲存' }));

$('cp-btn').addEventListener('click', e => act(e.target, async () => {
  const newPassword = $('cp-new1').value;
  if (newPassword !== $('cp-new2').value) return { ok: false, message: '兩次輸入不一致' };
  const r = await send('changePassword', { oldPassword: $('cp-old').value, newPassword });
  if (r.ok) for (const id of ['cp-old', 'cp-new1', 'cp-new2']) $(id).value = '';
  return r;
}, { okText: '已修改', rerender: false }));

// ---- 匯出與匯入常用資料（加解密仍在 background；匯出檔沒有加密）----

const PRESETS_FILE = { app: 'walkers-gavel', type: 'presets', formatVersion: 1 };
const MAX_IMPORT_BYTES = 5 * 1000 * 1000; // 合理的上限，避免誤選大檔案

// 台灣時間的各部分
function taipeiParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return p;
}

function downloadText(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('export-btn').addEventListener('click', e => act(e.target, async () => {
  const r = await send('exportPresets');
  if (!r.ok) return r;
  if (r.combos.length === 0 && r.places.length === 0) {
    return { ok: false, level: 'warn', message: '沒有可匯出的常用資料' };
  }
  const t = taipeiParts(new Date());
  const file = {
    ...PRESETS_FILE,
    exportedAt: `${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}:${t.second}+08:00`,
    combos: r.combos,
    places: r.places,
  };
  downloadText(JSON.stringify(file, null, 2) + '\n', `walkers-gavel-presets-${t.year}${t.month}${t.day}.json`);
  return { ok: true, message: `已匯出 ${r.combos.length} 筆違規、${r.places.length} 筆地點` };
}, { rerender: false, keep: true }));

$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', e => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // 同一個檔案可以再選一次
  if (!file) return;
  act($('import-btn'), async () => {
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, message: '檔案太大，不是常用資料的匯出檔' };
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return { ok: false, message: '不是有效的 JSON 檔' };
    }
    const r = await send('importPresets', { file: data });
    if (!r.ok) return r;
    const added = r.addedCombos + r.addedPlaces;
    let message = `已匯入 ${r.addedCombos} 筆違規、${r.addedPlaces} 筆地點`;
    if (r.skipped) message += `，略過 ${r.skipped} 筆重複`;
    return { ok: true, level: added ? 'ok' : 'warn', message };
  }, { keep: true });
});

$('clear-btn').addEventListener('click', e => {
  const sure = confirm('確定要清除所有資料嗎？\n\n個人資料、常用違規、常用地點與主密碼設定都會被刪除，無法復原。');
  if (!sure) return;
  act(e.target, async () => {
    const r = await send('clearAll');
    token = null;
    return r;
  });
});

// 這個分頁的解鎖狀態被移除（自動鎖定、在別的分頁修改主密碼或清除資料）時，立即清掉畫面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'optionsSessions' in changes && token) {
    const now = changes.optionsSessions.newValue || {};
    if (!Object.hasOwn(now, token)) render();
  }
  if (area === 'local' && 'vault' in changes && !changes.vault.newValue) render();
});

// 離開這一頁（關閉、重新整理、在同一個分頁跳到別的網址）時，立刻請 background 刪掉這個分頁的金鑰，
// 不等 10 分鐘逾時。
window.addEventListener('pagehide', () => {
  if (!token) return;
  send('lock').catch(() => {});
  token = null;
});

// 從上一頁／下一頁的快取回到這一頁時，重新查詢狀態（此時已鎖定，畫面上的資料會被清掉）
window.addEventListener('pageshow', e => {
  if (e.persisted) render();
});

render();
