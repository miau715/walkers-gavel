// content/d0102.js — 檢舉內容頁（D0102）：從附件 1 的影片填入車牌、車種、違規日期、違規時間
//
// - 不另外做選檔介面：監聽網站本身的附件 1（#files1）的 change 事件（選檔或從 Finder 拖到按鈕上）
// - 只讀取使用者放進去的 File，不修改、移除、替換 #files1 的內容，也不阻止網站自己的處理
//   （在 document 的 capture 階段監聽，不呼叫 stopPropagation / preventDefault）
// - 不需要解密資料，所以鎖定狀態下也照常運作；結果顯示在面板的資訊區
// - 常用組合與常用地點（需要解鎖）在 content/d0102-presets.js
//
// 填寫規則（SPEC「D0102：選擇影片」）：
// - 六個欄位（#files1、#cardate、#carTime、#CarNum、#CarNum2、#car_type）任何一個找不到 → 「頁面結構可能改版」，什麼都不填
// - 影片能提供的值 → 覆寫欄位原有內容
// - 影片提供不了的值（檔名解析不出車牌、讀不到時間、逾期、日期晚於今天、不是影片檔）→ 不填，並清空該欄位
//   （不論內容是不是本工具填的），面板列出被清空的欄位
// - 車種：由車牌判斷（lib/plate-ranges.js），判斷不出一律預選汽車；只有「不是影片檔」時重設為「請選擇」
// - 附件 1 被清空（change 事件，或點了網站的 X 按鈕 #clearfilename 之後確認確實沒有檔案）→
//   清空車牌、日期、時間，車種重設為「請選擇」，並重設面板資訊區
// - 寫入 #cardate、#carTime 時不觸發 focus（會彈出 WdatePicker），直接設值後觸發 input、change

