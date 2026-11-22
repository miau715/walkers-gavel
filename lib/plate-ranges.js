// lib/plate-ranges.js — 從車牌判斷車種（公路總局「車牌不分車種一車一號」103 年版對照表）
//
// 以一般 <script>／content script 載入時掛在 globalThis.PlateRanges；在 Node 以 import / require 載入時為 module.exports。
// 官方範圍有變動時只改 RANGES 這張表。
//
// carTypeForPlate(part1, part2) 回傳：
//   { value: 'A'|'B'|'C'|'D', valueLabel, category, range: 'EAN～EZZ' }   落在表內某範圍
//   { value: 'A', valueLabel: '汽車', category: null, range: null, reason }  其他所有情況（預設汽車）
(function (root) {
  'use strict';

  // 網站 #car_type 的選項
  const CAR_TYPE_LABELS = { A: '汽車', B: '輕型機車', C: '重型機車', D: '大型重型機車' };

  // [車種, 範圍..., 網站選項 value]。照 SPEC.md「D0102：車種（從車牌）」的表格，不自行增減。
  const RANGES = [
    ['自用小客（貨）車', ['AJF', 'DZZ'], ['FAA', 'GZZ'], ['UAA', 'VZZ'], ['EAN', 'EZZ'], 'A'],
    ['身心障礙者專用車', ['WAC', 'WDZ'], ['WEF', 'WEZ'], 'A'],
    ['租賃小（貨）客車', ['RAQ', 'RDZ'], ['RFA', 'RZZ'], ['REN', 'REZ'], 'A'],
    ['自用大貨車（含自用曳引車）', ['KEA', 'KHZ'], ['KSA', 'KSZ'], 'A'],
    ['自用大客車', ['KJA', 'KJZ'], 'A'],
    ['營業大客車', ['KKA', 'KKZ'], 'A'],
    ['營業大貨車（含貨運曳引車）', ['KLA', 'KMZ'], ['KRA', 'KRZ'], 'A'],
    ['營業貨櫃曳引車', ['KNA', 'KNZ'], 'A'],
    ['營業小貨車', ['KPA', 'KPZ'], ['KTA', 'KTZ'], 'A'],
    ['營業小客車', ['TAA', 'TZZ'], 'A'],
    ['遊覽車', ['KAA', 'KDZ'], 'A'],
    ['交通車', ['KQA', 'KQD'], 'A'],
    ['自用拖車', ['HAA', 'HAZ'], 'A'],
    ['營業拖車', ['HBA', 'HDZ'], 'A'],
    ['電動租賃小客車', ['REA', 'REM'], 'A'],
    ['電動身心障礙者專用車', ['WEA', 'WEE'], 'A'],
    ['電動自用小型車', ['EAB', 'EAK'], 'A'],
    ['電動大客車（含營業及自用）', ['EAL', 'EAL'], 'A'],
    ['電動營業小客車', ['EAM', 'EAM'], 'A'],
    ['普通重型機車', ['MAY', 'PZZ'], ['JAA', 'JZZ'], ['XAA', 'ZZZ'], ['WFA', 'WZZ'], ['QNA', 'QZZ'],
      ['LNA', 'LZZ'], ['HEA', 'HZZ'], ['KUA', 'KZZ'], ['KQE', 'KQZ'], ['SFA', 'SZZ'], 'C'],
    ['輕型機車', ['QAL', 'QMZ'], 'B'],
    ['小型輕型機車', ['SAC', 'SEZ'], 'B'],
    ['大型重型機車（黃牌）', ['LAD', 'LFZ'], 'D'],
    ['550cc 以上大型重型機車（紅牌）', ['LGA', 'LMZ'], 'D'],
  ];

  // 攤平成 { category, lo, hi, value } 的清單
  const FLAT = [];
  for (const row of RANGES) {
    const category = row[0];
    const value = row[row.length - 1];
    for (const [lo, hi] of row.slice(1, -1)) FLAT.push({ category, lo, hi, value });
  }

  function defaultResult(reason) {
    return { value: 'A', valueLabel: CAR_TYPE_LABELS.A, category: null, range: null, reason };
  }

  function carTypeForPlate(part1, part2) {
    const p1 = typeof part1 === 'string' ? part1.toUpperCase() : '';
    const p2 = typeof part2 === 'string' ? part2 : '';
    if (!/^[A-Z]{3}$/.test(p1) || !/^[0-9]{4}$/.test(p2)) {
      return defaultResult('不是三英文－四數字的車牌，預設汽車');
    }
    // 三碼大寫英文直接以字串比較即為字母順序
    const hit = FLAT.find(r => r.lo <= p1 && p1 <= r.hi);
    if (!hit) return defaultResult('不在對照表範圍，預設汽車');
    return {
      value: hit.value,
      valueLabel: CAR_TYPE_LABELS[hit.value],
      category: hit.category,
      range: `${hit.lo}～${hit.hi}`,
    };
  }

  const api = { carTypeForPlate, RANGES, FLAT, CAR_TYPE_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlateRanges = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
