// 用法：node tools/crypto-check.mjs
// 用 Node 內建的 Web Crypto 測試 lib/crypto.js 與 lib/store.js 的格式轉換。只使用假資料。
// chrome.storage.local 以記憶體模擬。
import { deriveKey, encrypt, decrypt, newSalt, toBase64, PBKDF2_ITERATIONS, KDF, VAULT_VERSION } from '../lib/crypto.js';

// 舊格式（第 1 版，沒有 v 與 kdf）的固定樣本：用改版前的 lib/crypto.js 產生，主密碼與內容都是假的
const LEGACY_PASSWORD = 'legacy fake password';
const LEGACY = {
  salt: 'VaUxDvLIDU/JiTcKr5QyVw==',
  vault: {
    iv: 'HUHNiiHBIVzBGEoP',
    ct: '9y03kAa9AwQDk03QE8Qv2tZJOhzLIAGZ70b8pD97flW4BS3odhUqc4nHG44jYXu19QKs+GipkkTKglhzMB3Ehl1xUjKuFlOlVn2ndeP3kPol563DRqmj9Doa5+O5bVr7oyVTRiuY6KGld/H8zDHCv5sQ1OuRDtcyS2JtGDQucdAL2i2Le0GYxeqoak0kCRhTZkGvlIgZoAWcCwviLsbAv8h3gVHYLeaPPUVdGaVU1xEcRhw6HPtkst3QTy5Zu+irVeC2',
  },
};

const FAKE = {
  personal: { name: '測試人', idNumber: 'A000000000', email: 'test@example.invalid', phone: '0900000000', address: '測試市測試區測試路 1 號' },
  combos: [],
  places: [],
};

let failed = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) failed++;
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

check('PBKDF2 iterations >= 600000', PBKDF2_ITERATIONS >= 600000, `(${PBKDF2_ITERATIONS})`);

const salt = newSalt();
const salt2 = newSalt();
check('salt 長度 16 bytes', salt.length === 16);
check('兩次產生的 salt 不同', toBase64(salt) !== toBase64(salt2));

let t = Date.now();
const key = await deriveKey('correct horse battery', salt);
check('金鑰長度 32 bytes（AES-256）', key.length === 32, `(推導耗時 ${Date.now() - t} ms)`);

const box = await encrypt(key, FAKE);
check('IV 長度 12 bytes', Buffer.from(box.iv, 'base64').length === 12);
check('密文中看不到原文', !Buffer.from(box.ct, 'base64').toString('utf8').includes('0900000000')
  && !box.ct.includes('0900000000'));

const back = await decrypt(key, box);
check('加密再解密得到原文', JSON.stringify(back) === JSON.stringify(FAKE));

const again = await deriveKey('correct horse battery', salt);
check('同密碼同 salt 推導出相同金鑰', toBase64(again) === toBase64(key));
check('用重新推導的金鑰也能解密', JSON.stringify(await decrypt(again, box)) === JSON.stringify(FAKE));

const wrongKey = await deriveKey('wrong password', salt);
check('錯誤密碼解密失敗', await throws(() => decrypt(wrongKey, box)));

const otherSaltKey = await deriveKey('correct horse battery', salt2);
check('同密碼不同 salt 解密失敗', await throws(() => decrypt(otherSaltKey, box)));

const box2 = await encrypt(key, FAKE);
check('同內容加密兩次，IV 不同', box.iv !== box2.iv);
check('同內容加密兩次，密文不同', box.ct !== box2.ct);

const tampered = Buffer.from(box.ct, 'base64');
tampered[0] ^= 1;
check('密文被改過一個 bit 時解密失敗', await throws(() => decrypt(key, { ...box, ct: tampered.toString('base64') })));

const swappedIv = { ...box, iv: box2.iv };
check('IV 被換掉時解密失敗', await throws(() => decrypt(key, swappedIv)));

// ---- 格式版本與金鑰推導參數 ----

check('新格式記錄版本', box.v === VAULT_VERSION && VAULT_VERSION === 2, `(v=${box.v})`);
check('新格式記錄推導參數', JSON.stringify(box.kdf) === JSON.stringify({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF.iterations }),
  JSON.stringify(box.kdf));
check('參數被竄改（iterations 改小）時解密失敗',
  await throws(() => decrypt(key, { ...box, kdf: { ...box.kdf, iterations: 300000 } })));
check('參數被竄改（hash 改成 SHA-1）時解密失敗',
  await throws(() => decrypt(key, { ...box, kdf: { ...box.kdf, hash: 'SHA-1' } })));
check('版本被竄改時解密失敗', await throws(() => decrypt(key, { ...box, v: 3 })));
check('拿掉版本與參數（偽裝成舊格式）時解密失敗', await throws(() => decrypt(key, { iv: box.iv, ct: box.ct })));

// ---- lib/store.js：舊格式的讀取與轉換（chrome.storage.local 以記憶體模擬）----

const mem = {};
globalThis.chrome = { storage: { local: {
  async get(keys) { const o = {}; for (const k of [].concat(keys)) if (k in mem) o[k] = structuredClone(mem[k]); return o; },
  async set(o) { Object.assign(mem, structuredClone(o)); },
  async clear() { for (const k in mem) delete mem[k]; },
} } };
const store = await import('../lib/store.js');

const legacyKey = await deriveKey(LEGACY_PASSWORD, Buffer.from(LEGACY.salt, 'base64'));
check('舊格式可直接解密', (await decrypt(legacyKey, LEGACY.vault)).personal.phone === '0900000000');

Object.assign(mem, structuredClone(LEGACY));
check('舊格式：錯誤密碼仍判定為密碼錯誤', await throws(() => store.unlock('wrong fake password')));
check('舊格式：密碼錯誤時不改寫資料', JSON.stringify(mem.vault) === JSON.stringify(LEGACY.vault));
const k1 = await store.unlock(LEGACY_PASSWORD);
check('舊格式可解鎖', toBase64(k1) === toBase64(legacyKey));
check('舊格式解鎖後轉成新格式', mem.vault.v === VAULT_VERSION && mem.vault.kdf.iterations === KDF.iterations);
check('轉換後 salt 不變', mem.salt === LEGACY.salt);
check('轉換後內容不變', (await store.load(k1)).personal.email === 'test@example.invalid');
const converted = JSON.stringify(mem.vault);
await store.unlock(LEGACY_PASSWORD);
check('已是新格式時解鎖不再改寫', JSON.stringify(mem.vault) === converted);

const savedVault = mem.vault;
mem.vault = { ...savedVault, kdf: { ...savedVault.kdf, iterations: 300000 } };
check('儲存的參數被竄改時無法解鎖', await throws(() => store.unlock(LEGACY_PASSWORD)));
mem.vault = { ...savedVault, v: 99 };
check('不支援的版本無法解鎖', await throws(() => store.unlock(LEGACY_PASSWORD)));
mem.vault = savedVault;

const newKey = await store.changePassword(LEGACY_PASSWORD, 'new fake password');
check('修改主密碼後以新格式儲存', mem.vault.v === VAULT_VERSION && mem.vault.kdf.iterations === KDF.iterations);
check('修改主密碼後產生新的 salt', mem.salt !== LEGACY.salt);
check('修改主密碼後內容不變', (await store.load(newKey)).personal.name === '測試人');
check('修改主密碼後舊密碼無法解鎖', await throws(() => store.unlock(LEGACY_PASSWORD)));

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
