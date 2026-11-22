// 用法：node tools/mp4-time-check.mjs [資料夾，預設 test-videos/]
// 以 lib/mp4-time.js 解析資料夾內每支 .mov / .mp4，印出表格。只讀取，不修改任何檔案。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mp4Time from '../lib/mp4-time.js';

if (typeof fs.openAsBlob !== 'function') {
  console.error(`這個 Node 版本（${process.version}）不支援 fs.openAsBlob（需要 v19.8 以上）。`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] ?? path.join(here, '..', 'test-videos'));
const files = fs.readdirSync(dir)
  .filter(name => /\.(mov|mp4)$/i.test(name))
  .sort();

if (files.length === 0) {
  console.log(`${dir} 裡沒有 .mov / .mp4 檔案`);
  process.exit(0);
}

const rows = [];
for (const name of files) {
  const blob = await fs.openAsBlob(path.join(dir, name));
  const r = await Mp4Time.readVideoStartTime(blob);
  if (r.ok) {
    const t = Mp4Time.toTaipeiParts(r.date);
    rows.push([name, r.source, String(r.raw), `${t.date} ${t.time}:${t.second}`]);
  } else {
    rows.push([name, '讀不到', '', r.reason]);
  }
}

// 以顯示寬度對齊（中日韓全形字元算 2 格）
const width = s => [...s].reduce((w, ch) => w + (/[ᄀ-￿]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const header = ['檔名', '時間來源', '原始值', '台灣時間（Asia/Taipei）'];
const all = [header, ...rows];
const widths = header.map((_, i) => Math.max(...all.map(r => width(r[i]))));
const line = r => '| ' + r.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
console.log(line(header));
console.log('|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|');
for (const r of rows) console.log(line(r));
