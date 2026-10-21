/**
 * Gorunum tercihleri (/api/ben/tercih): canli "Hepsi" sirasi ve sayisi, arka planda durdurma.
 * Uyenin kendi kaydindadir; baskasi goremez, API anahtarinin tercihi yoktur, gecersiz deger sinira cekilir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uygulamaAc } from './helpers.mjs';

let t;
before(async () => { t = await uygulamaAc(); await t.giris('admin', 'adminparola1'); });
after(async () => { await t.kapat(); });

test('varsayilan: 16 kamera, sira bos, arka planda durur', async () => {
  const r = await t.istek('/api/ben/tercih');
  assert.equal(r.durum, 200);
  assert.deepEqual(r.json, { hepsiSayi: 16, hepsiSira: [], arkaPlandaDurdur: true, izgaraAkis: 'alt' });
});

test('yazilan tercih kalici; verilmeyen alan degismez', async () => {
  let r = await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { hepsiSayi: 12, hepsiSira: [3, 1, 2] } });
  assert.equal(r.durum, 200);
  r = await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { arkaPlandaDurdur: false } });
  assert.deepEqual(r.json, { hepsiSayi: 12, hepsiSira: [3, 1, 2], arkaPlandaDurdur: false, izgaraAkis: 'alt' });
  const [kayit] = await t.hizmetler.vt.sorgu('SELECT preferences FROM users WHERE name = ?', ['admin']);
  assert.deepEqual(JSON.parse(kayit.preferences), { hepsiSayi: 12, hepsiSira: [3, 1, 2], arkaPlandaDurdur: false, izgaraAkis: 'alt' });
});

test('gecersiz degerler sinira cekilir, bilinmeyen alan kayda girmez', async () => {
  const r = await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { hepsiSayi: 9999, hepsiSira: [5, 5, -1, 'x', 2.5, 7], rol: 'admin', baska: 1 } });
  assert.equal(r.json.hepsiSayi, 16);   // kayit cihazinin es zamanli akis siniri
  assert.deepEqual(r.json.hepsiSira, [5, 7]);
  assert.deepEqual(Object.keys(r.json).sort(), ['arkaPlandaDurdur', 'hepsiSayi', 'hepsiSira', 'izgaraAkis']);
  // Kare hizi tercihi kaldirildi (canli goruntu MP4, kameranin kendi hizi): gelen alan kayda girmez
  assert.equal((await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { izgaraFps: 20 } })).json.izgaraFps, undefined);
  assert.equal((await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { izgaraAkis: 'ana' } })).json.izgaraAkis, 'ana');
  assert.equal((await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { izgaraAkis: 'baska' } })).json.izgaraAkis, 'alt');   // bilinmeyen: alt akis
  assert.equal((await t.istek('/api/ben/tercih', { yontem: 'PUT', govde: { hepsiSayi: 1 } })).json.hepsiSayi, 4);
});

test('tercih kisiye ozel: baska uye kendi varsayilanini gorur', async () => {
  assert.equal((await t.istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'ayse', parola: 'ayseparola1', rol: 'admin' } })).durum, 200);
  await t.giris('ayse', 'ayseparola1');
  assert.deepEqual((await t.istek('/api/ben/tercih', { kim: 'ayse' })).json, { hepsiSayi: 16, hepsiSira: [], arkaPlandaDurdur: true, izgaraAkis: 'alt' });
});

test('uye listesi tercihi disari vermez', async () => {
  const l = (await t.istek('/api/uyeler')).json;
  assert.ok(Array.isArray(l) && l.length > 0);
  for (const u of l) assert.equal('tercih' in u, false);
});

test('API anahtarinin tercihi yok (403); oturumsuz istek 401', async () => {
  const a = await t.istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'entegrasyon', rol: 'admin' } });
  assert.equal(a.durum, 200, a.metin);
  assert.equal((await t.istek('/api/ben/tercih', { bearer: a.json.anahtar })).durum, 403);
  assert.equal((await t.istek('/api/ben/tercih', { yontem: 'PUT', bearer: a.json.anahtar, govde: { hepsiSayi: 8 } })).durum, 403);
  assert.equal((await t.istek('/api/ben/tercih', { kim: null })).durum, 401);
});
