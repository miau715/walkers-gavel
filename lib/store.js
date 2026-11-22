// lib/store.js — 加密資料在 chrome.storage.local 的存取層（只由 background.js 使用）
//
// chrome.storage.local 的內容：
//   salt   PBKDF2 salt（base64，明碼）
//   vault  { v: 2, kdf: { name, hash, iterations }, iv, ct }：整份使用者資料加密後的結果（iv、ct 為 base64）
//          舊格式 { iv, ct }（沒有 v）仍可讀取，解鎖成功後自動以現行格式重新加密存回（格式見 lib/crypto.js）
// 這兩項以外不會存任何東西。

import { deriveKey, encrypt, decrypt, newSalt, toBase64, fromBase64, kdfOf, isCurrent, KDF } from './crypto.js';

export const PERSONAL_FIELDS = ['name', 'idNumber', 'email', 'phone', 'address'];

export class WrongPasswordError extends Error {}
// 加密資料的格式版本或金鑰推導參數不支援（被改過或損毀）
export class BadVaultError extends Error {}

export function emptyData() {
  return {
    personal: Object.fromEntries(PERSONAL_FIELDS.map(f => [f, ''])),
    combos: [],
    places: [],
  };
}

// 解密後補齊缺少的欄位，避免舊格式或缺欄位造成錯誤
function normalize(data) {
  const base = emptyData();
  const p = (data && data.personal) || {};
  for (const f of PERSONAL_FIELDS) base.personal[f] = typeof p[f] === 'string' ? p[f] : '';
  if (Array.isArray(data && data.combos)) base.combos = data.combos;
  if (Array.isArray(data && data.places)) base.places = data.places;
  return base;
}

export async function isSetUp() {
  const { vault } = await chrome.storage.local.get('vault');
  return !!vault;
}

// 首次設定：產生 salt、加密空白資料。回傳金鑰 raw bytes。
export async function setup(password) {
  if (await isSetUp()) throw new Error('已經設定過主密碼');
  const salt = newSalt();
  const key = await deriveKey(password, salt);
  const vault = await encrypt(key, emptyData());
  await chrome.storage.local.set({ salt: toBase64(salt), vault });
  return key;
}

// 用主密碼推導金鑰並試著解密；解密失敗即密碼錯誤。回傳金鑰 raw bytes（一律是現行參數推導的）。
// 舊格式或舊參數 → 解密成功後以現行格式、現行參數重新加密存回。
export async function unlock(password) {
  const { salt, vault } = await chrome.storage.local.get(['salt', 'vault']);
  if (!salt || !vault) throw new Error('尚未設定主密碼');
  let kdf;
  try {
    kdf = kdfOf(vault);
  } catch {
    throw new BadVaultError('加密資料格式不支援或已損毀');
  }
  const key = await deriveKey(password, fromBase64(salt), kdf);
  let data;
  try {
    data = await decrypt(key, vault);
  } catch {
    throw new WrongPasswordError('密碼錯誤');
  }
  if (isCurrent(vault)) return key;
  const same = kdf.name === KDF.name && kdf.hash === KDF.hash && kdf.iterations === KDF.iterations;
  const newKey = same ? key : await deriveKey(password, fromBase64(salt));
  await chrome.storage.local.set({ vault: await encrypt(newKey, data) });
  return newKey;
}

export async function load(key) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('尚未設定主密碼');
  return normalize(await decrypt(key, vault));
}

export async function save(key, data) {
  await chrome.storage.local.set({ vault: await encrypt(key, normalize(data)) });
}

// 修改主密碼：舊密碼解密 → 產生新 salt → 新密碼重新加密，salt 與 vault 一次寫入。回傳新金鑰。
export async function changePassword(oldPassword, newPassword) {
  const oldKey = await unlock(oldPassword);
  const data = await load(oldKey);
  const salt = newSalt();
  const newKey = await deriveKey(newPassword, salt);
  const vault = await encrypt(newKey, data);
  await chrome.storage.local.set({ salt: toBase64(salt), vault });
  return newKey;
}

export async function clearAll() {
  await chrome.storage.local.clear();
}
