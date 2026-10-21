/**
 * Veritabani katmani: goclerin tekrar kosmasi, gizli anahtar kurallari, bir kerelik JSON aktarimi (basari, tekrar, dolu tablo, bozuk dosya,
 * bozuk zincir), yazma hatasinda bellegin degismemesi, saglik yoklamasi, yeniden aciliste kalicilik, gunluk sirasi.
 * Gercek MariaDB gerekir (test/helpers.mjs: DB_HOST, DB_USERNAME, DB_PASSWORD).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CihazDeposu } from '../src/models/cihaz.mjs';
import { Veritabani } from '../src/core/database.mjs';
import { gizliAnahtarCoz } from '../src/core/secret-key.mjs';
import { MIGRATIONS } from '../src/database/migrations.mjs';
import { gecicivt, uygulamaAc, vtAc } from './helpers.mjs';

const yeniKlasor = () => mkdtempSync(join(tmpdir(), 'cam-db-'));
const sil = (k) => rmSync(k, { recursive: true, force: true });
const yaz = (k, ad, o) => writeFileSync(join(k, ad), typeof o === 'string' ? o : JSON.stringify(o, null, 2));

/** Gecerli imza zincirli bir gunluk.jsonl metni. */
function zincir(gizli, n = 3) {
  let onceki = '', satirlar = [];
  for (let i = 0; i < n; i++) {
    const k = { z: `2026-10-0${i + 1}T08:00:00.000Z`, yerel: `2026-10-0${i + 1} 11:00:00 Europe/Istanbul`, olay: i ? 'cikis' : 'giris', kullanici: 'admin', ip: '192.0.2.1', port: 1, ua: 'x', onceki };
    k.imza = createHmac('sha256', gizli).update(onceki + JSON.stringify(k)).digest('hex');
    onceki = k.imza; satirlar.push(JSON.stringify(k));
  }
  return satirlar.join('\n') + '\n';
}

/** Eski bicimde tam bir veri klasoru kurar (gizli.anahtar dahil). */
function eskiKlasor(gizli) {
  const k = yeniKlasor();
  writeFileSync(join(k, 'gizli.anahtar'), gizli);
  const tuz = randomBytes(16);
  yaz(k, 'kullanicilar.json', [{ ad: 'admin', rol: 'admin', tuz: tuz.toString('hex'), karma: scryptSync('eskiparola1', tuz, 32).toString('hex'), olusturma: '2026-10-01T08:00:00.000Z', oturumSurum: 0, kapsam: null, bitis: null, ipler: [] }]);
  const depo = new CihazDeposu(null, gizli);
  yaz(k, 'cihazlar.json', { surum: 1, ustSinir: 8, cihazlar: [{ id: 'aaaa1111', ad: 'Eski A', tur: 'sahte', ana: '127.0.0.31', kullanici: 'a', parola: depo.sifrele('b'), etiket: 'A', kanalSayisi: 4, baslangic: 0, olusturma: '2026-10-01T08:00:00.000Z' }] });
  yaz(k, 'yetki.json', { surum: 1, roller: { izleyici: { ad: 'İzleyici', aciklama: '', izinler: ['canli.izle'], olusturan: 'admin', olusturma: '2026-10-02T08:00:00.000Z' } }, yerlesikIzinler: {}, anahtarlar: [] });
  yaz(k, 'kanallar.json', { 0: { ad: 'Kapı', gorunum: 'otomatik' } });
  yaz(k, 'live-duzen.json', { sutun: 3, yollar: ['k0'], kaydeden: 'admin', zaman: '2026-10-03T08:00:00.000Z' });
  yaz(k, 'guncelleme.json', { durum: 'guncel', calisan: 'a'.repeat(40) });
  yaz(k, 'merkez-baglari.json', { '5a0d0000-0000-7000-8000-000000000001': { ad: 'admin', eposta: 'admin@ornek.test', rol: 'admin', girebilir: true, kontrol: null, sonGiris: null } });
  yaz(k, 'gunluk.jsonl', zincir(gizli));
  return k;
}
const ESKI = ['kullanicilar.json', 'yetki.json', 'cihazlar.json', 'kanallar.json', 'gunluk.jsonl', 'merkez-baglari.json', 'guncelleme.json', 'live-duzen.json'];
const say = async (t, tablo) => Number((await t.hizmetler.vt.sorgu(`SELECT COUNT(*) AS n FROM ${tablo}`))[0].n);

