/**
 * Test yardimcilari (kendi basina test degil; `node --test test/*.test.mjs` yalniz *.test.mjs dosyalarini kosar):
 * gecici veri klasorunde, sahte cihazla, rastgele portta uygulama kurar ve cerez tasiyan bir istemci verir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { uygulamaKur } from '../src/bootstrap.mjs';
import { yapilandirma as temel } from '../config/app.mjs';

export const CIHAZLAR = [
  { ad: 'Sahte A', tur: 'sahte', ana: '127.0.0.11', kullanici: 'a', parola: 'b', etiket: 'A' },
  { ad: 'Sahte B', tur: 'sahte', ana: '127.0.0.12', kullanici: 'a', parola: 'b', etiket: 'B' },
];

/** ek: { veri (hazir klasor), sunucu, kimlik, cihazlar, live } — verilmezse yeni gecici klasor. */
export async function uygulamaAc(ek = {}) {
  const veri = ek.veri ?? mkdtempSync(join(tmpdir(), 'cam-gvn-'));
  const y = { ...temel, veriKlasoru: veri, sunucu: { ...temel.sunucu, port: 0, adres: '127.0.0.1', ...ek.sunucu },
    cihaz: { ...temel.cihaz, test: true, tohum: JSON.stringify(ek.cihazlar ?? CIHAZLAR) },
    yetki: { ...temel.yetki, ilkAdminParola: 'adminparola1' }, kimlik: { ...temel.kimlik, ...ek.kimlik }, live: { ...temel.live, ...ek.live } };
  const uygulama = await uygulamaKur(y);
  const sunucu = uygulama.dinle();
  await new Promise((r) => sunucu.once('listening', r));
  const B = `http://127.0.0.1:${sunucu.address().port}`;
  const cerezler = new Map();
  const istek = async (yol, { yontem = 'GET', govde, kim = 'admin', bearer, basliklar = {}, cerez } = {}) => {
    const h = { ...basliklar };
    if (govde !== undefined) h['Content-Type'] = 'application/json';
    if (bearer) h.Authorization = `Bearer ${bearer}`; else { h['X-Kamera'] = '1'; const c = cerez ?? (kim && cerezler.get(kim)); if (c) h.Cookie = c; }
    const r = await fetch(B + yol, { method: yontem, headers: h, body: govde === undefined ? undefined : (typeof govde === 'string' ? govde : JSON.stringify(govde)), redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc && kim && !bearer && !cerez) cerezler.set(kim, sc.split(';')[0]);
    const metin = await r.text(); let json = null; try { json = JSON.parse(metin); } catch {}
    return { durum: r.status, json, metin, basliklar: r.headers };
  };
  const giris = async (ad, parola) => { const r = await istek('/api/giris', { yontem: 'POST', govde: { ad, parola }, kim: ad }); assert.equal(r.durum, 200, r.metin); return r; };
  const kapat = async () => { uygulama.kapat(); sunucu.close(); sunucu.closeAllConnections?.(); if (!ek.veri) rmSync(veri, { recursive: true, force: true }); };
  return { uygulama, sunucu, B, veri, istek, giris, cerezler, kapat, hizmetler: uygulama.hizmetler };
}
