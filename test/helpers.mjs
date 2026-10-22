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
import { createApp } from '../src/bootstrap.mjs';
import { Database } from '../src/core/database.mjs';
import { config as base } from '../config/app.mjs';

export const DEVICES = [
  { name: 'Sahte A', type: 'mock', host: '127.0.0.11', username: 'a', password: 'b', label: 'A' },
  { name: 'Sahte B', type: 'mock', host: '127.0.0.12', username: 'a', password: 'b', label: 'B' },
];

const serverSetting = () => ({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USERNAME || 'root', password: process.env.DB_PASSWORD ?? '',
});

/** Yeni gecici veritabani olusturur. Dondurur: { ayar (uygulama icin), sil() }. */
export async function tempDb() {
  const s = serverSetting(), name = `cam_t_${randomBytes(6).toString('hex')}`;
  const c = await mysql.createConnection({ host: s.host, port: s.port, user: s.username, password: s.password });
  await c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await c.end();
  const remove = async () => { const k = await mysql.createConnection({ host: s.host, port: s.port, user: s.username, password: s.password }); await k.query(`DROP DATABASE IF EXISTS \`${name}\``); await k.end(); };
  return { name, setting: { ...s, database: name, waitingSec: 5, pool: 4 }, remove };
}

/** Modelleri tek basina sinamak icin: baglanmis, gocleri yapilmis Veritabani + sil(). */
export async function openDb() {
  const g = await tempDb();
  const db = await new Database(g.setting).connect({ waitingSec: 5 });
  await db.runMigrations();
  return { db, name: g.name, setting: g.setting, remove: async () => { await db.close(); await g.remove(); } };
}

/**
 * ek: { veri (hazir klasor), veritabani ({ ayar } onceki bir kurulumdan: ayni veritabaninda yeniden acis), sunucu, kimlik, cihazlar, live, secretKey, bekleme }
 * Verilmezse yeni gecici klasor ve yeni gecici veritabani (kapat() ikisini de siler).
 */
export async function openApp(extra = {}) {
  const data = extra.data ?? mkdtempSync(join(tmpdir(), 'cam-gvn-'));
  const g = extra.database ?? await tempDb();
  const y = { ...base, dataDir: data, database: g.setting, secretKey: extra.secretKey ?? '', server: { ...base.server, port: 0, address: '127.0.0.1', ...extra.server },
    device: { ...base.device, test: true, seed: JSON.stringify(extra.devices ?? DEVICES) },
    permissions: { ...base.permissions, initialAdminPassword: 'adminparola1' }, identity: { ...base.identity, ...extra.identity }, live: { ...base.live, ...extra.live } };
  let app;
  try { app = await createApp(y); } catch (e) { if (!extra.database) await g.remove(); if (!extra.data) rmSync(data, { recursive: true, force: true }); throw e; }
  const server = app.listen();
  await new Promise((r) => server.once('listening', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  const req = async (path, { method = 'GET', body, who = 'admin', bearer, headers = {}, cookie } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (bearer) h.Authorization = `Bearer ${bearer}`; else { h['X-Cam'] = '1'; const c = cookie ?? (who && cookies.get(who)); if (c) h.Cookie = c; }
    const r = await fetch(B + path, { method: method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc && who && !bearer && !cookie) cookies.set(who, sc.split(';')[0]);
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const login = async (name, password) => { const r = await req('/api/login', { method: 'POST', body: { name, password }, who: name }); assert.equal(r.status, 200, r.text); return r; };
  /** kalici: veritabani silinmez (ayni veritabaninda yeniden acmak icin); varsayilan: silinir. */
  const close = async ({ permanent = false } = {}) => {
    server.close(); server.closeAllConnections?.(); await app.close();
    if (!extra.data) rmSync(data, { recursive: true, force: true });
    if (!extra.database && !permanent) await g.remove();
  };
  return { app, server, B, data, req, login, cookies, close, services: app.services, database: g };
}