test('goc: sema kurulur, tekrar kosunca bir sey yapmaz, surum tablosu dolu', async () => {
  const v = await vtAc();
  try {
    assert.deepEqual(await v.vt.gocYap(), [], 'vtAc zaten kosturdu; ikinci kosu bos olmali');
    const satirlar = await v.vt.sorgu('SELECT version FROM migrations ORDER BY version');
    assert.deepEqual(satirlar.map((s) => s.version), MIGRATIONS.map((m) => m.version));
    const tablolar = (await v.vt.sorgu('SHOW TABLES')).map((r) => Object.values(r)[0]).sort();
    assert.deepEqual(tablolar, ['api_keys', 'audit_log', 'builtin_role_permissions', 'devices', 'hub_links', 'migrations', 'roles', 'settings', 'users']);
  } finally { await v.sil(); }
});

test('gecici ariza: ulasilamayan veritabani sure dolunca anlasilir hatayla biter', async () => {
  const vt = new Veritabani({ host: '127.0.0.1', port: 1, database: 'x', username: 'x', password: '', beklemeSn: 1 });
  await assert.rejects(() => vt.baglan({ beklemeSn: 1, aralikMs: 200 }), /Veritabanına bağlanılamadı/);
});

test('gizli anahtar: ortamdan, dosyadan; farkliysa ya da bozuksa acilis durur', () => {
  const k = yeniKlasor(), dosya = join(k, 'gizli.anahtar');
  try {
    const a = gizliAnahtarCoz({ ortam: '', dosya });
    assert.equal(a.length, 32); assert.ok(existsSync(dosya));
    assert.deepEqual(gizliAnahtarCoz({ ortam: '', dosya }), a, 'dosya varsa ayni anahtar');
    assert.deepEqual(gizliAnahtarCoz({ ortam: a.toString('base64'), dosya }), a, 'ortam dosyayla ayniysa tamam');
    assert.throws(() => gizliAnahtarCoz({ ortam: randomBytes(32).toString('base64'), dosya }), /farklı/);
    assert.throws(() => gizliAnahtarCoz({ ortam: 'kisa', dosya }), /geçersiz/);
    assert.throws(() => gizliAnahtarCoz({ ortam: randomBytes(16).toString('base64'), dosya }), /geçersiz/);
    const yeniDosya = join(k, 'baska.anahtar'), e = randomBytes(32);
    assert.deepEqual(gizliAnahtarCoz({ ortam: e.toString('base64'), dosya: yeniDosya }), e);
    assert.ok(!existsSync(yeniDosya), 'ortamdan gelen anahtar dosyaya yazilmaz');
  } finally { sil(k); }
});

test('gizli anahtar: veritabanini dolduran anahtardan farkliysa acilis durur (anahtar veritabanina girmez)', async () => {
  const g = await gecicivt(), k = yeniKlasor();
  try {
    const anahtar = randomBytes(32).toString('base64');
    const t = await uygulamaAc({ veri: k, veritabani: g, gizliAnahtar: anahtar });
    const depolanan = JSON.stringify(await t.hizmetler.vt.sorgu('SELECT * FROM settings'));
    assert.ok(!depolanan.includes(anahtar), 'anahtarin kendisi veritabaninda yok');
    assert.ok(!existsSync(join(k, 'gizli.anahtar')), 'ortamdan gelen anahtar dosyaya yazilmaz');
    await t.kapat();
    await assert.rejects(() => uygulamaAc({ veri: yeniKlasor(), veritabani: g, gizliAnahtar: randomBytes(32).toString('base64') }), /Gizli anahtar bu veritabanını/);
    const t2 = await uygulamaAc({ veri: k, veritabani: g, gizliAnahtar: anahtar });   // dogru anahtarla yeniden acilir
    await t2.kapat();
  } finally { sil(k); await g.sil(); }
});

