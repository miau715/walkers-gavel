// lib/crypto.js — 整個專案唯一使用 crypto.subtle 的檔案
// 金鑰：PBKDF2-SHA256（600000 次）→ AES-GCM 256。每次加密都產生新的 12 bytes 隨機 IV。
//
// 加密結果（vault）的格式：
//   第 2 版（現行）：{ v: 2, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations }, iv, ct }
//     v 與 kdf 以 AES-GCM 的 additional data 綁定，被改過就解密失敗
//   第 1 版（舊格式，沒有 v）：{ iv, ct }，視為現行參數（PBKDF2-SHA256 600000 次）

export const KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });
export const PBKDF2_ITERATIONS = KDF.iterations;
export const VAULT_VERSION = 2;
const MIN_ITERATIONS = 100000, MAX_ITERATIONS = 10000000; // 讀到超出範圍的參數視為資料損毀
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// 16 bytes 隨機 salt（首次設定、修改主密碼時使用）
export function newSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// 只接受本工具支援的參數；回傳整理過的副本
function checkKdf(kdf) {
  const ok = kdf && kdf.name === 'PBKDF2' && kdf.hash === 'SHA-256' && Number.isInteger(kdf.iterations) &&
    kdf.iterations >= MIN_ITERATIONS && kdf.iterations <= MAX_ITERATIONS;
  if (!ok) throw new Error('不支援的金鑰推導參數');
  return { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations };
}

// 解開這份 vault 要用的金鑰推導參數（舊格式視為現行參數）
export function kdfOf(box) {
  if (box.v === undefined) return { ...KDF };
  if (box.v !== VAULT_VERSION) throw new Error('不支援的資料格式版本');
  return checkKdf(box.kdf);
}

// 是否已是現行格式與現行參數（不是的話，解鎖後要重新加密存回）
export function isCurrent(box) {
  if (box.v !== VAULT_VERSION) return false;
  const k = checkKdf(box.kdf);
  return k.name === KDF.name && k.hash === KDF.hash && k.iterations === KDF.iterations;
}

// 由主密碼 + salt 推導 AES-GCM 金鑰；回傳 raw bytes（存進 storage.session 用）
export async function deriveKey(password, salt, kdf = KDF) {
  const { name, hash, iterations } = checkKdf(kdf);
  const base = await crypto.subtle.importKey('raw', enc.encode(password), name, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name, hash, salt, iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

function importKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function header(v, kdf) {
  return enc.encode(JSON.stringify([v, kdf.name, kdf.hash, kdf.iterations]));
}

// 以現行格式加密任意可轉成 JSON 的值（rawKey 必須是用現行參數推導的）
export async function encrypt(rawKey, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kdf = { ...KDF };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header(VAULT_VERSION, kdf) },
    await importKey(rawKey), enc.encode(JSON.stringify(value)));
  return { v: VAULT_VERSION, kdf, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

// 解密（現行與舊格式皆可）；金鑰錯誤、密文或參數被改過時，AES-GCM 驗證失敗會丟出錯誤
export async function decrypt(rawKey, box) {
  const params = { name: 'AES-GCM', iv: fromBase64(box.iv) };
  if (box.v !== undefined) params.additionalData = header(VAULT_VERSION, kdfOf(box));
  const pt = await crypto.subtle.decrypt(params, await importKey(rawKey), fromBase64(box.ct));
  return JSON.parse(dec.decode(pt));
}
