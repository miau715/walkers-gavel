// content/main-world.js — 在網站的 MAIN world 執行，只負責操作 selectize（路、交叉路口）
//
// selectize 的 API（element.selectize）只存在於網站的 JS 環境，isolated world 的 content script 拿不到，
// 所以由這支小腳本代為呼叫。與 isolated world 之間用 CustomEvent 溝通，detail 一律是 JSON 字串：
//
//   isolated → MAIN：document 上的 'wg-selectize-request'
//     { reqId, id: 'selectize_Road' | 'selectize_Road2', value, text, timeoutMs }
//     value 為空字串 → 清空該欄位
//   MAIN → isolated：document 上的 'wg-selectize-response'
//     { reqId, ok: true, value }                          已設定（value 為實際設定的值）
//     { reqId, ok: false, reason: 'no-selectize' }        逾時前一直找不到 element.selectize
//     { reqId, ok: false, reason: 'not-found' }           逾時前選項一直沒有載入（value 與顯示文字都比對不到）
//     { reqId, ok: false, reason: 'bad-request' }
//
// 這裡只會收到「地點的選項值與顯示文字」，不會收到任何個人資料。
// 這支腳本不讀取、不送出頁面上的任何其他資料。

(() => {
  'use strict';
  if (location.pathname !== '/TTPB/D0102') return; // 完整比對路徑（查詢參數與 # 不影響）

  const ALLOWED_IDS = new Set(['selectize_Road', 'selectize_Road2']);
  const MAX_TIMEOUT = 5000;
  const POLL_MS = 100;
  // 先只用 value 比對這麼久，之後才改用顯示文字比對。
  // 理由：換了「區」之後，網站可能還留著上一個區的路名選項，同名的路（例如兩個區都有中正路）會被文字比對誤選。
  const TEXT_FALLBACK_AFTER = 2000;

  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

  function reply(detail) {
    document.dispatchEvent(new CustomEvent('wg-selectize-response', { detail: JSON.stringify(detail) }));
  }

  document.addEventListener('wg-selectize-request', e => {
    let req;
    try { req = JSON.parse(e.detail); } catch { return; }
    if (!req || typeof req.reqId !== 'string') return;
    if (!ALLOWED_IDS.has(req.id) || typeof req.value !== 'string' || typeof req.text !== 'string') {
      reply({ reqId: req.reqId, ok: false, reason: 'bad-request' });
      return;
    }
    const start = Date.now();
    const deadline = start + Math.min(Number(req.timeoutMs) || MAX_TIMEOUT, MAX_TIMEOUT);

    const tick = () => {
      const el = document.getElementById(req.id);
      const s = el && el.selectize;
      if (!s) {
        if (Date.now() < deadline) setTimeout(tick, POLL_MS);
        else reply({ reqId: req.reqId, ok: false, reason: 'no-selectize' });
        return;
      }
      if (req.value === '') {
        s.clear();
        reply({ reqId: req.reqId, ok: true, value: '' });
        return;
      }
      // 先用 value 比對；一段時間後仍比對不到，再用顯示文字比對
      let value = null;
      if (Object.prototype.hasOwnProperty.call(s.options, req.value)) {
        value = req.value;
      } else if (Date.now() - start >= TEXT_FALLBACK_AFTER || Date.now() >= deadline) {
        const labelField = (s.settings && s.settings.labelField) || 'text';
        const valueField = (s.settings && s.settings.valueField) || 'value';
        const target = norm(req.text);
        const hit = Object.values(s.options).find(o => target && norm(o[labelField]) === target);
        if (hit) value = String(hit[valueField]);
      }
      if (value === null) {
        if (Date.now() < deadline) setTimeout(tick, POLL_MS);
        else reply({ reqId: req.reqId, ok: false, reason: 'not-found' });
        return;
      }
      s.setValue(value);
      reply({ reqId: req.reqId, ok: true, value });
    };
    tick();
  });
})();
