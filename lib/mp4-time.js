// lib/mp4-time.js — 從 MP4/MOV 讀取影片開始時間（不使用外部函式庫、不連網）
//
// 以一般 <script> 載入時會掛在 globalThis.Mp4Time；在 Node 以 import / require 載入時為 module.exports。
//
// readVideoStartTime(blob) 回傳：
//   成功：{ ok: true,  date: Date, source: 'creationdate' | 'mvhd', raw: string | number }
//   失敗：{ ok: false, reason: string }   ← 讀不到，呼叫端不可用任何其他值代替
//
// toTaipeiParts(date) 回傳台灣時間：{ date: 'yyyy/MM/dd', time: 'HH:mm', second: 'ss' }
//   time 不含秒（秒數無條件捨去）；second 只供核對顯示用。
(function (root) {
  'use strict';

  // 1904-01-01T00:00:00Z 到 1970-01-01T00:00:00Z 的秒數
  const MAC_EPOCH_TO_UNIX = 2082844800;
  // meta / mvhd 這類小 atom 允許讀進記憶體的上限（避免異常檔案導致讀入大量資料）
  const MAX_SMALL_ATOM = 4 * 1024 * 1024;
  const CREATIONDATE_KEY = 'com.apple.quicktime.creationdate';

  class ParseError extends Error {}

  async function readBytes(blob, start, length) {
    const buf = await blob.slice(start, start + length).arrayBuffer();
    if (buf.byteLength !== length) throw new ParseError('讀取長度不足（檔案可能被截斷）');
    return new DataView(buf);
  }

  function fourcc(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3));
  }

  function u64ToNumber(view, offset) {
    const v = view.getBigUint64(offset);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ParseError('64 位元數值過大');
    return Number(v);
  }

  // 讀 [start, end) 範圍內位於 offset 的 atom header。
  // 回傳 { type, start, headerSize, contentStart, end }
  async function readAtomHeader(blob, offset, end) {
    if (end - offset < 8) throw new ParseError('atom header 不完整');
    const h = await readBytes(blob, offset, 8);
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    let headerSize = 8;
    if (size === 1) {
      // 64 位元 size，緊接在 type 後面
      if (end - offset < 16) throw new ParseError(`atom ${type} 的 64 位元 size 不完整`);
      const ext = await readBytes(blob, offset + 8, 8);
      size = u64ToNumber(ext, 0);
      headerSize = 16;
    } else if (size === 0) {
      // 延伸到所在範圍的結尾（頂層即檔尾）
      size = end - offset;
    }
    if (size < headerSize) throw new ParseError(`atom ${type} 的 size 不合理：${size}`);
    if (offset + size > end) throw new ParseError(`atom ${type} 超出範圍（檔案可能被截斷）`);
    return { type, start: offset, headerSize, contentStart: offset + headerSize, end: offset + size };
  }

  // 在 [start, end) 中依序找第一個指定 type 的子 atom（只讀 header）
  async function findChild(blob, start, end, type) {
    let offset = start;
    while (offset < end) {
      // 容器結尾可能有 4 bytes 的 0 作為結束標記（QuickTime 舊格式），視為結束
      if (end - offset < 8) return null;
      const atom = await readAtomHeader(blob, offset, end);
      if (atom.type === type) return atom;
      offset = atom.end;
    }
    return null;
  }

  // 在 DataView（已讀入記憶體的小 atom 內容）中列出子 atom
  function listChildren(view, start, end) {
    const out = [];
    let offset = start;
    while (offset < end) {
      if (end - offset < 8) break;
      let size = view.getUint32(offset);
      const type = fourcc(view, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (end - offset < 16) throw new ParseError(`atom ${type} 的 64 位元 size 不完整`);
        size = u64ToNumber(view, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) throw new ParseError(`atom ${type} 的 size 不合理`);
      out.push({ type, start: offset, contentStart: offset + headerSize, end: offset + size });
      offset += size;
    }
    return out;
  }

  // ---- creationdate（moov > meta > keys + ilst）----

  // 回傳 { ok: true, raw, date } 或 { ok: false, reason }
  async function readCreationDate(blob, moov) {
    const meta = await findChild(blob, moov.contentStart, moov.end, 'meta');
    if (!meta) return { ok: false, reason: 'moov 中沒有 meta' };
    const len = meta.end - meta.contentStart;
    if (len > MAX_SMALL_ATOM) return { ok: false, reason: 'meta 過大' };
    const v = await readBytes(blob, meta.contentStart, len);

    // QuickTime 的 meta 沒有 version/flags；ISO BMFF 的 meta 有 4 bytes version/flags。
    // 以 hdlr 出現的位置判斷是哪一種。
    let childStart = 0;
    if (len >= 8 && fourcc(v, 4) === 'hdlr') childStart = 0;
    else if (len >= 12 && fourcc(v, 8) === 'hdlr') childStart = 4;
    else return { ok: false, reason: 'meta 結構無法辨識（找不到 hdlr）' };

    const children = listChildren(v, childStart, len);
    const keys = children.find(c => c.type === 'keys');
    const ilst = children.find(c => c.type === 'ilst');
    if (!keys || !ilst) return { ok: false, reason: 'meta 中沒有 keys 或 ilst' };

    // keys：version/flags(4) + entry_count(4) + entries[ key_size(4) + namespace(4) + key ]
    let p = keys.contentStart + 4;
    if (p + 4 > keys.end) return { ok: false, reason: 'keys 不完整' };
    const count = v.getUint32(p);
    p += 4;
    let keyIndex = 0; // 1-based
    for (let i = 1; i <= count; i++) {
      if (p + 8 > keys.end) return { ok: false, reason: 'keys 不完整' };
      const keySize = v.getUint32(p);
      if (keySize < 8 || p + keySize > keys.end) return { ok: false, reason: 'keys 項目 size 不合理' };
      const name = new TextDecoder('utf-8').decode(
        new Uint8Array(v.buffer, v.byteOffset + p + 8, keySize - 8));
      if (name === CREATIONDATE_KEY) { keyIndex = i; break; }
      p += keySize;
    }
    if (!keyIndex) return { ok: false, reason: 'keys 中沒有 ' + CREATIONDATE_KEY };

    // ilst：子 atom 的 type 欄位（4 bytes）是 key 的 1-based 索引
    const item = listChildren(v, ilst.contentStart, ilst.end)
      .find(c => v.getUint32(c.start + 4) === keyIndex);
    if (!item) return { ok: false, reason: 'ilst 中沒有 creationdate 的值' };

    // data：type indicator(4) + locale(4) + value；type 1 = UTF-8
    const data = listChildren(v, item.contentStart, item.end).find(c => c.type === 'data');
    if (!data || data.end - data.contentStart < 8) return { ok: false, reason: 'creationdate 沒有 data' };
    const typeIndicator = v.getUint32(data.contentStart) & 0x00ffffff;
    if (typeIndicator !== 1) return { ok: false, reason: `creationdate 的資料型別不是 UTF-8（${typeIndicator}）` };
    const raw = new TextDecoder('utf-8').decode(
      new Uint8Array(v.buffer, v.byteOffset + data.contentStart + 8, data.end - data.contentStart - 8));

    const date = parseIsoWithZone(raw);
    if (!date) return { ok: false, reason: `creationdate 格式無法解析：${JSON.stringify(raw)}` };
    return { ok: true, raw, date };
  }

  // 嚴格解析帶時區的 ISO 8601，例如 2026-11-21T14:30:12+0800、…+08:00、…Z（可有小數秒）。
  // 沒有時區、或日期時間不存在（例如 2 月 30 日）→ 回傳 null。
  function parseIsoWithZone(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(s);
    if (!m) return null;
    const [Y, Mo, D, h, mi, sec] = m.slice(1, 7).map(Number);
    const ms = m[7] ? Math.floor(Number('0.' + m[7]) * 1000) : 0;
    if (Mo < 1 || Mo > 12 || D < 1 || h > 23 || mi > 59 || sec > 59) return null;
    const local = Date.UTC(Y, Mo - 1, D, h, mi, sec, ms);
    const check = new Date(local);
    if (check.getUTCFullYear() !== Y || check.getUTCMonth() !== Mo - 1 || check.getUTCDate() !== D) return null;
    let offsetMin = 0;
    if (m[8] !== 'Z') {
      const oh = Number(m[10]), om = Number(m[11]);
      if (oh > 23 || om > 59) return null;
      offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    return new Date(local - offsetMin * 60000);
  }

  // ---- mvhd creation_time ----

  async function readMvhd(blob, moov) {
    const mvhd = await findChild(blob, moov.contentStart, moov.end, 'mvhd');
    if (!mvhd) return { ok: false, reason: 'moov 中沒有 mvhd' };
    const len = mvhd.end - mvhd.contentStart;
    if (len < 4) return { ok: false, reason: 'mvhd 不完整' };
    const head = await readBytes(blob, mvhd.contentStart, Math.min(len, 12));
    const version = head.getUint8(0);
    let secs;
    if (version === 0) {
      if (len < 8) return { ok: false, reason: 'mvhd 不完整' };
      secs = head.getUint32(4);
    } else if (version === 1) {
      if (len < 12) return { ok: false, reason: 'mvhd 不完整' };
      secs = u64ToNumber(head, 4);
    } else {
      return { ok: false, reason: `mvhd version 不支援：${version}` };
    }
    if (secs === 0) return { ok: false, reason: 'mvhd creation_time 為 0（未設定）' };
    return { ok: true, raw: secs, date: new Date((secs - MAC_EPOCH_TO_UNIX) * 1000) };
  }

  // ---- 公開函式 ----

  async function readVideoStartTime(blob) {
    try {
      const moov = await findChild(blob, 0, blob.size, 'moov');
      if (!moov) return { ok: false, reason: '找不到 moov' };

      const cd = await readCreationDate(blob, moov);
      if (cd.ok) return { ok: true, date: cd.date, source: 'creationdate', raw: cd.raw };

      const mv = await readMvhd(blob, moov);
      if (mv.ok) return { ok: true, date: mv.date, source: 'mvhd', raw: mv.raw };

      return { ok: false, reason: `creationdate：${cd.reason}；mvhd：${mv.reason}` };
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, reason: '檔案結構錯誤：' + e.message };
      return { ok: false, reason: '讀取失敗：' + (e && e.message ? e.message : String(e)) };
    }
  }

  const taipeiFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });

  function toTaipeiParts(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('不是有效的 Date');
    const p = {};
    for (const part of taipeiFormatter.formatToParts(date)) p[part.type] = part.value;
    return {
      date: `${p.year}/${p.month}/${p.day}`,
      time: `${p.hour}:${p.minute}`,
      second: p.second,
    };
  }

  const api = { readVideoStartTime, toTaipeiParts, parseIsoWithZone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mp4Time = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
