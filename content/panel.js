// content/panel.js — 檢舉頁面右下角的浮動面板（D0101、D0102 共用）
//
// 用法（在各頁面的 content script 中）：
//
//   const panel = WGPanel.mount({
//     lockedHint: '鎖定時要額外顯示的說明（可省略）',
//     onUnlocked(api) {
//       // 已解鎖時呼叫，用來放這一頁的按鈕
//       api.addAction('按鈕文字', async () => {
//         const r = await api.send('某訊息');      // 送給 background；未解鎖時面板會自動切回鎖定畫面
//         if (!r.ok) return r;                      // { ok: false, message } → 按鈕旁顯示紅字
//         return { ok: true, message: '完成' };     // level: 'warn' 可顯示為提醒（橘色）
//         // 多行：{ ok: true, lines: [{ text, level }, …] }，每一項各自一行
//       });
//       api.watch(() => 表單狀態字串);              // 表單內容改變時，清掉 addAction 按鈕旁的訊息
//       const sec = api.addSection('區塊標題');      // 分區：sec.append(元素)、sec.addAction(文字, run)、sec.watch(fn)
//       api.el('select', { className: 'select' });   // 建立元素的小工具
//       api.onFormChange(() => { … });              // 表單可能改變時呼叫（input、change 事件，加上每秒一次）
//       api.onLeave(() => { … });                   // 離開解鎖畫面時的清理（例如被鎖定）
//     },
//   });
//
//   // 資訊區：不論鎖定與否都會顯示（例如 D0102 的影片讀取結果，不需要解密資料）
//   panel.setInfo([{ text: '車牌：ABC-1234 已填入', level: 'ok' }, { text: '…', level: 'err' }]);
//   // level：'ok' 綠、'warn' 橘、'err' 紅、省略則為一般文字；muted: true 為灰色小字
//
// 狀態：尚未設定主密碼 / 鎖定 / 已解鎖。
//
// 按鈕旁的操作結果訊息：按鈕分成幾組（addAction 的按鈕一組、每個 addSection 一組、鎖定列一組）。
// - 同一組按下任何按鈕時，先清掉該組所有舊訊息
// - 該組有 watch(fn) 時，fn() 的結果和顯示訊息當時不同（表單內容改變）就清掉該組訊息。
//   偵測時機：document 的 input、change 事件，加上每秒檢查一次（selectize 與網站程式改值不一定會觸發原生事件）
// 鎖定時面板只有「解鎖」按鈕：按下後由 background 開一個擴充功能自己的小視窗（unlock/unlock.html）
// 輸入主密碼。主密碼不會出現在檢舉網站的頁面上，這支 content script 和網站本身都拿不到。
//
// 面板放在 closed Shadow DOM 裡，網站的 CSS 影響不到面板、網站的程式也取不到面板內的元素。
// 面板上不顯示任何個人資料。

