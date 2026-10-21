/**
 * Test yardimcilari (kendi basina test degil; `node --test test/*.test.mjs` yalniz *.test.mjs dosyalarini kosar):
 * her cagrida YENI bir gecici veritabaninda (kapatinca silinir), gecici veri klasorunde, sahte cihazla, rastgele portta uygulama kurar
 * ve cerez tasiyan bir istemci verir.
 *
 * Test veritabani sunucusu ortamdan gelir (DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD; kullanici veritabani olusturabilmeli).
 * Her test dosyasi kendi veritabanini acar ve kapatir; dosyalar paralel kosabilir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { uygulamaKur } from '../src/bootstrap.mjs';
import { Veritabani } from '../src/core/database.mjs';
import { yapilandirma as temel } from '../config/app.mjs';

export const CIHAZLAR = [
  { ad: 'Sahte A', tur: 'sahte', ana: '127.0.0.11', kullanici: 'a', parola: 'b', etiket: 'A' },
  { ad: 'Sahte B', tur: 'sahte', ana: '127.0.0.12', kullanici: 'a', parola: 'b', etiket: 'B' },
];

const sunucuAyari = () => ({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USERNAME || 'root', password: process.env.DB_PASSWORD ?? '',
});

/** Yeni gecici veritabani olusturur. Dondurur: { ayar (uygulama icin), sil() }. */
export async function gecicivt() {
  const s = sunucuAyari(), ad = `cam_t_${randomBytes(6).toString('hex')}`;
  const c = await mysql.createConnection({ host: s.host, port: s.port, user: s.username, password: s.password });
  await c.query(`CREATE DATABASE \`${ad}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await c.end();
  const sil = async () => { const k = await mysql.createConnection({ host: s.host, port: s.port, user: s.username, password: s.password }); await k.query(`DROP DATABASE IF EXISTS \`${ad}\``); await k.end(); };
  return { ad, ayar: { ...s, database: ad, beklemeSn: 5, havuz: 4 }, sil };
}

/** Modelleri tek basina sinamak icin: baglanmis, gocleri yapilmis Veritabani + sil(). */
export async function vtAc() {
  const g = await gecicivt();
  const vt = await new Veritabani(g.ayar).baglan({ beklemeSn: 5 });
  await vt.gocYap();
  return { vt, ad: g.ad, ayar: g.ayar, sil: async () => { await vt.kapat(); await g.sil(); } };
}

/**
 * ek: { veri (hazir klasor), veritabani ({ ayar } onceki bir kurulumdan: ayni veritabaninda yeniden acis), sunucu, kimlik, cihazlar, live, gizliAnahtar, bekleme }
 * Verilmezse yeni gecici klasor ve yeni gecici veritabani (kapat() ikisini de siler).
 */
export async function uygulamaAc(ek = {}) {
  const veri = ek.veri ?? mkdtempSync(join(tmpdir(), 'cam-gvn-'));
  const g = ek.veritabani ?? await gecicivt();
  const y = { ...temel, veriKlasoru: veri, veritabani: g.ayar, gizliAnahtar: ek.gizliAnahtar ?? '', sunucu: { ...temel.sunucu, port: 0, adres: '127.0.0.1', ...ek.sunucu },
    cihaz: { ...temel.cihaz, test: true, tohum: JSON.stringify(ek.cihazlar ?? CIHAZLAR) },
    yetki: { ...temel.yetki, ilkAdminParola: 'adminparola1' }, kimlik: { ...temel.kimlik, ...ek.kimlik }, live: { ...temel.live, ...ek.live } };
  let uygulama;
  try { uygulama = await uygulamaKur(y); } catch (e) { if (!ek.veritabani) await g.sil(); if (!ek.veri) rmSync(veri, { recursive: true, force: true }); throw e; }
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
  /** kalici: veritabani silinmez (ayni veritabaninda yeniden acmak icin); varsayilan: silinir. */
  const kapat = async ({ kalici = false } = {}) => {
    sunucu.close(); sunucu.closeAllConnections?.(); await uygulama.kapat();
    if (!ek.veri) rmSync(veri, { recursive: true, force: true });
    if (!ek.veritabani && !kalici) await g.sil();
  };
  return { uygulama, sunucu, B, veri, istek, giris, cerezler, kapat, hizmetler: uygulama.hizmetler, veritabani: g };
}
