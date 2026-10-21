/**
 * Yetki, oturum ve girdi sinirlari icin guvenlik gerileme testleri.
 * Kendi uygulamasini kurar (api.test.mjs'in paylastigi durumdan bagimsiz). Giris kisiti testi IP'yi kilitler; bu yuzden EN SONDA.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { RtspYayin } from '../src/drivers/rtsp.mjs';
import { uygulamaAc } from './helpers.mjs';

let t, istek, giris, cerezler, h;
const P = (ad) => `${ad}parola1`;
const rolKur = async (id, izinler) => assert.equal((await istek('/api/yetki/roller', { yontem: 'POST', govde: { id, ad: id, izinler } })).durum, 200);
const uyeKur = async (ad, rol, ek = {}) => { const r = await istek('/api/uyeler', { yontem: 'POST', govde: { ad, parola: P(ad), rol, ...ek } }); assert.equal(r.durum, 200, r.metin); await giris(ad, P(ad)); };
const anahtarKur = async (govde, kim = 'admin') => { const r = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde, kim }); assert.equal(r.durum, 200, r.metin); return r.json; };
const cihazlar = async () => Object.fromEntries((await istek('/api/cihazlar')).json.cihazlar.map((c) => [c.ad.slice(-1), c]));

before(async () => {
  t = await uygulamaAc({ sunucu: { guvenilenIpBasligi: 'x-real-ip' } });
  ({ istek, giris, cerezler, hizmetler: h } = t);
  await giris('admin', 'adminparola1');
  await rolKur('uyeci', ['uye.yonet', 'canli.izle']);
  await rolKur('entegrator', ['canli.izle', 'api.anahtar']);
  await rolKur('izleyici', ['canli.izle']);
  await rolKur('operator', ['canli.izle', 'kayit.listele', 'cihaz.oku', 'cihaz.saat', 'cihaz.yonet', 'kanal.yonet']);
});
after(() => t.kapat());

// ---- 1 key-principal-display-name-as-owner
test('baska uyenin adini tasiyan kendi anahtari o uyenin anahtarlarini yonetemez/yenileyemez', async () => {
  const yonetim = await anahtarKur({ ad: 'yonetim', rol: 'admin' });
  await uyeKur('ent1', 'entegrator');
  const kendi = await anahtarKur({ ad: 'admin', izinler: ['canli.izle', 'api.anahtar'] }, 'ent1');       // goruntu adi: "admin"
  const b = kendi.anahtar;
  const liste = await istek('/api/yetki/anahtarlar', { bearer: b });
  assert.equal(liste.durum, 200); assert.ok(liste.json.every((a) => a.sahip === 'ent1'), 'yalniz kendi sahibinin anahtarlari listelenmeli');
  assert.equal((await istek(`/api/yetki/anahtarlar/${yonetim.kayit.id}`, { bearer: b })).durum, 403);
  const yenile = await istek(`/api/yetki/anahtarlar/${yonetim.kayit.id}/yenile`, { yontem: 'POST', bearer: b });
  assert.equal(yenile.durum, 403, yenile.metin);
  assert.equal((await istek('/api/v1/ben', { bearer: yonetim.anahtar })).durum, 200, 'yonetim anahtari bozulmamali');
  // anahtarla acilan anahtarin sahibi anahtarin adi degil, anahtarin sahibi olan uyedir
  const alt = await istek('/api/v1/anahtarlar', { yontem: 'POST', bearer: b, govde: { ad: 'admin', izinler: ['canli.izle'] } });
  assert.equal(alt.json.kayit.sahip, 'ent1');
});

// ---- 2 member-update-delete-target-authority-unchecked
test('uye.yonet sahibi kendinden yetkili uyeyi degistiremez/silemez; kapsamli yonetici kapsamsiz uyeyi degistiremez', async () => {
  await uyeKur('mudur1', 'uyeci');
  for (const [yontem, govde] of [['PATCH', { parola: 'saldirgan123' }], ['PATCH', { rol: 'izleyici' }], ['DELETE', undefined]]) {
    const r = await istek('/api/uyeler/admin', { kim: 'mudur1', yontem, govde });
    assert.equal(r.durum, 403, `${yontem}: ${r.metin}`); assert.equal(r.json.kod, 'YETKI_YUKSELTME');
  }
  await giris('admin', 'adminparola1');                                    // admin parolasi degismedi
  const a = (await cihazlar()).A;
  await uyeKur('mudur2', 'uyeci', { kapsam: { cihazlar: [a.id] } });
  await uyeKur('dusuk1', 'izleyici');                                      // kapsamsiz, izinleri mudur2'ninkinin alt kumesi
  assert.equal((await istek('/api/uyeler/dusuk1', { kim: 'mudur2', yontem: 'PATCH', govde: { parola: 'saldirgan123' } })).json.kod, 'YETKI_YUKSELTME');
  assert.equal((await istek('/api/uyeler/dusuk1', { kim: 'mudur2', yontem: 'DELETE' })).durum, 403);
  await uyeKur('dusuk2', 'izleyici', { kapsam: { kanallar: [1] } });       // kapsami mudur2'ninkinin icinde: serbest
  assert.equal((await istek('/api/uyeler/dusuk2', { kim: 'mudur2', yontem: 'PATCH', govde: { parola: 'yenisifre123' } })).durum, 200);
});

// ---- 4 api-key-outlives-owner-revocation
test('anahtar sahibi silinir/dusurulur/suresi dolur/IP disina cikarsa anahtar da islemez; sahip silinince anahtarlari iptal olur', async () => {
  await uyeKur('dus1', 'operator');
  const k = await anahtarKur({ ad: 'k', izinler: ['canli.izle', 'kayit.listele'], sahip: 'dus1' });
  assert.ok((await istek('/api/v1/ben', { bearer: k.anahtar })).json.izinler.includes('kayit.listele'));
  assert.equal((await istek('/api/uyeler/dus1', { yontem: 'PATCH', govde: { rol: 'izleyici' } })).durum, 200);
  const dusmus = (await istek('/api/v1/ben', { bearer: k.anahtar })).json;
  assert.ok(!dusmus.izinler.includes('kayit.listele') && dusmus.izinler.includes('canli.izle'), 'anahtar sahibinin guncel rolunu asamaz');
  assert.equal((await istek('/api/uyeler/dus1', { yontem: 'DELETE' })).durum, 200);
  assert.equal((await istek('/api/v1/ben', { bearer: k.anahtar })).durum, 401);
  await uyeKur('dus1', 'operator');                                        // ayni ad yeniden: eski anahtarlari devralamaz
  assert.equal((await istek('/api/v1/ben', { bearer: k.anahtar })).json.kod, 'ANAHTAR_IPTAL');
  // suresi dolan sahip
  await uyeKur('dus2', 'operator'); const k2 = await anahtarKur({ ad: 'k2', izinler: ['canli.izle'], sahip: 'dus2' });
  h.uyeler.bul('dus2').bitis = new Date(Date.now() - 1000).toISOString();
  assert.equal((await istek('/api/v1/ben', { bearer: k2.anahtar })).durum, 401);
  // IP listesi disindaki sahip
  await uyeKur('dus3', 'operator'); const k3 = await anahtarKur({ ad: 'k3', izinler: ['canli.izle'], sahip: 'dus3' });
  h.uyeler.bul('dus3').ipler = ['10.1.1.1'];
  assert.equal((await istek('/api/v1/ben', { bearer: k3.anahtar })).json.kod, 'IP_ENGELLI');
  // sahibi uye olmayan (yetki.yonet'in verdigi entegrasyon etiketi) anahtar kendi haklariyla calisir
  const e = await anahtarKur({ ad: 'e', izinler: ['canli.izle'], sahip: 'entegrasyon-etiketi' });
  assert.equal((await istek('/api/v1/ben', { bearer: e.anahtar })).durum, 200);
});

// ---- 5 stateless-session-cookie-no-revocation (+15 etiket ayrimi)
test('cerez cikista, parola degisince ve ayni adla yeniden acilista gecersiz olur', async () => {
  await uyeKur('oturum1', 'izleyici');
  const c1 = cerezler.get('oturum1');
  assert.equal((await istek('/api/ben', { cerez: c1 })).durum, 200);
  assert.equal((await istek('/api/cikis', { yontem: 'POST', cerez: c1 })).durum, 200);
  assert.equal((await istek('/api/ben', { cerez: c1 })).durum, 401, 'cikistan sonra eski cerez islememeli');
  await giris('oturum1', P('oturum1'));
  const c2 = cerezler.get('oturum1');
  assert.equal((await istek('/api/uyeler/oturum1', { yontem: 'PATCH', govde: { parola: 'degisti12345' } })).durum, 200);
  assert.equal((await istek('/api/ben', { cerez: c2 })).durum, 401, 'parola degisince eski cerez islememeli');
  await giris('oturum1', 'degisti12345');
  const c3 = cerezler.get('oturum1');
  assert.equal((await istek('/api/uyeler/oturum1', { yontem: 'DELETE' })).durum, 200);
  await uyeKur('oturum1', 'admin');
  assert.equal((await istek('/api/ben', { cerez: c3 })).durum, 401, 'ayni adla yeni hesap eski cerezi devralamaz');
  // kendi parolasini degistiren oturumdan dusmez (yeni cerez ayni yanitta gelir)
  await uyeKur('oturum2', 'uyeci');
  assert.equal((await istek('/api/uyeler/oturum2', { kim: 'oturum2', yontem: 'PATCH', govde: { parola: 'kendi12345678' } })).durum, 200);
  assert.equal((await istek('/api/ben', { kim: 'oturum2' })).durum, 200);
});

// ---- 15 signed-cookie-key-reuse-no-domain-separation
test('etiketsiz (eski bicim) imzali ya da tipsiz talepli cerez oturum sayilmaz', async () => {
  const plain = (yuk) => `${yuk}.${createHmac('sha256', h.uyeler.gizli).update(yuk).digest('base64url')}`;
  const yukle = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal((await istek('/api/ben', { cerez: `kamera_oturum=${plain(yukle({ a: 'admin', e: Date.now() + 1e6 }))}` })).durum, 401, 'eski bicim');
  await uyeKur('undefined', 'izleyici');
  // KYM akis cerezi bicimi ({d,s,e}) ayni anahtarla imzali: 'undefined' adli uyeye oturum vermemeli
  const akis = plain(yukle({ d: 'x', s: 'y', e: Date.now() + 1e6 }));
  assert.equal((await istek('/api/ben', { cerez: `kamera_oturum=${akis}` })).durum, 401);
  // dogru etiketle imzali ama tipsiz talep de reddedilir
  const etiketli = (o) => { const y = yukle(o); return `${y}.${h.uyeler.etiketliImza('kamera2/oturum', y)}`; };
  assert.equal((await istek('/api/ben', { cerez: `kamera_oturum=${etiketli({ e: Date.now() + 1e6 })}` })).durum, 401);
  assert.equal((await istek('/api/ben', { cerez: `kamera_oturum=${etiketli({ t: 'oturum', a: 5, e: Date.now() + 1e6 })}` })).durum, 401);
});

// ---- 6 key-bindings-not-bounded-by-creator
test('kisitli olusturan kisitsiz anahtar uretemez; sahip, admin koydugu kisiti gevsetemez', async () => {
  await uyeKur('ent2', 'entegrator');
  assert.equal((await istek('/api/uyeler/ent2', { yontem: 'PATCH', govde: { ipler: ['127.0.0.1'], bitis: '2099-01-01' } })).durum, 200);
  await giris('ent2', P('ent2'));
  const k = await anahtarKur({ ad: 'a', izinler: ['canli.izle'] }, 'ent2');
  assert.deepEqual(k.kayit.ipler, ['127.0.0.1']); assert.equal(k.kayit.bitis, (h.uyeler.bul('ent2')).bitis);
  for (const govde of [{ ipler: ['10.0.0.0/8'] }, { bitis: '2100-01-01' }]) {
    const r = await istek('/api/yetki/anahtarlar', { kim: 'ent2', yontem: 'POST', govde: { ad: 'b', izinler: ['canli.izle'], ...govde } });
    assert.equal(r.durum, 403, r.metin); assert.equal(r.json.kod, 'YETKI_YUKSELTME');
  }
  assert.equal((await istek(`/api/yetki/anahtarlar/${k.kayit.id}`, { kim: 'ent2', yontem: 'PATCH', govde: { ipler: [] } })).durum, 403);
  // anahtar ebeveyn: hiz/akis siniri asilamaz
  const dar = await anahtarKur({ ad: 'dar', izinler: ['canli.izle', 'api.anahtar'], sahip: 'ent2', hizLimiti: 50, eszamanliAkis: 1 });
  const cocuk = await istek('/api/v1/anahtarlar', { yontem: 'POST', bearer: dar.anahtar, govde: { ad: 'c', izinler: ['canli.izle'] } });
  assert.equal(cocuk.durum, 200, cocuk.metin); assert.ok(cocuk.json.kayit.hizLimiti <= 50 && cocuk.json.kayit.eszamanliAkis <= 1);
  assert.equal((await istek('/api/v1/anahtarlar', { yontem: 'POST', bearer: dar.anahtar, govde: { ad: 'c2', izinler: ['canli.izle'], hizLimiti: 100 } })).json.kod, 'YETKI_YUKSELTME');
  // admin'in atadigi kisit
  const atanmis = await anahtarKur({ ad: 'atanmis', izinler: ['canli.izle'], sahip: 'ent2', ipler: ['127.0.0.1'], hizLimiti: 10 });
  const yama = (govde) => istek(`/api/yetki/anahtarlar/${atanmis.kayit.id}`, { kim: 'ent2', yontem: 'PATCH', govde });
  assert.equal((await yama({ ipler: [] })).durum, 403);
  assert.equal((await yama({ hizLimiti: 100 })).durum, 403);
  assert.equal((await yama({ hizLimiti: 5 })).durum, 200);
});

// ---- 13 member-self-restriction-lift
test('kisitli uye yoneticisi kendi bitis/IP kisitini kaldiramaz ve gevsek ikiz hesap acamaz', async () => {
  await uyeKur('mgr1', 'uyeci');
  assert.equal((await istek('/api/uyeler/mgr1', { yontem: 'PATCH', govde: { ipler: ['127.0.0.1'], bitis: '2099-01-01' } })).durum, 200);
  await giris('mgr1', P('mgr1'));
  const ben = (await istek('/api/uyeler')).json.find((u) => u.ad === 'mgr1');
  const yama = (govde) => istek('/api/uyeler/mgr1', { kim: 'mgr1', yontem: 'PATCH', govde });
  for (const govde of [{ bitis: null }, { ipler: [] }, { ipler: ['127.0.0.1', '10.0.0.1'] }, { bitis: '2100-01-01' }]) assert.equal((await yama(govde)).json.kod, 'YETKI_YUKSELTME', JSON.stringify(govde));
  assert.equal((await yama({ rol: 'uyeci', kapsam: null, bitis: ben.bitis, ipler: ben.ipler })).durum, 200, 'arayuz hepsini geri yollar: degismeyen deger serbest');
  const ikiz = (govde) => istek('/api/uyeler', { kim: 'mgr1', yontem: 'POST', govde: { ad: 'ikiz1', parola: P('ikiz1'), rol: 'izleyici', ...govde } });
  assert.equal((await ikiz({})).json.kod, 'YETKI_YUKSELTME');
  assert.equal((await ikiz({ ipler: ['127.0.0.1'] })).json.kod, 'YETKI_YUKSELTME');
  assert.equal((await ikiz({ bitis: '2100-01-01', ipler: ['127.0.0.1'] })).json.kod, 'YETKI_YUKSELTME');
  assert.equal((await ikiz({ bitis: ben.bitis, ipler: ['127.0.0.1'] })).durum, 200);
});

// ---- 7 device-password-reuse-on-host-change
test('cihazin adresi/portu parola yeniden girilmeden degistirilemez', async () => {
  const c = await istek('/api/cihazlar', { yontem: 'POST', govde: { ad: 'Sahte C', tur: 'sahte', ana: '127.0.0.13', kullanici: 'u', parola: 'cihazparola', etiket: 'C' } });
  assert.equal(c.durum, 200, c.metin); const id = c.json.id;
  const yama = (govde) => istek(`/api/cihazlar/${id}`, { yontem: 'PATCH', govde });
  const r = await yama({ ana: '127.0.0.99' }); assert.equal(r.durum, 400, r.metin); assert.match(r.json.hata, /parola/);
  assert.equal((await yama({ ana: '127.0.0.13', httpPort: 8080 })).durum, 400, 'port degisimi de parola ister');
  const ana = async () => (await istek('/api/cihazlar')).json.cihazlar.find((x) => x.id === id).ana;
  assert.equal(await ana(), '127.0.0.13');
  assert.equal((await yama({ ad: 'Sahte C2', ana: '127.0.0.13' })).durum, 200, 'adres ayni: parolasiz duzenlenebilir');
  assert.equal((await yama({ ana: '127.0.0.98', parola: 'yeniparola1' })).durum, 200, 'parola verilirse adres degisebilir');
  assert.equal(await ana(), '127.0.0.98');
  assert.equal((await istek(`/api/cihazlar/${id}`, { yontem: 'DELETE' })).durum, 200);
});

// ---- 9 numeric-channel-scope-rebinds-new-device
test('silinen cihazin kanal blogu yeni cihaza verilmez; kapsamli yonetici olmayan kanal numarasi veremez', async () => {
  const ekle = async (ad, ana) => { const r = await istek('/api/cihazlar', { yontem: 'POST', govde: { ad, tur: 'sahte', ana, kullanici: 'u', parola: 'p1234567', etiket: 'D' } }); assert.equal(r.durum, 200, r.metin); return r.json.id; };
  const bas = async (id) => (await istek('/api/cihazlar')).json.cihazlar.find((c) => c.id === id).baslangic;
  const d1 = await ekle('Sahte X', '127.0.0.21'); const b1 = await bas(d1);
  assert.equal((await istek(`/api/cihazlar/${d1}`, { yontem: 'DELETE' })).durum, 200);
  const d2 = await ekle('Sahte Y', '127.0.0.22');
  assert.ok(await bas(d2) >= b1 + 4, 'silinen blok yeniden kullanilmamali');
  assert.equal((await istek(`/api/cihazlar/${d2}`, { yontem: 'DELETE' })).durum, 200);
  const a = (await cihazlar()).A;
  await uyeKur('mudur3', 'uyeci', { kapsam: { cihazlar: [a.id] } });
  const r = await istek('/api/uyeler', { kim: 'mudur3', yontem: 'POST', govde: { ad: 'onceden1', parola: P('onceden1'), rol: 'izleyici', kapsam: { kanallar: [100] } } });
  assert.equal(r.durum, 403, r.metin); assert.equal(r.json.kod, 'YETKI_YUKSELTME');
});

// ---- 8 device-channel-writes-ignore-kapsam + 12 bilgi-kapsamsuz-unfiltered-metadata
test('kapsamli asal kapsam disi kanal/cihaz yazamaz; bilgi kapsam disi veri tasimaz', async () => {
  const { A, B } = await cihazlar();
  assert.equal((await istek('/api/kanallar', { yontem: 'PUT', govde: { ayar: { 0: { ad: 'A-SIFIR' } } } })).durum, 200);
  await uyeKur('kapsb', 'operator', { kapsam: { cihazlar: [B.id] } });
  const k = (yol, yontem, govde) => istek(yol, { kim: 'kapsb', yontem, govde });
  const dis = await k('/api/kanallar', 'PUT', { ayar: { 0: { ad: 'ele-gecirildi', gorunum: 'gizle' } } });
  assert.equal(dis.durum, 403, dis.metin); assert.equal(dis.json.kod, 'KAPSAM_DISI');
  assert.equal((await k('/api/kanallar', 'PUT', { ayar: { 4: { ad: 'B-SIFIR' } } })).durum, 200);
  assert.equal(h.cihazlar.kanalAyar['0']?.ad, 'A-SIFIR', 'kapsam disi ayar korunmali');
  assert.equal(h.cihazlar.kanalAyar['4']?.ad, 'B-SIFIR');
  assert.equal((await k('/api/dvr/saat', 'POST', { cihaz: A.id })).json.kod, 'KAPSAM_DISI');
  assert.equal((await k('/api/dvr/saat', 'POST', { cihaz: B.id })).durum, 200);
  assert.equal((await k(`/api/cihazlar/${A.id}`, 'PATCH', { ad: 'ele' })).json.kod, 'KAPSAM_DISI');
  assert.equal((await k(`/api/cihazlar/${A.id}`, 'DELETE')).json.kod, 'KAPSAM_DISI');
  assert.equal((await k(`/api/cihazlar/${A.id}/kamera`, 'POST', { ad: 'x', ip: '10.0.0.1', kullanici: 'u', parola: 'p' })).json.kod, 'KAPSAM_DISI');
  assert.equal((await k('/api/cihazlar', 'POST', { ad: 'Z', tur: 'sahte', ana: '127.0.0.50', kullanici: 'u', parola: 'p1234567' })).json.kod, 'KAPSAM_DISI');
  assert.equal((await k('/api/dvr/temizle', 'POST', { onay: 'TÜM KAYITLARI SİL' })).json.kod, 'KAPSAM_DISI');
  assert.equal((await cihazlar()).A.ad, 'Sahte A');
  // bilgi
  const b = (await k('/api/bilgi', 'GET')).json;
  for (let i = 0; i < 4; i++) for (const alan of ['kanalAdlari', 'kanalKodlar', 'kanalKamera', 'kanalCihaz', 'kanalCihazAdi']) assert.equal(b[alan][i], '', `${alan}[${i}]`);
  assert.deepEqual(Object.keys(b.kanalAyar), ['4']);
  assert.ok(b.diskler.every((d) => d.cihaz === B.id) && b.diskler.length === 1);
  assert.ok(!JSON.stringify(b).includes('127.0.0.11') && !JSON.stringify(b).includes('S-127.0.0.11'), 'kapsam disi cihaz adresi/seri no sizmamali');
  assert.equal(b.cihazlar.length, 1); assert.equal(b.diskMB.toplam, 1000);
  assert.equal(b.kanalAdlari.length, b.kanalBos.length, 'dizi uzunlugu korunur');
});

// ---- 11 public-docs-and-meta-routes-outside-kimlik
test('dokuman ve /api/v1 oturum ister; saglik yalniz dongu adresinden; .json statik sunulmaz', async () => {
  for (const yol of ['/dokuman', '/dokuman/api-v1.tr.md', '/dokuman/openapi.json', '/api/v1']) {
    assert.equal((await istek(yol, { kim: null })).durum, 401, yol);
    assert.equal((await istek(yol)).durum, 200, `${yol} oturumla acilmali`);
  }
  assert.equal((await istek('/dokuman/..%2Fpackage.json')).durum, 404);
  assert.equal((await istek('/css/eys/OZET.json', { kim: null })).durum, 404);
  assert.equal((await istek('/css/app.css', { kim: null })).durum, 200);
  assert.equal((await istek('/', { kim: null })).durum, 200);
  const s = await istek('/api/v1/saglik', { kim: null });
  assert.equal(s.durum, 200); assert.deepEqual(s.json, { tamam: true });
  assert.equal((await istek('/api/v1/saglik', { kim: null, basliklar: { 'X-Real-IP': '203.0.113.9' } })).durum, 404, 'vekil uzerinden gelen istek saglik yoklamasi sayilmaz');
});

// ---- 14 request-url-parse-outside-try
test('bozuk istek hedefi 400 ile yanitlanir', async () => {
  const yanit = await new Promise((coz) => {
    const s = connect(t.sunucu.address().port, '127.0.0.1', () => s.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let v = ''; s.on('data', (b) => { v += b; }); s.on('end', () => coz(v)); s.on('error', () => coz(v));
    setTimeout(() => { s.destroy(); coz(v); }, 3000);
  });
  assert.match(yanit, /^HTTP\/1\.1 400 /);
});

// ---- NV: indirme de akis hakkindan sayilir; ffmpeg baslatilamazsa panel dusmez
test('indirme eszamanli akis sinirina tabidir (eszamanliAkis=0 olan anahtar indiremez)', async () => {
  const k = await anahtarKur({ ad: 'indirici', izinler: ['kayit.indir'], eszamanliAkis: 0 });
  const yol = '/api/v1/kameralar/0/indir?dosya=/sahte/c0/x.h264&bas=2026-10-05%2010:00:00&bit=2026-10-05%2010:05:00';
  const r = await istek(yol, { bearer: k.anahtar });
  assert.equal(r.durum, 429, r.metin); assert.equal(r.json.kod, 'AKIS_SINIRI');
  const k2 = await anahtarKur({ ad: 'indirici2', izinler: ['kayit.indir'], eszamanliAkis: 1 });
  assert.equal((await istek(yol, { bearer: k2.anahtar })).durum, 200);
});

test('ffmpeg baslatilamazsa (ENOENT) yayin hata ile kapanir, surec dusmez', async () => {
  const cihaz = { ffmpeg: '/yok/ffmpeg-yok', rtspUrl: () => 'rtsp://127.0.0.1:1/x', olcek: () => 'scale=320:180' };
  const y = new RtspYayin(cihaz, '/x', 320, () => {}, false);
  y.baslat();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(y.durduruldu, true); y.durdur();
});

// ---- NV: giris hata kaydi sinirli
test('giris hata kaydi: kullanici adi kirpilir (anahtar uzunlugu sinirli)', async () => {
  try { await h.uyeler.dogrula('x'.repeat(5000), 'yanlis', '9.9.9.9'); } catch {}
  assert.ok([...h.uyeler.hatalar.keys()].every((a) => a.length <= '9.9.9.9|'.length + 64));
});

// ---- 10 preauth-login-sync-scrypt-no-rate-gate (IP'yi kilitler: EN SON)
test('kimliksiz giris IP basina sinirlanir (kullanici adi degistirerek asilamaz)', async () => {
  const durumlar = [];
  for (let i = 0; i < 24; i++) durumlar.push((await istek('/api/giris', { yontem: 'POST', govde: { ad: `yok${i}`, parola: 'yanlis' }, kim: null })).durum);
  assert.ok(durumlar.includes(429), `429 beklenirdi: ${durumlar.join(',')}`);
  assert.ok(durumlar.slice(0, 20).every((d) => d === 401));
  const r = await istek('/api/giris', { yontem: 'POST', govde: { ad: 'admin', parola: 'adminparola1' }, kim: null });
  assert.equal(r.durum, 429); assert.equal(r.json.kod, 'COK_FAZLA_DENEME'); assert.ok(r.basliklar.get('retry-after'));
});
