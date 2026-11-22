// content/d0102-presets.js — D0102 的常用組合（違規事項）與常用地點（需要解鎖）
//
// 由 content/d0102.js 在面板解鎖時呼叫 WGD0102Presets.build(api)。
// - 清單透過 background 的 getPresets 取得，新增用 addCombo / addPlace；改名、刪除只能在選項頁
// - 每種最多 20 筆（上限值由 getPresets 回傳）；達到上限時不跳出命名視窗
// - 名稱用瀏覽器原生的 prompt() 輸入（不放在面板的輸入框裡，網站收不到輸入的按鍵）
// - 常用地點的「路」「交叉路口」是 selectize 元件，API 只能在網站的 MAIN world 呼叫，
//   透過 content/main-world.js 代為設定；兩邊只用 CustomEvent 傳遞地點的選項值與顯示文字，不傳任何個人資料
// - 按「套用」時先向 background 重新取得清單（同時確認仍是解鎖狀態）；已鎖定 → 不套用，面板切回鎖定畫面
// - 面板離開解鎖畫面（鎖定通知等）時，清掉暫存的清單，並取消進行中的套用（之後的步驟不再寫入）

(() => {
  'use strict';
  if (globalThis.WGD0102Presets) return;

  const WAIT_MS = 5000;   // 每一步等待的上限
  const POLL_MS = 100;
  const VERIFY_DELAY_MS = 1500; // 套用地點後，等網站的非同步載入跑完再檢查一次

  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function setValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectedOption(select) {
    const o = select.options[select.selectedIndex];
    return { value: select.value, text: o ? norm(o.text) : '' };
  }

  // 先用 value 比對，比對不到再用顯示文字比對
  function findOption(select, saved) {
    const opts = [...select.options];
    return opts.find(o => o.value === saved.value) ||
      (norm(saved.text) ? opts.find(o => norm(o.text) === norm(saved.text)) : undefined) || null;
  }

  // 套用被取消（面板已鎖定）時丟出，由「套用」按鈕接住後不顯示任何訊息
  class Cancelled extends Error {}

  async function waitFor(fn, cancelled) {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      if (cancelled()) throw new Cancelled();
      const v = fn();
      if (v) return v;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  // ---- 常用組合（違規事項）----

  function comboFields() {
    const choseType = $('chose_type'), chosen1 = $('chosen1'), chosen2 = $('chosen2');
    if (![choseType, chosen1, chosen2].every(el => el instanceof HTMLSelectElement)) return null;
    return { choseType, chosen1, chosen2 };
  }

  function lawSelect(f, typeValue) {
    if (typeValue === '1') return f.chosen1;
    if (typeValue === '2') return f.chosen2;
    return null;
  }

  // 表單的違規事項有沒有選任何東西（找不到欄位時視為有，讓按下去時顯示「頁面結構可能改版」）
  function comboHasContent() {
    const f = comboFields();
    if (!f) return true;
    return f.choseType.value !== '';
  }

  // 違規事項的目前狀態（內容改變時，面板清掉常用違規區的訊息）
  function comboSnapshot() {
    const f = comboFields();
    if (!f) return '';
    return JSON.stringify([f.choseType.value, f.chosen1.value, f.chosen2.value]);
  }

  function readCombo() {
    const f = comboFields();
    if (!f) return { error: '頁面結構可能改版' };
    const choseType = selectedOption(f.choseType);
    const law = lawSelect(f, choseType.value);
    if (!law || !law.value) return { error: '請先選好違規類型與違規法條' };
    return { combo: { choseType, law: selectedOption(law) } };
  }

  async function applyCombo(combo, cancelled) {
    const f = comboFields();
    if (!f) return { ok: false, message: '頁面結構可能改版' };
    const typeOpt = findOption(f.choseType, combo.choseType);
    if (!typeOpt || typeOpt.disabled) return { ok: false, message: `此選項已不存在：${combo.choseType.text}` };
    setValue(f.choseType, typeOpt.value);
    // 網站用 jQuery 監聽 change，啟用對應的違規法條選單；等它變成啟用
    const law = await waitFor(() => {
      const s = lawSelect(f, typeOpt.value);
      return s && !s.disabled ? s : null;
    }, cancelled);
    if (!law) return { ok: false, message: '違規法條選單沒有啟用（頁面結構可能改版）' };
    const lawOpt = findOption(law, combo.law);
    if (!lawOpt || !lawOpt.value) return { ok: false, message: `此選項已不存在：${combo.law.text}` };
    setValue(law, lawOpt.value);
    return { ok: true, message: '已套用' };
  }

  // ---- 常用地點 ----

  const TEXT_FIELDS = [
    ['addStreet', 'street', '街'], ['addAlley', 'alley', '巷'], ['addLane', 'lane', '弄'],
    ['addSubLane', 'subLane', '衖'], ['addNo', 'no', '號'],
  ];

  function placeFields() {
    const f = {
      city: $('city'), village: $('village'), road: $('selectize_Road'), road2: $('selectize_Road2'),
    };
    if (!Object.values(f).every(el => el instanceof HTMLSelectElement)) return null;
    for (const [id] of TEXT_FIELDS) {
      const el = $(id);
      if (!(el instanceof HTMLInputElement)) return null;
      f[id] = el;
    }
    return f;
  }

  // 表單的地址有沒有填任何東西（找不到欄位時視為有，讓按下去時顯示「頁面結構可能改版」）
  function placeHasContent() {
    const f = placeFields();
    if (!f) return true;
    if (['city', 'village', 'road', 'road2'].some(k => f[k].value !== '')) return true;
    return TEXT_FIELDS.some(([id]) => f[id].value.trim() !== '');
  }

  // 表單地址的目前狀態（內容改變時，面板清掉常用地點區的訊息）
  function placeSnapshot() {
    const f = placeFields();
    if (!f) return '';
    return JSON.stringify([f.city.value, f.village.value, f.road.value, f.road2.value,
      ...TEXT_FIELDS.map(([id]) => f[id].value)]);
  }

  function readPlace() {
    const f = placeFields();
    if (!f) return { error: '頁面結構可能改版' };
    const city = selectedOption(f.city);
    if (city.value !== '1') return { error: '縣市請選「桃園市」（其他縣市不支援）' };
    const village = selectedOption(f.village);
    if (!village.value) return { error: '請先選好區' };
    const place = { city, village, road: selectedOption(f.road), road2: selectedOption(f.road2) };
    for (const [id, key] of TEXT_FIELDS) place[key] = f[id].value.trim();
    return { place };
  }

  // 請 MAIN world 的 content/main-world.js 設定 selectize
  function selectizeSet(id, saved) {
    return new Promise(resolve => {
      const reqId = crypto.randomUUID();
      const onResponse = e => {
        let r;
        try { r = JSON.parse(e.detail); } catch { return; }
        if (r && r.reqId === reqId) done(r);
      };
      const timer = setTimeout(() => done({ ok: false, reason: 'no-response' }), WAIT_MS + 1500);
      function done(r) {
        clearTimeout(timer);
        document.removeEventListener('wg-selectize-response', onResponse);
        resolve(r);
      }
      document.addEventListener('wg-selectize-response', onResponse);
      document.dispatchEvent(new CustomEvent('wg-selectize-request', {
        detail: JSON.stringify({ reqId, id, value: saved.value, text: saved.text, timeoutMs: WAIT_MS }),
      }));
    });
  }

  const SELECTIZE_REASONS = {
    'no-selectize': '找不到網站的 selectize 元件',
    'not-found': '5 秒內沒有載入「{text}」選項',
    'no-response': '沒有回應（MAIN world 腳本可能沒有載入）',
    'bad-request': '請求格式錯誤',
  };

  // 回傳 { value }（實際設定的值）或 { error }
  async function applySelectize(f, key, id, saved, stepLabel, cancelled) {
    // 已經是目標值就不動，避免觸發網站重新載入下一層選項
    if (f[key].value === saved.value) return { value: saved.value };
    const r = await selectizeSet(id, saved);
    if (cancelled()) throw new Cancelled();
    if (r.ok) return { value: r.value };
    const why = (SELECTIZE_REASONS[r.reason] || r.reason).replace('{text}', saved.text);
    return { error: `停在${stepLabel}：${why}` };
  }

  async function applyPlace(place, cancelled) {
    const f = placeFields();
    if (!f) return { ok: false, message: '頁面結構可能改版' };

    // 1. 縣市（已經是目標值就不觸發 change，避免網站重新載入「區」）
    const cityOpt = findOption(f.city, place.city);
    if (!cityOpt) return { ok: false, message: `停在第 1 步（縣市）：找不到「${place.city.text}」選項` };
    if (f.city.value !== cityOpt.value) setValue(f.city, cityOpt.value);

    // 2. 區：等目標選項出現
    const villageOpt = await waitFor(() => findOption(f.village, place.village), cancelled);
    if (!villageOpt) return { ok: false, message: `停在第 2 步（區）：5 秒內沒有出現「${place.village.text}」選項` };
    if (f.village.value !== villageOpt.value) setValue(f.village, villageOpt.value);

    // 3. 路（selectize）
    const r3 = await applySelectize(f, 'road', 'selectize_Road', place.road, '第 3 步（路）', cancelled);
    if (r3.error) return { ok: false, message: r3.error };

    // 4. 街巷弄衖號（儲存時是空的也照樣寫入空白）
    for (const [id, key] of TEXT_FIELDS) setValue(f[id], place[key]);

    // 5. 交叉路口（selectize）
    const r5 = await applySelectize(f, 'road2', 'selectize_Road2', place.road2, '第 5 步（交叉路口）', cancelled);
    if (r5.error) {
      // 常見原因：第 3 步設好的路，被網站稍晚完成的載入重設了
      if (f.road.value !== r3.value) return { ok: false, message: '套用中「路」被網站重設。請再按一次「套用」' };
      return { ok: false, message: r5.error };
    }

    // 6. 等網站的非同步載入跑完，再確認沒有被重設
    await sleep(VERIFY_DELAY_MS);
    if (cancelled()) throw new Cancelled();
    const g = placeFields();
    if (!g) return { ok: false, message: '頁面結構可能改版' };
    const wrong = [];
    if (g.city.value !== cityOpt.value) wrong.push('縣市');
    if (g.village.value !== villageOpt.value) wrong.push('區');
    if (g.road.value !== r3.value) wrong.push('路');
    if (g.road2.value !== r5.value) wrong.push('交叉路口');
    for (const [id, key, label] of TEXT_FIELDS) if (g[id].value !== place[key]) wrong.push(label);
    if (wrong.length) {
      return { ok: true, level: 'warn', message: `套用後被網站重設：${wrong.join('、')}。請再按一次「套用」` };
    }
    return { ok: true, message: '已套用' };
  }

  function defaultPlaceName(place) {
    const no = place.no ? `${place.no}號` : '';
    const road2 = place.road2.text ? `（${place.road2.text}口）` : '';
    return `${place.village.text}${place.road.text}${no}${road2}`;
  }

  // ---- 面板 ----

  function build(api) {
    let combos = [];
    let places = [];
    // 面板離開解鎖畫面後變成 false（每次解鎖都會重新 build，所以不會再變回 true）
    let active = true;

    const comboSel = api.el('select', { className: 'select' });
    const placeSel = api.el('select', { className: 'select' });
    comboSel.setAttribute('aria-label', '常用違規');
    placeSel.setAttribute('aria-label', '常用地點');

    function fill(select, list, selectId) {
      select.replaceChildren();
      if (list.length === 0) {
        select.append(api.el('option', { value: '', disabled: true, selected: true }, '（尚無，先在表單選好再按「目前內容存為常用」）'));
        return;
      }
      for (const item of list) select.append(api.el('option', { value: item.id }, item.name));
      if (selectId) select.value = selectId;
    }

    // passive：面板載入時的自動取得，不重新計時（一直重新整理 D0102 也不會延長解鎖時間）
    async function reload(select, passive = false) {
      const r = await api.send('getPresets', passive ? { passive: true } : {});
      if (!active) return null; // 回應到達前面板已被鎖定：不再暫存
      if (!r || !r.ok) return r;
      combos = r.combos;
      places = r.places;
      fill(comboSel, combos, select && select.kind === 'combo' ? select.id : comboSel.value);
      fill(placeSel, places, select && select.kind === 'place' ? select.id : placeSel.value);
      return r;
    }

    // 跳出命名視窗前先確認沒有達到上限（重新取得清單，設定頁可能剛刪除或匯入過）。
    // 上限值由 background 回傳，background 新增時也會再檢查一次。
    // 回傳 undefined 表示可以繼續；其他值（含 null）直接當作這個按鈕的結果回傳。
    async function checkFull(label, listName) {
      const r = await reload();
      if (!r) return null;
      if (!r.ok) return r;
      if (r[listName].length >= r.limit) {
        return { ok: false, message: `${label}已達上限 ${r.limit} 筆，請先到設定頁刪除不用的` };
      }
      return undefined;
    }

    // 套用：先向 background 重新取得清單（已鎖定時 api.send 會切回鎖定畫面並回傳 null），
    // 再用最新的那一筆套用。面板離開解鎖畫面時 active 變成 false，進行中的套用就停止
    async function runApply(kind, id, emptyMessage, apply) {
      if (!id) return { ok: false, message: emptyMessage };
      const cancelled = () => !active;
      const r = await reload({ kind, id });
      if (!r || cancelled()) return null;
      if (!r.ok) return r;
      const item = (kind === 'combo' ? combos : places).find(x => x.id === id);
      if (!item) return { ok: false, message: '這一筆已被刪除，請重新選擇' };
      try {
        return await apply(item, cancelled);
      } catch (e) {
        if (e instanceof Cancelled) return null;
        throw e;
      }
    }

    function askName(label, suggestion) {
      const name = prompt(`${label}名稱`, suggestion);
      if (name === null) return null; // 取消
      return name.trim();
    }

    const placeSec = api.addSection('常用地點');
    placeSec.append(placeSel);
    const placeSave = placeSec.addAction('目前內容存為常用', async () => {
      const { place, error } = readPlace();
      if (error) return { ok: false, message: error };
      const full = await checkFull('常用地點', 'places');
      if (full !== undefined) return full;
      const name = askName('常用地點', defaultPlaceName(place));
      if (name === null) return null;
      if (!name) return { ok: false, message: '請輸入名稱' };
      const r = await api.send('addPlace', { place: { ...place, name } });
      if (!r) return null;
      if (!r.ok) return r;
      await reload({ kind: 'place', id: r.id });
      return { ok: true, message: '已儲存' };
    });
    placeSec.addAction('套用', () => runApply('place', placeSel.value, '請先選擇一個常用地點', applyPlace));

    const comboSec = api.addSection('常用違規');
    comboSec.append(comboSel);
    const comboSave = comboSec.addAction('目前內容存為常用', async () => {
      const { combo, error } = readCombo();
      if (error) return { ok: false, message: error };
      const full = await checkFull('常用違規', 'combos');
      if (full !== undefined) return full;
      const name = askName('常用違規', combo.law.text.slice(0, 20));
      if (name === null) return null;
      if (!name) return { ok: false, message: '請輸入名稱' };
      const r = await api.send('addCombo', { combo: { ...combo, name } });
      if (!r) return null;
      if (!r.ok) return r;
      await reload({ kind: 'combo', id: r.id });
      return { ok: true, message: '已儲存' };
    });
    comboSec.addAction('套用', () => runApply('combo', comboSel.value, '請先選擇一個常用違規', applyCombo));

    // 「目前內容存為常用」靠左；表單該項沒有任何內容時不顯示
    const placeSaveBtn = placeSave.querySelector('button');
    const comboSaveBtn = comboSave.querySelector('button');
    placeSaveBtn.classList.add('push-left');
    comboSaveBtn.classList.add('push-left');

    function updateSaveButtons() {
      placeSaveBtn.hidden = !placeHasContent();
      comboSaveBtn.hidden = !comboHasContent();
    }
    // 偵測方式由面板提供（input、change 事件，加上每秒檢查一次）；離開解鎖畫面時面板會停止監聽
    api.onFormChange(updateSaveButtons);
    // 地址／違規事項改變時，清掉該區按鈕旁的訊息
    placeSec.watch(placeSnapshot);
    comboSec.watch(comboSnapshot);

    // 離開解鎖畫面（鎖定通知、自動鎖定等）：清掉暫存的清單、取消進行中的套用
    api.onLeave(() => {
      active = false;
      combos = [];
      places = [];
    });
    updateSaveButtons();

    fill(comboSel, [], null);
    fill(placeSel, [], null);
    reload(null, true);
  }

  globalThis.WGD0102Presets = { build };
})();