(() => {
  'use strict';
  if (globalThis.WGPanel) return;

  // icons/icon.svg 的內容（viewBox 相同：四邊各放寬 0.25，避免旋轉後超出 0～16 的握柄末端、槌頭圓角被裁切）
  const LOGO_SVG = `<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="-0.25 -0.25 16.5 16.5" aria-hidden="true" focusable="false">
    <path fill="#b5905b" d="M11.63,9.06h2.29v6.39c0,.58-.47,1.04-1.04,1.04h-.21c-.58,0-1.04-.47-1.04-1.04v-6.39h0Z" transform="translate(-5.29 12.78) rotate(-45)"/>
    <rect fill="#b5905b" x="2.71" y="3.76" width="8.54" height="6.44" transform="translate(-2.89 6.98) rotate(-45)"/>
    <rect fill="#8e6632" x="2.37" y="6.8" width="1.86" height="7.71" rx=".73" ry=".73" transform="translate(-6.57 5.45) rotate(-45)"/>
    <rect fill="#8e6632" x="9.72" y="-.56" width="1.86" height="7.71" rx=".73" ry=".73" transform="translate(.79 8.5) rotate(-45)"/>
    <path fill="#8e6632" d="M10.67,7.83h0c.5.5.57,1.23.17,1.63l-1.38,1.38c-.4.4-1.13.33-1.63-.17h0"/>
    <polygon fill="#fff" points="6.36 10.11 5.68 10.79 4.03 7.41 4.71 6.73 6.36 10.11"/>
    <polygon fill="#fff" points="8.14 8.32 7.46 9 5.82 5.63 6.5 4.95 8.14 8.32"/>
    <polygon fill="#fff" points="9.92 6.54 9.24 7.22 7.6 3.85 8.28 3.17 9.92 6.54"/>
  </svg>`;

  const CSS = `
    :host { all: initial; }
    .panel {
      /* 配色取自路面：柏油色的標題列、斑馬線條紋、行人專用標誌的藍、號誌的紅綠。
         面板固定用深色（不跟隨系統的淺色／深色設定）：檢舉網站是白底，深色面板才容易和網站區隔。 */
      --fg: #e7eaec; --muted: #9aa3ab; --bg: #1b1e21; --surface: #262a2e; --border: #3b4147;
      --accent: #8a6a3c; --on-accent: #ffffff; --focus: #b5905b; --danger: #ff8073; --ok: #62d394; --warn: #e6b450;
      --road: #0f1113; --stripe: #f4f4f0; --on-road: #ffffff;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 330px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 1px 2px rgba(20,24,28,.20), 0 10px 28px rgba(20,24,28,.32);
      /* 字級只有兩種：一般文字 16px、小字 14px，不使用更小的字 */
      font: 16px/1.5 -apple-system, "PingFang TC", "Noto Sans TC", sans-serif;
      font-variant-numeric: tabular-nums;
      color-scheme: dark;
      overflow: hidden;
    }
    .head {
      flex: none;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 8px 8px 12px; background: var(--road); color: var(--on-road);
    }
    .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    /* 標誌：icons/icon.svg 內嵌（不從擴充功能載入檔案，不受網站的 COEP、CSP 影響） */
    .logo { flex: none; display: block; width: 16px; height: 16px; }
    .title { font-weight: 600; letter-spacing: .04em; }
    .toggle {
      background: transparent; color: var(--on-road); opacity: .75; border: 0; border-radius: 5px;
      padding: 3px 8px; font: inherit; font-size: 14px; cursor: pointer;
    }
    .toggle:hover { opacity: 1; background: rgba(255,255,255,.12); }
    .toggle:focus-visible { opacity: 1; outline: 2px solid var(--on-road); outline-offset: 1px; }
    .scroll { overflow-y: auto; overscroll-behavior: contain; }
    .panel.collapsed .scroll { display: none; }
    .body { padding: 12px; }
    p { margin: 0 0 8px; }
    .muted { color: var(--muted); font-size: 14px; }
    .row { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    button.btn {
      font: inherit; font-weight: 500; min-height: 34px; padding: 4px 14px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent);
    }
    button.btn:hover { filter: brightness(1.08); }
    button.btn:focus-visible, select.select:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    /* 次要按鈕：鎖定，以及每一區「套用」左邊的「存為…」 */
    button.btn.secondary, .section .row:not(:last-child) button.btn {
      background: var(--surface); color: var(--fg); border-color: var(--border); font-weight: 400;
    }
    .section .row:not(:last-child) button.btn { font-size: 14px; padding: 4px 10px; }
    button.btn:disabled { opacity: .5; cursor: wait; }
    /* 操作結果與影片資訊：顏色之外再加上符號，不只靠顏色分辨 */
    .note { font-size: 14px; font-weight: 500; }
    .note.ok { color: var(--ok); }
    .note.err { color: var(--danger); }
    .note.warn { color: var(--warn); }
    .note.ok:not(:empty)::before { content: "✓ "; }
    .note.err:not(:empty)::before { content: "✕ "; }
    .note.warn:not(:empty)::before { content: "! "; font-weight: 700; }
    /* 多行訊息：每一項各自一行，各自有符號 */
    .note.lines { flex: 0 0 100%; }
    .note-line { display: block; }
    .note-line.ok { color: var(--ok); }
    .note-line.err { color: var(--danger); }
    .note-line.warn { color: var(--warn); }
    .note-line.ok::before { content: "✓ "; }
    .note-line.err::before { content: "✕ "; }
    .note-line.warn::before { content: "! "; font-weight: 700; }
    .info {
      margin: 12px 12px 0; padding: 9px 10px; border-radius: 6px; background: var(--surface);
    }
    .info:empty { display: none; }
    .info p { position: relative; margin: 0 0 3px; font-size: 14px; line-height: 1.45; word-break: break-all; }
    .info p:last-child { margin-bottom: 0; }
    .info p:first-child:not(:only-child) { font-weight: 600; margin-bottom: 5px; }
    .info .ok, .info .warn, .info .err { padding-left: 1.4em; font-weight: 500; }
    .info .ok { color: var(--ok); }
    .info .warn { color: var(--warn); }
    .info .err { color: var(--danger); }
    .info .ok::before, .info .warn::before, .info .err::before {
      position: absolute; left: 0; width: 1.1em; text-align: center; font-weight: 700;
    }
    .info .ok::before { content: "✓"; }
    .info .warn::before { content: "!"; }
    .info .err::before { content: "✕"; }
    .info .muted { color: var(--muted); font-size: 14px; }
    .info :is(.ok, .warn, .err) + .muted { padding-left: 1.6em; }
    /* 每一區：標題、下拉選單各佔一列；按鈕一列：「目前內容存為常用」靠左、「套用」靠右，訊息顯示在按鈕下面 */
    .section {
      display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0 8px;
      border-top: 1px solid var(--border); padding-top: 10px; margin-top: 12px;
    }
    .section h3, .section select.select { flex: 0 0 100%; }
    .section .row { display: contents; }
    .section .note { order: 1; flex: 0 0 100%; margin-top: 6px; }
    .section .note:empty { display: none; }
    .section button.btn.push-left { margin-right: auto; }
    .section button.btn[hidden] { display: none; }
    .section:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
    .section h3 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
    .lock-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .lock-row + .muted { margin: 0; font-size: 14px; }
    select.select {
      width: 100%; height: 36px; margin-bottom: 8px; padding: 0 6px; font: inherit; font-size: 16px;
      color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    }
  `;

  function mount({ onUnlocked = () => {}, lockedHint = '' } = {}) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <div class="head">
          <span class="brand">${LOGO_SVG}<span class="title">行人的法槌</span></span>
          <button type="button" class="toggle" aria-expanded="true">收合</button>
        </div>
        <div class="scroll">
          <div class="info" role="status"></div>
          <div class="body"></div>
        </div>
      </div>`;
    const panel = root.querySelector('.panel');
    const info = root.querySelector('.info');
    const body = root.querySelector('.body');
    const toggle = root.querySelector('.toggle');
    toggle.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '展開' : '收合';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });
    document.documentElement.appendChild(host);

    let state = '';
    let leaveFns = []; // 離開解鎖畫面時要執行的清理（清掉暫存的常用資料、取消進行中的套用）
    let formFns = [];  // 表單可能改變時要呼叫的函式（只在解鎖畫面使用）
    let formTimer = null;
    const notifyForm = () => { for (const fn of formFns) { try { fn(); } catch {} } };

    function startFormWatch() {
      if (formTimer) return;
      document.addEventListener('input', notifyForm, true);
      document.addEventListener('change', notifyForm, true);
      formTimer = setInterval(notifyForm, 1000);
    }

    function stopFormWatch() {
      formFns = [];
      if (!formTimer) return;
      clearInterval(formTimer);
      formTimer = null;
      document.removeEventListener('input', notifyForm, true);
      document.removeEventListener('change', notifyForm, true);
    }

    function onFormChange(fn) {
      formFns.push(fn);
      startFormWatch();
    }

    function el(tag, props = {}, text = '') {
      const e = document.createElement(tag);
      Object.assign(e, props);
      if (text) e.textContent = text;
      return e;
    }

    function show(newState, build) {
      const fns = leaveFns;
      leaveFns = [];
      for (const fn of fns) { try { fn(); } catch {} }
      stopFormWatch();
      state = newState;
      body.replaceChildren();
      build();
    }

    // ---- 按鈕與操作結果訊息 ----

    // 一組按鈕共用的訊息狀態：notes 是這組的所有訊息欄；snap 是表單狀態（watch 設定）
    function makeGroup() {
      const group = { notes: [], snap: null, shown: null };
      group.watch = fn => {
        group.snap = fn;
        onFormChange(() => {
          if (!group.notes.some(n => n.childNodes.length)) return; // 沒有訊息
          let now;
          try { now = fn(); } catch { return; }
          if (now !== group.shown) clearGroup(group);
        });
      };
      return group;
    }

    const noteTimers = new WeakMap();
    function clearNote(note) {
      clearTimeout(noteTimers.get(note));
      note.className = 'note';
      note.replaceChildren();
    }
    function clearGroup(group) {
      for (const n of group.notes) clearNote(n);
    }

    function showResult(group, note, r) {
      const level = !r.ok ? 'err' : (r.level || 'ok');
      if (Array.isArray(r.lines)) {
        note.className = 'note lines';
        note.replaceChildren(...r.lines.map(l => el('span', { className: 'note-line ' + (l.level || level) }, l.text)));
      } else {
        note.className = 'note ' + level;
        note.textContent = r.message || '';
      }
      try { group.shown = group.snap ? group.snap() : null; } catch { group.shown = null; }
      if (level === 'ok') noteTimers.set(note, setTimeout(() => clearNote(note), 3000));
    }

    // 按鈕：按下時先清掉同一組的舊訊息，執行完把結果顯示在 note
    function button(group, note, label, run, secondary) {
      const btn = el('button', { type: 'button', className: 'btn' + (secondary ? ' secondary' : '') }, label);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        clearGroup(group);
        try {
          const r = await run();
          if (!r || !note.isConnected) return; // 畫面已切換（例如被自動鎖定）
          showResult(group, note, r);
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    }

    function newNote(group) {
      const note = el('span', { className: 'note' });
      note.setAttribute('role', 'status');
      group.notes.push(note);
      return note;
    }

    // 一列：按鈕 + 旁邊的訊息
    function actionRow(group, label, run, secondary = false) {
      const row = el('div', { className: 'row' });
      const note = newNote(group);
      row.append(button(group, note, label, run, secondary), note);
      return row;
    }

    // 送訊息給 background。發現未解鎖或尚未設定時，直接切換畫面。
    async function send(type, params = {}) {
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type, ...params });
      } catch {
        showStale();
        return null;
      }
      if (!r) { showStale(); return null; }
      if (r.error === 'LOCKED' || r.error === 'NOT_SET_UP') {
        await refresh();
        return null;
      }
      return r;
    }

    function showStale() {
      show('stale', () => body.append(el('p', { className: 'note err' }, '擴充功能已更新，請重新整理頁面')));
    }

    function showNotSetUp() {
      show('notSetUp', () => {
        body.append(el('p', {}, '尚未設定主密碼，請先到設定頁設定。設定完請重新整理此頁面並解鎖再開始填寫。'));
        body.append(actionRow(makeGroup(), '開啟設定頁', async () => {
          const r = await send('openOptions');
          return r && !r.ok ? r : null;
        }));
      });
    }

    function showLocked() {
      show('locked', () => {
        if (lockedHint) body.append(el('p', { className: 'muted' }, lockedHint));
        body.append(actionRow(makeGroup(), '解鎖', async () => {
          const r = await send('openUnlock');
          return r && !r.ok ? r : null;
        }));
      });
    }

    function showUnlocked() {
      show('unlocked', () => {
        const actions = el('div');
        body.append(actions);
        const topGroup = makeGroup(); // addAction 的按鈕
        onUnlocked({
          send,
          el,
          // 離開解鎖畫面（鎖定、自動鎖定、改密碼、清除資料等）時呼叫
          onLeave(fn) { leaveFns.push(fn); },
          onFormChange,
          watch: topGroup.watch,
          addAction(label, run) { actions.append(actionRow(topGroup, label, run)); },
          addSection(title) {
            const sec = el('div', { className: 'section' });
            if (title) sec.append(el('h3', {}, title));
            actions.append(sec);
            const group = makeGroup();
            return {
              append(...nodes) { sec.append(...nodes); },
              addAction(label, run) { const row = actionRow(group, label, run); sec.append(row); return row; },
              watch: group.watch,
            };
          },
        });
        // 鎖定列：「鎖定」與「開啟設定頁」（都是次要按鈕，靠左排列），共用一個訊息欄
        const lockGroup = makeGroup();
        const lockRow = el('div', { className: 'row lock-row' });
        const lockNote = newNote(lockGroup);
        lockRow.append(
          button(lockGroup, lockNote, '鎖定', async () => {
            await send('lock');
            await refresh();
            return null;
          }, true),
          button(lockGroup, lockNote, '開啟設定頁', async () => {
            const r = await send('openOptions');
            return r && !r.ok ? r : null;
          }, true),
          lockNote);
        body.append(lockRow);
        body.append(el('p', { className: 'muted' }, '閒置 10 分鐘或關閉瀏覽器後自動鎖定。'));
      });
    }

    async function refresh() {
      let s;
      try {
        s = await chrome.runtime.sendMessage({ type: 'status' });
      } catch {
        showStale();
        return;
      }
      if (!s || !s.ok) { showStale(); return; }
      const next = !s.setUp ? 'notSetUp' : s.unlocked ? 'unlocked' : 'locked';
      if (next === state) return; // 狀態沒變就不重畫（保留按鈕旁的訊息）
      if (next === 'notSetUp') showNotSetUp();
      else if (next === 'unlocked') showUnlocked();
      else showLocked();
    }

    // background 通知：檢舉頁的解鎖狀態改變了（解鎖、鎖定、自動鎖定、改密碼、清除資料）
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.event === 'reportLockChanged') refresh();
    });

    refresh();

    return {
      // 資訊區的內容（整份取代）。不論鎖定與否都顯示。
      setInfo(items) {
        info.replaceChildren(...items.map(({ text, level, muted }) =>
          el('p', { className: muted ? 'muted' : (level || '') }, text)));
      },
    };
  }

  globalThis.WGPanel = { mount };
})();