test('aktarim: eski dosyalar tek islemde tablolara gecer, sayilar ve zincir tutar, dosyalar .aktarildi olur, tekrar acilista bir sey yapmaz', async () => {
  const gizli = randomBytes(32), k = eskiKlasor(gizli), g = await gecicivt();
  try {
    const t = await uygulamaAc({ veri: k, veritabani: g });
    assert.equal(await say(t, 'users'), 1); assert.equal(await say(t, 'devices'), 1); assert.equal(await say(t, 'roles'), 1);
    assert.equal(await say(t, 'audit_log'), 3); assert.equal(await say(t, 'hub_links'), 1);
    const ayar = (await t.hizmetler.vt.sorgu('SELECT name FROM settings ORDER BY name')).map((r) => r.name);
    assert.ok(['channels', 'device-block-limit', 'live-layout', 'update-status'].every((a) => ayar.includes(a)), ayar.join());
    assert.equal(JSON.parse((await t.hizmetler.vt.sorgu("SELECT value FROM settings WHERE name = 'device-block-limit'"))[0].value), 8);
    for (const d of ESKI) { assert.ok(!existsSync(join(k, d)), `${d} yeniden adlandirilmali`); assert.ok(existsSync(join(k, `${d}.aktarildi`)), `${d}.aktarildi var olmali`); }
    // giris eski parolayla, gunluk zinciri veritabanindan dogrulanir, cihaz parolasi eski anahtarla cozulur
    await t.giris('admin', 'eskiparola1');
    const z = await t.istek('/api/gunluk/dogrula');
    assert.equal(z.json.tamam, true); assert.ok(z.json.kayit >= 3);
    assert.equal(t.hizmetler.cihazlar.depo.ayar('aaaa1111').parola, 'b');
    assert.equal((await t.istek('/live/duzen.json', { kim: null })).durum, 404, 'live kapali ama duzen kaydi hizmette');
    assert.deepEqual(t.hizmetler.live.duzen().yollar, ['k0']);
    assert.equal(t.hizmetler.cihazlar.kanalAyar[0].ad, 'Kapı');
    const sayilar = { u: await say(t, 'users'), d: await say(t, 'devices') };
    await t.kapat();
    // tekrar acilista aktarim bir sey yapmaz (dosyalar gitti, tablolar dolu)
    const t2 = await uygulamaAc({ veri: k, veritabani: g, gizliAnahtar: '' });
    assert.equal(await say(t2, 'users'), sayilar.u); assert.equal(await say(t2, 'devices'), sayilar.d);
    await t2.kapat();
  } finally { sil(k); await g.sil(); }
});

test('aktarim: tablolar doluysa ve eski dosyalar varsa dokunulmaz (dosyalar yerinde kalir)', async () => {
  const g = await gecicivt(), k = yeniKlasor();
  try {
    const t = await uygulamaAc({ veri: k, veritabani: g });          // bos veritabani: admin olusur
    const gizli = readFileSync(join(k, 'gizli.anahtar'));
    await t.kapat();
    yaz(k, 'kullanicilar.json', [{ ad: 'hayalet', rol: 'admin', tuz: '00', karma: '00', olusturma: '2026-10-01T08:00:00.000Z' }]);
    const t2 = await uygulamaAc({ veri: k, veritabani: g });
    assert.equal((await t2.hizmetler.vt.sorgu("SELECT name FROM users WHERE name = 'hayalet'")).length, 0);
    assert.ok(existsSync(join(k, 'kullanicilar.json')), 'dosya yerinde');
    assert.deepEqual(readFileSync(join(k, 'gizli.anahtar')), gizli);
    await t2.kapat();
  } finally { sil(k); await g.sil(); }
});

