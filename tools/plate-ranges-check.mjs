// 用法：node tools/plate-ranges-check.mjs
// 測試 lib/plate-ranges.js 的車種判斷。
import PlateRanges from '../lib/plate-ranges.js';

const { carTypeForPlate, FLAT } = PlateRanges;
let failed = 0;
let count = 0;
function expect(desc, p1, p2, value, inTable) {
  count++;
  const r = carTypeForPlate(p1, p2);
  const pass = r.value === value && (inTable ? r.range !== null : r.range === null);
  if (!pass) {
    failed++;
    console.log(`FAIL  ${desc}：${p1}-${p2} → ${r.value}（${r.category ?? r.reason}），預期 ${value}${inTable ? '（表內）' : '（預設）'}`);
  }
  return r;
}

// 字母序加減一（三碼）
const toN = s => [...s].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 65), 0);
const fromN = n => [2, 1, 0].map(i => String.fromCharCode(65 + Math.floor(n / 26 ** i) % 26)).join('');

// 1. 指定案例
const r = expect('使用者的車牌', 'EBG', '5917', 'A', true);
console.log(`EBG-5917 → ${r.valueLabel}（${r.category} ${r.range}）`);

// 2. 範圍表本身：每個範圍 lo <= hi、範圍之間沒有重疊
for (const x of FLAT) {
  if (!(x.lo <= x.hi)) { failed++; console.log(`FAIL  範圍顛倒：${x.category} ${x.lo}～${x.hi}`); }
}
for (let i = 0; i < FLAT.length; i++) for (let j = i + 1; j < FLAT.length; j++) {
  const a = FLAT[i], b = FLAT[j];
  if (a.lo <= b.hi && b.lo <= a.hi) { failed++; console.log(`FAIL  範圍重疊：${a.category} ${a.lo}～${a.hi} 與 ${b.category} ${b.lo}～${b.hi}`); }
}

// 3. 每個範圍的頭尾邊界都判斷為該範圍的車種
for (const x of FLAT) {
  expect(`${x.category} 起點`, x.lo, '0001', x.value, true);
  expect(`${x.category} 終點`, x.hi, '9999', x.value, true);
}

// 4. 範圍之間的空隙：列舉 AAA～ZZZ 全部 17576 個字首，不在任何範圍的都要預選汽車（預設）
const gaps = [];
for (let n = 0; n < 26 ** 3; n++) {
  const p = fromN(n);
  const inside = FLAT.some(x => x.lo <= p && p <= x.hi);
  if (!inside) gaps.push(p);
  expect(inside ? '表內字首' : '空隙字首', p, '1234', inside ? FLAT.find(x => x.lo <= p && p <= x.hi).value : 'A', inside);
}
// 把空隙合併成區段列出，方便和官方表核對
const gapRanges = [];
for (const g of gaps) {
  const last = gapRanges[gapRanges.length - 1];
  if (last && toN(last[1]) + 1 === toN(g)) last[1] = g; else gapRanges.push([g, g]);
}
console.log(`空隙（不在表內，預設汽車）共 ${gaps.length} 個字首：${gapRanges.map(([a, b]) => a === b ? a : `${a}～${b}`).join('、')}`);

// 5. 範圍邊界外側一格（若不在其他範圍內）應為預設汽車
for (const x of FLAT) {
  for (const p of [toN(x.lo) - 1, toN(x.hi) + 1].filter(n => n >= 0 && n < 26 ** 3).map(fromN)) {
    if (!FLAT.some(y => y.lo <= p && p <= y.hi)) expect(`${x.category} 邊界外`, p, '1234', 'A', false);
  }
}

// 6. 舊式車牌與格式不符：一律預設汽車
for (const [p1, p2, desc] of [
  ['AB', '1234', '舊式：二英文－四數字'],
  ['1234', 'AB', '舊式：四數字－二英文'],
  ['ABC', '123', '舊式機車：三英文－三數字（普通重型機車字首）'],
  ['MAY', '123', '三英文－三數字'],
  ['123', 'ABC', '三數字－三英文'],
  ['AB', 'C123', '二英文－英數混合'],
  ['EB1', '5917', '字首含數字'],
  ['EBG', '591A', '後段含英文'],
  ['ebg', '5917', '小寫（應轉大寫後判斷）'],
  ['', '', '空字串'],
  [null, undefined, '沒有車牌（檔名解析失敗）'],
]) {
  const isLower = desc.startsWith('小寫');
  expect(desc, p1, p2, isLower ? 'A' : 'A', isLower);
}
// 小寫字首落在機車範圍時也要正確判斷
expect('小寫機車字首', 'may', '1234', 'C', true);

console.log(failed ? `\n${count} 項中 ${failed} 項失敗` : `\n${count} 項全部通過`);
process.exit(failed ? 1 : 0);
