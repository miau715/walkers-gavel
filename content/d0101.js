// content/d0101.js — 第一頁（D0101）個人資料填寫
//
// 規則：
// - 五個欄位任何一個找不到 → 「頁面結構可能改版」，一個都不填
// - 個人資料某欄沒有設定 → 略過該欄，其餘照填
// - 頁面上的欄位已經有內容 → 略過該欄（不覆蓋）
// - 要填入的值超過網站欄位的長度上限（maxlength）→ 一個都不填
// - 身分證字號填入時轉大寫
// - 每個欄位填值後觸發 input、change；填完把游標移到驗證碼 #tel
// - 驗證碼、送出按鈕永遠不碰
// 個人資料只在這支 isolated world 的 content script 中處理，不經過網站的 MAIN world，也不顯示在面板上。

(() => {
  'use strict';
  if (location.pathname !== '/TTPB/D0101') return; // 完整比對路徑（查詢參數與 # 不影響）

  const FIELDS = [
    { id: 'txtName', key: 'name', label: '姓名' },
    { id: 'txtId', key: 'idNumber', label: '身分證字號', upper: true },
    { id: 'txtEmaill', key: 'email', label: '電子信箱' }, // 網站的 id 拼字就是兩個 l
    { id: 'txtNum', key: 'phone', label: '手機' },
    { id: 'txtAdd', key: 'address', label: '聯絡地址' },
  ];

  async function fillPersonal(api) {
    // 1. 先確認頁面結構，找不到任何一欄就停止
    const inputs = FIELDS.map(f => document.getElementById(f.id));
    if (inputs.some(input => !(input instanceof HTMLInputElement))) {
      return { ok: false, message: '頁面結構可能改版' };
    }

    // 2. 向 background 取得這一頁需要的欄位
    const r = await api.send('getD0101Fields');
    if (!r) return null; // 面板已切換畫面（例如已被自動鎖定）
    if (!r.ok) return r;

    // 3. 決定每一欄要填或略過
    const toFill = [];
    const notSet = [];
    const hasContent = [];
    FIELDS.forEach((f, i) => {
      let value = r.fields[f.key] || '';
      if (f.upper) value = value.toUpperCase();
      if (!value) notSet.push(f.label);
      else if (inputs[i].value.trim() !== '') hasContent.push(f.label);
      else toFill.push({ field: f, input: inputs[i], value });
    });

    // 4. 任何一個要填的值超過長度上限，就一個都不填
    for (const { field, input, value } of toFill) {
      if (input.maxLength > 0 && value.length > input.maxLength) {
        return { ok: false, message: `${field.label}超過網站上限 ${input.maxLength} 字，全部未填入` };
      }
    }

    // 5. 填入
    for (const { input, value } of toFill) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const tel = document.getElementById('tel');
    if (tel) tel.focus();

    // 6. 結果訊息（只列欄位名稱，不顯示內容），每一項各自一行
    const lines = [toFill.length ? { text: `已填入 ${toFill.length} 欄`, level: 'ok' } : { text: '沒有填入任何欄位', level: 'warn' }];
    if (hasContent.length) lines.push({ text: `已有內容未覆蓋：${hasContent.join('、')}`, level: 'warn' });
    if (notSet.length) lines.push({ text: `未設定：${notSet.join('、')}`, level: 'warn' });
    const partial = hasContent.length > 0 || notSet.length > 0 || !toFill.length;
    return { ok: true, level: partial ? 'warn' : 'ok', lines };
  }

  WGPanel.mount({
    onUnlocked(api) {
      api.addAction('填入個人資料', () => fillPersonal(api));
      // 五個欄位的內容改變時，清掉按鈕旁的訊息（不顯示內容，只用來比對）
      api.watch(() => JSON.stringify(FIELDS.map(f => {
        const input = document.getElementById(f.id);
        return input ? input.value : null;
      })));
    },
  });
})();