test('aktarim: bozuk dosya ya da bozuk zincirde acilis durur, hicbir sey yazilmaz, dosyalar yerinde kalir', async () => {
  for (const bozma of [(k) => yaz(k, 'cihazlar.json', '{bozuk'), (k) => yaz(k, 'gunluk.jsonl', zincir(readFileSync(join(k, 'gizli.anahtar'))).replace('"giris"', '"giriss"'))]) {
    const gizli = randomBytes(32), k = eskiKlasor(gizli), g = await gecicivt();
    try {
      bozma(k);
      await assert.rejects(() => uygulamaAc({ veri: k, veritabani: g }));
      const vt = await new Veritabani(g.ayar).baglan({ beklemeSn: 5 });
      for (const tablo of ['users', 'devices', 'roles', 'audit_log', 'hub_links']) assert.equal(Number((await vt.sorgu(`SELECT COUNT(*) AS n FROM ${tablo}`))[0].n), 0, `${tablo} bos kalmali`);
      await vt.kapat();
      for (const d of ESKI) assert.ok(existsSync(join(k, d)), `${d} yerinde olmali`);
    } finally { sil(k); await g.sil(); }
  }
});

test('aktarim: sayilar tutmazsa (ayni anahtarli iki kayit) islem geri alinir', async () => {
  const gizli = randomBytes(32), k = eskiKlasor(gizli), g = await gecicivt();
  try {
    const u = JSON.parse(readFileSync(join(k, 'kullanicilar.json'), 'utf8'));
    yaz(k, 'kullanicilar.json', [...u, { ...u[0], ad: 'ADMIN' }]);       // buyuk/kucuk harf ayni ad: tabloda benzersiz degil
    await assert.rejects(() => uygulamaAc({ veri: k, veritabani: g }));
    const vt = await new Veritabani(g.ayar).baglan({ beklemeSn: 5 });
    assert.equal(Number((await vt.sorgu('SELECT COUNT(*) AS n FROM users'))[0].n), 0);
    assert.equal(Number((await vt.sorgu('SELECT COUNT(*) AS n FROM audit_log'))[0].n), 0, 'zincir de geri alindi');
    await vt.kapat();
    assert.ok(existsSync(join(k, 'gunluk.jsonl')));
  } finally { sil(k); await g.sil(); }
});

test('veritabani yazma hatasi: kullaniciya 500, bellek degismez, basarisiz isten sonra sistem calisir', async () => {
  const t = await uygulamaAc();
  try {
    await t.giris('admin', 'adminparola1');
    const vt = t.hizmetler.vt, gercek = vt.islem.bind(vt);
    vt.islem = async () => { throw Object.assign(new Error('baglanti koptu'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    const hata = console.error; console.error = () => {};
    try {
      const r = await t.istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'yeni1', parola: 'yeniparola1', rol: 'admin' } });
      assert.equal(r.durum, 500); assert.equal(r.json.kod, 'VERITABANI');
      assert.ok(!r.metin.includes('baglanti koptu'), 'ic ayrinti disari verilmez');
      assert.equal(t.hizmetler.uyeler.bul('yeni1'), null, 'bellek degismedi');
      const c = await t.istek('/api/cihazlar', { yontem: 'POST', govde: { ad: 'X', tur: 'sahte', ana: '127.0.0.77', kullanici: 'u', parola: 'p1234567', etiket: 'N' } });
      assert.equal(c.durum, 500);
      assert.equal(t.hizmetler.cihazlar.liste().length, 2, 'cihaz listesi degismedi');
      const rol = await t.istek('/api/yetki/roller', { yontem: 'POST', govde: { id: 'deneme', ad: 'd', izinler: ['canli.izle'] } });
      assert.equal(rol.durum, 500); assert.equal(t.hizmetler.yetki.rolVar('deneme'), false);
    } finally { console.error = hata; vt.islem = gercek; }
    const r2 = await t.istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'yeni1', parola: 'yeniparola1', rol: 'admin' } });
    assert.equal(r2.durum, 200, r2.metin);
    assert.ok(t.hizmetler.uyeler.bul('yeni1'));
    assert.equal((await t.hizmetler.vt.sorgu("SELECT name FROM users WHERE name = 'yeni1'")).length, 1, 'veritabanina da yazildi');
  } finally { await t.kapat(); }
});