(() => {
  'use strict';
  if (location.pathname !== '/TTPB/D0102') return; // 完整比對路徑（查詢參數與 # 不影響）

  const MAX_BYTES = 50 * 1000 * 1000;        // 網站單檔上限 50MB（取較嚴格的十進位算法，只用於警告）
  const DEADLINE_DAYS = 7;                    // 違規日期距今天超過 7 天即逾期
  const VIDEO_EXT = ['mov', 'mp4', 'mpeg', 'mkv', 'avi']; // 網站接受的影片格式
  const PARSEABLE_EXT = ['mov', 'mp4'];       // lib/mp4-time.js 能讀拍攝時間的格式
  const PLATE_PART = /^[A-Za-z0-9]{2,4}$/;

  const LABELS = { CarNum: '車牌前段', CarNum2: '車牌後段', cardate: '違規日期', carTime: '違規時間', car_type: '車種' };
  const HINT = { text: '在附件 1 選擇影片後，會自動填入車牌、車種、日期與時間', muted: true };

  const panel = WGPanel.mount({
    lockedHint: '影片相關功能鎖定時照常運作；常用地點、常用違規需要解鎖後才能使用。',
    onUnlocked(api) { WGD0102Presets.build(api); },
  });

  function getFields() {
    const f = {};
    for (const id of ['files1', 'cardate', 'carTime', 'CarNum', 'CarNum2']) {
      const el = document.getElementById(id);
      if (!(el instanceof HTMLInputElement)) return null;
      f[id] = el;
    }
    if (f.files1.type !== 'file') return null;
    const carType = document.getElementById('car_type');
    if (!(carType instanceof HTMLSelectElement)) return null;
    f.car_type = carType;
    return f;
  }

  // 設值並觸發 input、change（不呼叫 focus）
  function setValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 清空欄位；有內容被清掉時記到 cleared
  function clearField(fields, id, cleared) {
    if (fields[id].value === '') return;
    setValue(fields[id], '');
    cleared.push(LABELS[id]);
  }

  function setCarType(fields, value) {
    const exists = [...fields.car_type.options].some(o => o.value === value);
    if (!exists) return false;
    setValue(fields.car_type, value);
    return true;
  }

  function parsePlate(fileName) {
    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const parts = base.split('-');
    if (parts.length !== 2 || !parts.every(p => PLATE_PART.test(p))) return null;
    return parts.map(p => p.toUpperCase());
  }

  function extOf(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  }

  // 'yyyy/MM/dd' → 自 1970-01-01 起的日數（只用來算日期差）
  function dayNumber(ymd) {
    const [y, m, d] = ymd.split('/').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  }

  function formatMB(bytes) {
    return (bytes / 1000 / 1000).toFixed(1) + 'MB';
  }

  function structureError() {
    panel.setInfo([{ text: '頁面結構可能改版', level: 'err' }]);
  }

  let seq = 0; // 換檔很快時，只採用最後一個檔案的結果

  // 附件 1 已清空：清空車牌、日期、時間，車種重設為「請選擇」，重設資訊區
  function handleCleared(fields) {
    seq++; // 還在讀取中的影片結果作廢
    const cleared = [];
    for (const id of ['CarNum', 'CarNum2', 'cardate', 'carTime', 'car_type']) clearField(fields, id, cleared);
    const lines = [HINT];
    if (cleared.length) lines.push({ text: `附件 1 已清空，已清空：${cleared.join('、')}`, level: 'warn' });
    panel.setInfo(lines);
  }

  async function handleFile() {
    const mySeq = ++seq;
    const fields = getFields();
    if (!fields) { structureError(); return; }
    const file = fields.files1.files && fields.files1.files[0];
    if (!file) { handleCleared(fields); return; }

    const lines = [{ text: `附件 1：${file.name}` }];
    const cleared = [];
    const ext = extOf(file.name);

    // 不是影片 → 什麼都不填，清空影片相關欄位
    if (!VIDEO_EXT.includes(ext)) {
      for (const id of ['CarNum', 'CarNum2', 'cardate', 'carTime', 'car_type']) clearField(fields, id, cleared);
      lines.push({ text: '不是影片檔，沒有填入任何欄位', level: 'err' });
      if (cleared.length) lines.push({ text: `已清空：${cleared.join('、')}`, level: 'warn' });
      panel.setInfo(lines);
      return;
    }

    // 讀取拍攝時間（先讀完再一起寫入，避免中途換檔時寫到一半）
    let time;
    if (PARSEABLE_EXT.includes(ext)) {
      panel.setInfo([...lines, { text: '讀取中…', muted: true }]);
      time = await Mp4Time.readVideoStartTime(file);
      if (mySeq !== seq) return; // 已經換成別的檔案
    } else {
      time = { ok: false, reason: '只支援 MOV、MP4' };
    }

    // 讀取期間網站可能改了頁面，寫入前再確認一次
    const f = getFields();
    if (!f) { structureError(); return; }

    // 車牌
    const plate = parsePlate(file.name);
    if (plate) {
      setValue(f.CarNum, plate[0]);
      setValue(f.CarNum2, plate[1]);
      lines.push({ text: `車牌：${plate[0]}-${plate[1]} 已填入`, level: 'ok' });
    } else {
      clearField(f, 'CarNum', cleared);
      clearField(f, 'CarNum2', cleared);
      lines.push({ text: `檔名無法解析成車牌：${file.name}`, level: 'err' });
    }

    // 車種（由車牌判斷；判斷不出一律預選汽車）
    const ct = PlateRanges.carTypeForPlate(plate && plate[0], plate && plate[1]);
    if (setCarType(f, ct.value)) {
      const why = ct.range ? `${ct.category} ${ct.range}` : ct.reason;
      lines.push({ text: plate ? `車種：${plate[0]} → ${ct.valueLabel}（${why}）` : `車種：${ct.valueLabel}（${why}）`, level: 'ok' });
    } else {
      clearField(f, 'car_type', cleared);
      lines.push({ text: `車種選單找不到「${ct.valueLabel}」選項，未選擇`, level: 'err' });
    }

    // 日期與時間
    let dateOk = false;
    if (!time.ok) {
      lines.push({ text: '讀不到影片拍攝時間，日期與時間未填', level: 'err' });
      lines.push({ text: time.reason, muted: true });
    } else {
      const t = Mp4Time.toTaipeiParts(time.date);
      lines.push({ text: `拍攝時間：${t.date} ${t.time}:${t.second}（${time.source}）` });
      const diff = dayNumber(Mp4Time.toTaipeiParts(new Date()).date) - dayNumber(t.date);
      if (diff > DEADLINE_DAYS) {
        lines.push({ text: `已超過 ${DEADLINE_DAYS} 天檢舉期限，日期與時間未填`, level: 'err' });
      } else if (diff < 0) {
        lines.push({ text: '影片日期晚於今天，請確認，日期與時間未填', level: 'err' });
      } else {
        setValue(f.cardate, t.date);
        setValue(f.carTime, t.time);
        lines.push({ text: `日期 ${t.date}、時間 ${t.time} 已填入`, level: 'ok' });
        dateOk = true;
      }
    }
    if (!dateOk) {
      clearField(f, 'cardate', cleared);
      clearField(f, 'carTime', cleared);
    }

    // 檔案大小（只警告，檔案是使用者自己放的，不移除）
    if (file.size > MAX_BYTES) {
      lines.push({ text: `檔案 ${formatMB(file.size)}，超過網站單檔上限 50MB`, level: 'warn' });
    }
    if (cleared.length) lines.push({ text: `已清空：${cleared.join('、')}`, level: 'warn' });

    panel.setInfo(lines);
  }

  // 頁面載入時先確認結構
  if (!getFields()) structureError();
  else panel.setInfo([HINT]);

  // 在 document 的 capture 階段監聽（#files1 被網站換成新元素時也能收到）。
  // 只讀取，不呼叫 stopPropagation / preventDefault，網站自己的處理照常進行。
  document.addEventListener('change', e => {
    if (e.target instanceof HTMLInputElement && e.target.id === 'files1') {
      handleFile().catch(err => {
        panel.setInfo([{ text: '處理影片時發生錯誤，沒有填入', level: 'err' }, { text: String(err && err.message || err), muted: true }]);
      });
    }
  }, true);

  // 網站按 X（#clearfilename）清空附件 1 時可能不會觸發 change，所以另外監聽點擊。
  // 我們的監聽在網站的處理之前執行，因此稍等一下再確認 #files1 確實沒有檔案才清除。
  // 同樣只監聽、不阻止網站的處理。
  document.addEventListener('click', e => {
    if (!(e.target instanceof Element) || !e.target.closest('#clearfilename')) return;
    const mySeq = seq;
    let tries = 0;
    const check = () => {
      if (seq !== mySeq) return; // 這段期間已經有新的變更（例如 change 事件已處理）
      const fields = getFields();
      if (!fields) { structureError(); return; }
      if (fields.files1.files && fields.files1.files.length === 0) handleCleared(fields);
      else if (++tries < 5) setTimeout(check, 100); // 網站可能稍晚才清空；最多等約 0.5 秒
    };
    setTimeout(check, 0);
  }, true);
})();
