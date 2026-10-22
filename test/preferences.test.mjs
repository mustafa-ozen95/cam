/**
 * Gorunum tercihleri (/api/ben/tercih): canli "Hepsi" sirasi ve sayisi, arka planda durdurma.
 * Uyenin kendi kaydindadir; baskasi goremez, API anahtarinin tercihi yoktur, gecersiz deger sinira cekilir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp } from './helpers.mjs';

let t;
before(async () => { t = await openApp(); await t.login('admin', 'adminparola1'); });
after(async () => { await t.close(); });

test('varsayilan: 16 kamera, sira bos, arka planda durur', async () => {
  const r = await t.req('/api/me/preferences');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { allCount: 16, allOrder: [], pauseInBackground: true, gridStream: 'sub' });
});

test('yazilan tercih kalici; verilmeyen alan degismez', async () => {
  let r = await t.req('/api/me/preferences', { method: 'PUT', body: { allCount: 12, allOrder: [3, 1, 2] } });
  assert.equal(r.status, 200);
  r = await t.req('/api/me/preferences', { method: 'PUT', body: { pauseInBackground: false } });
  assert.deepEqual(r.json, { allCount: 12, allOrder: [3, 1, 2], pauseInBackground: false, gridStream: 'sub' });
  const [record] = await t.services.db.query('SELECT preferences FROM users WHERE name = ?', ['admin']);
  assert.deepEqual(JSON.parse(record.preferences), { allCount: 12, allOrder: [3, 1, 2], pauseInBackground: false, gridStream: 'sub' });
});

test('gecersiz degerler sinira cekilir, bilinmeyen alan kayda girmez', async () => {
  const r = await t.req('/api/me/preferences', { method: 'PUT', body: { allCount: 9999, allOrder: [5, 5, -1, 'x', 2.5, 7], role: 'admin', other: 1 } });
  assert.equal(r.json.allCount, 16);   // kayit cihazinin es zamanli akis siniri
  assert.deepEqual(r.json.allOrder, [5, 7]);
  assert.deepEqual(Object.keys(r.json).sort(), ['allCount', 'allOrder', 'gridStream', 'pauseInBackground']);
  // Kare hizi tercihi kaldirildi (canli goruntu MP4, kameranin kendi hizi): gelen alan kayda girmez
  assert.equal((await t.req('/api/me/preferences', { method: 'PUT', body: { gridFps: 20 } })).json.gridFps, undefined);
  assert.equal((await t.req('/api/me/preferences', { method: 'PUT', body: { gridStream: 'main' } })).json.gridStream, 'main');
  assert.equal((await t.req('/api/me/preferences', { method: 'PUT', body: { gridStream: 'baska' } })).json.gridStream, 'sub');   // bilinmeyen: alt akis
  assert.equal((await t.req('/api/me/preferences', { method: 'PUT', body: { allCount: 1 } })).json.allCount, 4);
});

test('tercih kisiye ozel: baska uye kendi varsayilanini gorur', async () => {
  assert.equal((await t.req('/api/members', { method: 'POST', body: { name: 'ayse', password: 'ayseparola1', role: 'admin' } })).status, 200);
  await t.login('ayse', 'ayseparola1');
  assert.deepEqual((await t.req('/api/me/preferences', { who: 'ayse' })).json, { allCount: 16, allOrder: [], pauseInBackground: true, gridStream: 'sub' });
});

test('uye listesi tercihi disari vermez', async () => {
  const l = (await t.req('/api/members')).json;
  assert.ok(Array.isArray(l) && l.length > 0);
  for (const u of l) assert.equal('preferences' in u, false);
});

test('API anahtarinin tercihi yok (403); oturumsuz istek 401', async () => {
  const a = await t.req('/api/access/keys', { method: 'POST', body: { name: 'entegrasyon', role: 'admin' } });
  assert.equal(a.status, 200, a.text);
  assert.equal((await t.req('/api/me/preferences', { bearer: a.json.key })).status, 403);
  assert.equal((await t.req('/api/me/preferences', { method: 'PUT', bearer: a.json.key, body: { allCount: 8 } })).status, 403);
  assert.equal((await t.req('/api/me/preferences', { who: null })).status, 401);
});