test('saglik yoklamasi: veritabanina ulasilamiyorsa 503', async () => {
  const t = await uygulamaAc();
  try {
    assert.equal((await t.istek('/api/v1/saglik', { kim: null })).durum, 200);
    const vt = t.hizmetler.vt, gercek = vt.saglikli.bind(vt);
    vt.saglikli = async () => false;
    try { assert.equal((await t.istek('/api/v1/saglik', { kim: null })).durum, 503); } finally { vt.saglikli = gercek; }
  } finally { await t.kapat(); }
});

test('kalicilik: kapatip ayni veritabaniyla acinca uye, cihaz, rol ve anahtar yerinde; ilk admin yeniden olusmaz', async () => {
  const g = await gecicivt(), k = yeniKlasor();
  try {
    const t = await uygulamaAc({ veri: k, veritabani: g });
    await t.giris('admin', 'adminparola1');
    assert.equal((await t.istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'kalici1', parola: 'kaliciparola1', rol: 'admin' } })).durum, 200);
    assert.equal((await t.istek('/api/yetki/roller', { yontem: 'POST', govde: { id: 'rol1', ad: 'R', izinler: ['canli.izle'] } })).durum, 200);
    const ak = await t.istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'k1', rol: 'rol1' } });
    assert.equal(ak.durum, 200, ak.metin);
    assert.equal((await t.istek('/api/cihazlar', { yontem: 'POST', govde: { ad: 'Yeni', tur: 'sahte', ana: '127.0.0.78', kullanici: 'u', parola: 'p1234567', etiket: 'N' } })).durum, 200);
    await t.kapat();
    const t2 = await uygulamaAc({ veri: k, veritabani: g });
    assert.equal((await t2.hizmetler.vt.sorgu('SELECT name FROM users')).length, 2);
    await t2.giris('kalici1', 'kaliciparola1');
    assert.ok(t2.hizmetler.yetki.rolVar('rol1'));
    assert.equal((await t2.istek('/api/v1/ben', { bearer: ak.json.anahtar })).durum, 200, 'API anahtari yeniden acilista gecerli');
    assert.equal(t2.hizmetler.cihazlar.liste().length, 3);
    await t2.kapat();
  } finally { sil(k); await g.sil(); }
});

test('gunluk: es zamanli yazimlar sirayla eklenir, zincir bozulmaz', async () => {
  const t = await uygulamaAc();
  try {
    await t.giris('admin', 'adminparola1');
    await Promise.all(Array.from({ length: 40 }, (_, i) => t.hizmetler.gunluk.yaz('deneme', 'sistem', null, { i })));
    const d = await t.istek('/api/gunluk/dogrula');
    assert.equal(d.json.tamam, true); assert.ok(d.json.kayit >= 41);
    const l = await t.istek('/api/gunluk?olay=deneme&boyut=200');
    assert.equal(l.json.toplam, 40);
    assert.deepEqual(l.json.kayitlar.map((x) => x.i), Array.from({ length: 40 }, (_, i) => 39 - i), 'en yeni ustte, ekleme sirasi korunur');
    // LIKE ozel karakterleri suzgecte duz metin sayilir
    assert.equal((await t.istek('/api/gunluk?kullanici=%25')).json.toplam, 0);
  } finally { await t.kapat(); }
});
