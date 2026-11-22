// unlock/unlock.js — 檢舉頁面的解鎖視窗。
// 主密碼直接送給 background.js（不經過 content script 或網站）。
// 解鎖成功 → 關閉這個視窗；background 會通知各檢舉頁的面板切換畫面。
// 密碼錯誤 → 在按鈕旁顯示訊息，視窗不關。沒解鎖就關掉視窗 → 什麼都不會發生。

const pw = document.getElementById('pw');
const btn = document.getElementById('btn');
const note = document.getElementById('note');

async function unlock() {
  if (btn.disabled) return;
  btn.disabled = true;
  note.textContent = '';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'unlock', password: pw.value });
    pw.value = '';
    if (r && r.ok) {
      window.close();
      return;
    }
    note.textContent = r ? r.message : '解鎖失敗';
    pw.focus();
  } catch {
    note.textContent = '解鎖失敗，請關閉視窗再試一次';
  } finally {
    btn.disabled = false;
  }
}

btn.addEventListener('click', unlock);
// 一般的 Enter 送出（中文輸入法組字中按的 Enter 只是選字，不送出）
pw.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) unlock();
});
pw.focus();
