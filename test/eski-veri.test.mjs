/**
 * Goc testi: JSON donemindeki veri/*.json dosyalarinin ESKI bicimleri (guvenlik duzeltmelerinden onceki) acilista veritabanina aktarilir ve calismaya devam eder.
 * Eski bicimde YOK olan alanlar: uye.oturumSurum, merkez-baglari uyeKimlik, cihazlar.ustSinir, anahtar sahibi dogrulamasi.
 * Tek kasitli kesinti: eski oturum cerezleri (etiketsiz imza) bir kez gecersiz olur; kullanici yeniden giris yapar.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CihazDeposu } from '../src/models/cihaz.mjs';
import { uygulamaAc } from './helpers.mjs';

const SUB_ADMIN = '5a0d0000-0000-7000-8000-000000000001', SUB_KAPALI = '5a0d0000-0000-7000-8000-000000000002', SUB_OLU = '5a0d0000-0000-7000-8000-000000000003';
let dizin, t, gizli, ESKI;
const yaz = (ad, o) => writeFileSync(join(dizin, ad), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const sorgu = (sql, p) => t.hizmetler.vt.sorgu(sql, p);
const uye = (ad, rol, ek = {}) => { const tuz = randomBytes(16); return { ad, rol, tuz: tuz.toString('hex'), karma: scryptSync('eskiparola1', tuz, 32).toString('hex'), kapsam: null, bitis: null, ipler: [], ...ek }; };

before(async () => {
  dizin = mkdtempSync(join(tmpdir(), 'cam-eski-'));
  gizli = randomBytes(32); writeFileSync(join(dizin, 'gizli.anahtar'), gizli);
  // kullanicilar.json: ESKI bicim (oturumSurum yok); 'eskiuye' olusturma damgasi da yok (cok eski kayit)
  yaz('kullanicilar.json', [uye('admin', 'admin', { olusturma: '2026-10-01T08:00:00.000Z' }), uye('kapali', 'admin', { olusturma: '2026-10-02T08:00:00.000Z' }), uye('eskiuye', 'admin')]);
  // merkez-baglari.json: ESKI bicim (uyeKimlik yok); biri kapali, biri silinmis uyeye ait
  const bag = (ad, girebilir) => ({ ad, eposta: `${ad}@ornek.test`, rol: 'admin', girebilir, kontrol: '2026-10-12T10:00:00.000Z', sonGiris: '2026-10-12T10:00:00.000Z' });
  yaz('merkez-baglari.json', { [SUB_ADMIN]: bag('admin', true), [SUB_KAPALI]: bag('kapali', false), [SUB_OLU]: bag('silinmis', true) });
  // cihazlar.json: ESKI bicim (ustSinir yok); parolalar bu kurulumun gizli anahtariyla sifreli
  const depo = new CihazDeposu(null, gizli);
  const cihaz = (id, ad, ana, baslangic) => ({ id, ad, tur: 'sahte', ana, kullanici: 'a', parola: depo.sifrele('b'), etiket: id.slice(0, 1).toUpperCase(), kanalSayisi: 4, baslangic, olusturma: '2026-10-01T08:00:00.000Z' });
  yaz('cihazlar.json', { surum: 1, cihazlar: [cihaz('aaaa1111', 'Eski A', '127.0.0.31', 0), cihaz('bbbb2222', 'Eski B', '127.0.0.32', 4)] });
  // yetki.json: ESKI bicim; sahibi uye olan anahtar ve sahibi uye olmayan entegrasyon anahtari
  const anahtarKaydi = (id, ad, gizliMetin, sahip) => ({ id, ad, onek: `kp_${id}_xxxx…`, karma: createHmac('sha256', createHmac('sha256', gizli).update('kamera2/api-anahtar').digest()).update(gizliMetin).digest('hex'),
    rol: null, izinler: ['canli.izle'], kapsam: null, bitis: null, ipler: [], hizLimiti: 120, eszamanliAkis: 4, sahip, olusturan: 'admin', olusturma: '2026-10-05T08:00:00.000Z', sonKullanim: null, sayac: 0, iptal: null, notlar: '' });
  ESKI = { uyeAnahtari: `kp_aaaaaaaa_${'A'.repeat(43)}`, etiketAnahtari: `kp_bbbbbbbb_${'B'.repeat(43)}` };
  yaz('yetki.json', { surum: 1, roller: {}, yerlesikIzinler: {}, anahtarlar: [anahtarKaydi('aaaaaaaa', 'uye-anahtari', 'A'.repeat(43), 'admin'), anahtarKaydi('bbbbbbbb', 'entegrasyon', 'B'.repeat(43), 'muhasebe-entegrasyonu')] });
  t = await uygulamaAc({ veri: dizin });
});
after(async () => { await t.kapat(); rmSync(dizin, { recursive: true, force: true }); });

test('eski kullanicilar.json: parola girisi calisir, oturum surumu tembel eklenir, damgasiz kayit damga alir', async () => {
  const r = await t.giris('admin', 'eskiparola1');
  assert.equal(r.json.rol, 'admin');
  assert.equal((await t.istek('/api/ben')).json.ad, 'admin');
  const k = await sorgu('SELECT name, created_at FROM users');
  assert.equal(k.length, 3);
  assert.ok(k.every((u) => u.created_at), 'damgasiz kayda damga verilip yazilmis olmali');
  assert.equal(k.find((u) => u.name === 'admin').created_at, '2026-10-01T08:00:00.000Z', 'var olan damga degismez');
  await t.giris('eskiuye', 'eskiparola1');
  // cikis: surum undefined -> 1 olur, eski cerez gecersiz
  const c = t.cerezler.get('eskiuye');
  assert.equal((await t.istek('/api/cikis', { yontem: 'POST', cerez: c })).durum, 200);
  assert.equal((await t.istek('/api/ben', { cerez: c })).durum, 401);
});

test('eski oturum cerezi (etiketsiz imza) bir kez gecersiz olur; yeniden giris calisir', async () => {
  const yuk = Buffer.from(JSON.stringify({ a: 'admin', e: Date.now() + 1e9 })).toString('base64url');
  const eskiCerez = `kamera_oturum=${yuk}.${createHmac('sha256', gizli).update(yuk).digest('base64url')}`;
  assert.equal((await t.istek('/api/ben', { cerez: eskiCerez })).durum, 401);
  assert.equal((await t.giris('admin', 'eskiparola1')).durum, 200);
});

test('eski merkez-baglari.json: bag mevcut uyenin damgasini alir, calismaya devam eder; uyesiz bag atilir', async () => {
  const uyeler = t.hizmetler.uyeler, baglar = t.hizmetler.baglar;
  const dosya = Object.fromEntries((await sorgu('SELECT * FROM hub_links')).map((r) => [r.sub, r]));
  assert.equal(dosya[SUB_ADMIN].user_stamp, uyeler.bul('admin').olusturma);
  assert.equal(dosya[SUB_KAPALI].user_stamp, uyeler.bul('kapali').olusturma);
  assert.equal(dosya[SUB_OLU], undefined, 'uyesi olmayan eski bag atilmali');
  assert.equal(baglar.adaGore('admin')?.sub, SUB_ADMIN);
  assert.equal(dosya[SUB_ADMIN].email, 'admin@ornek.test', 'bagin diger alanlari korunur');
  // bag hala islevsel: merkezde erisimi kapali uye cerezle giremez, acik olan girer
  assert.equal((await t.giris('admin', 'eskiparola1')).durum, 200);
  assert.equal((await t.istek('/api/ben')).durum, 200);
  await t.giris('kapali', 'eskiparola1');
  const kapali = await t.istek('/api/ben', { kim: 'kapali' });
  assert.equal(kapali.durum, 401); assert.equal(kapali.json.kod, 'MERKEZ_ERISIM');
  // ayni adla yeniden olusturulan uye bagi devralamaz
  await t.istek('/api/uyeler/kapali', { yontem: 'DELETE' });
  assert.equal(baglar.adaGore('kapali'), null);
  assert.equal((await sorgu('SELECT sub FROM hub_links WHERE sub = ?', [SUB_KAPALI])).length, 0);
});

test('eski cihazlar.json: cihazlar yuklenir; ust sinir eski bloklardan baslar, silme sonrasi blok yeniden verilmez', async () => {
  const liste = (await t.istek('/api/cihazlar')).json.cihazlar;
  assert.deepEqual(liste.map((c) => [c.ad, c.baslangic]), [['Eski A', 0], ['Eski B', 4]]);
  assert.equal((await t.istek('/api/v1/kameralar')).json.kameralar.length, 8);
  const ekle = async (ad, ana) => (await t.istek('/api/cihazlar', { yontem: 'POST', govde: { ad, tur: 'sahte', ana, kullanici: 'u', parola: 'p1234567', etiket: 'N' } })).json.id;
  const n1 = await ekle('Yeni 1', '127.0.0.41');
  assert.equal((await t.istek('/api/cihazlar')).json.cihazlar.find((c) => c.id === n1).baslangic, 8, 'bugunku davranis: ilk bos blok');
  assert.equal(JSON.parse((await sorgu("SELECT value FROM settings WHERE name = 'device-block-limit'"))[0].value), 12);
  await t.istek(`/api/cihazlar/${n1}`, { yontem: 'DELETE' });
  const n2 = await ekle('Yeni 2', '127.0.0.42');
  assert.equal((await t.istek('/api/cihazlar')).json.cihazlar.find((c) => c.id === n2).baslangic, 12);
});

test('eski yetki.json: sahibi uye olan anahtar ve entegrasyon etiketli anahtar Bearer ile calismaya devam eder', async () => {
  const a = await t.istek('/api/v1/ben', { bearer: ESKI.uyeAnahtari });
  assert.equal(a.durum, 200, a.metin); assert.equal(a.json.tur, 'anahtar'); assert.deepEqual(a.json.izinler, ['canli.izle']);
  assert.equal((await t.istek('/api/v1/ben', { bearer: ESKI.etiketAnahtari })).durum, 200, 'sahibi uye olmayan entegrasyon anahtari kendi haklariyla calisir');
  assert.equal((await t.istek('/api/v1/ben', { bearer: ESKI.uyeAnahtari })).durum, 200);
});
