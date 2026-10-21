import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Asal, HataKisiti, HizSiniri, IZINLER, YetkiDeposu, YetkiHatasi, YERLESIK_ROLLER, bitisNormalle, iplerNormalle, ipEslesir, ipKuraliGecerli,
  izinAltKume, izinGecerli, izinGenislet, izinKesisim, izinVar, kapsamIcinde, kapsamKanalIzinli, kapsamKesisim, kapsamKumesi, kapsamNormalle,
} from '../src/models/yetki.mjs';

// kanallar: cihaz A = 0..3, cihaz B = 4..7
const cihazIdOf = (k) => (k < 4 ? 'aaaa1111' : k < 8 ? 'bbbb2222' : null);
const KANAL_TOPLAM = 8;
const yeniDepo = (secenek = {}) => {
  const dizin = mkdtempSync(join(tmpdir(), 'yetki-'));
  const dosya = join(dizin, 'yetki.json'), gizli = randomBytes(32);
  return { dizin, dosya, gizli, depo: new YetkiDeposu(dosya, gizli, secenek), temizle: () => rmSync(dizin, { recursive: true, force: true }) };
};
/** Sinamalarin kullandigi izin kumeleri (eski yerlesik roller) ozel rol olarak kurulur. */
const ozelRoller = (depo) => { depo.rolEkle({ id: 'kullanici', ad: 'Kullanıcı', izinler: ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir'] }, 'admin'); depo.rolEkle({ id: 'izleyici', ad: 'İzleyici', izinler: ['canli.izle'] }, 'admin'); };
const hatakodu = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof YetkiHatasi, `YetkiHatasi bekleniyordu: ${e}`); return e.kod; } assert.fail('hata bekleniyordu'); };

test('izinVar: tam, grup joker ve * kuralları', () => {
  assert.ok(izinVar(['*'], 'kayit.indir'));
  assert.ok(izinVar(['kayit.*'], 'kayit.izle'));
  assert.ok(!izinVar(['kayit.*'], 'canli.izle'));
  assert.ok(izinVar(['canli.izle'], 'canli.izle'));
  assert.ok(!izinVar(['canli.izle'], 'canli'));
  assert.ok(!izinVar([], 'canli.izle'));
  assert.ok(!izinVar(['kayit.izle'], 'kayit.indir'));
});

test('izin kataloğu: geçerlilik, genişletme, alt küme, kesişim', () => {
  assert.ok(izinGecerli('*') && izinGecerli('kayit.*') && izinGecerli('cihaz.yonet'));
  assert.ok(!izinGecerli('foo.bar') && !izinGecerli('foo.*') && !izinGecerli(5) && !izinGecerli(''));
  assert.deepEqual(izinGenislet(['*']).sort(), Object.keys(IZINLER).sort());
  assert.deepEqual(izinGenislet(['kayit.*']).sort(), ['kayit.indir', 'kayit.izle', 'kayit.listele']);
  assert.ok(izinAltKume(['canli.izle'], ['canli.izle', 'kayit.izle']));
  assert.ok(!izinAltKume(['kayit.indir'], ['canli.izle']));
  assert.ok(izinAltKume(['kayit.izle'], ['kayit.*']));
  assert.ok(!izinAltKume(['*'], ['kayit.*']));
  assert.ok(izinAltKume(['*'], ['*']));
  assert.deepEqual(izinKesisim(['canli.izle', 'kayit.izle'], ['kayit.*']), ['kayit.izle']);
});

test('yerleşik roller DC panelleriyle aynı: admin her şey, network/teknik/muhasebe izinsiz doğar, kamera izlemeyle', () => {
  assert.deepEqual(Object.keys(YERLESIK_ROLLER), ['admin', 'network', 'teknik', 'muhasebe', 'kamera']);
  assert.deepEqual(YERLESIK_ROLLER.kamera.izinler, ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir']);
  assert.ok(YERLESIK_ROLLER.kamera.izinDuzenlenir && !izinVar(YERLESIK_ROLLER.kamera.izinler, 'uye.yonet') && !izinVar(YERLESIK_ROLLER.kamera.izinler, 'cihaz.yonet'));
  assert.ok(izinVar(YERLESIK_ROLLER.admin.izinler, 'yetki.yonet'));
  for (const id of ['network', 'teknik', 'muhasebe']) { assert.deepEqual(YERLESIK_ROLLER[id].izinler, []); assert.ok(YERLESIK_ROLLER[id].izinDuzenlenir); }
  assert.ok(!YERLESIK_ROLLER.admin.izinDuzenlenir);
});

test('IP ve CIDR eşleşmesi', () => {
  assert.ok(ipEslesir('10.0.0.5', []) && ipEslesir('1.2.3.4', undefined));
  assert.ok(ipEslesir('10.0.0.5', ['10.0.0.0/24']));
  assert.ok(!ipEslesir('10.0.1.5', ['10.0.0.0/24']));
  assert.ok(ipEslesir('::ffff:10.0.0.9', ['10.0.0.0/24']));
  assert.ok(ipEslesir('192.168.1.1', ['10.0.0.0/8', '192.168.1.1']));
  assert.ok(ipEslesir('8.8.8.8', ['0.0.0.0/0']));
  assert.ok(!ipEslesir('8.8.8.8', ['8.8.8.9/32']));
  assert.ok(ipEslesir('::1', ['::1']));
  assert.ok(ipKuraliGecerli('10.0.0.0/24') && ipKuraliGecerli('1.2.3.4') && ipKuraliGecerli('::1'));
  assert.ok(!ipKuraliGecerli('10.0.0.0/33') && !ipKuraliGecerli('999.1.1.1') && !ipKuraliGecerli('abc') && !ipKuraliGecerli(5));
  assert.equal(hatakodu(() => iplerNormalle(['abc'])), 'GECERSIZ_ISTEK');
  assert.deepEqual(iplerNormalle(['1.2.3.4', '1.2.3.4', ' 10.0.0.0/8 ']), ['1.2.3.4', '10.0.0.0/8']);
});

test('bitiş tarihi normalleştirme', () => {
  assert.equal(bitisNormalle(null), null);
  assert.equal(bitisNormalle(''), null);
  assert.equal(bitisNormalle('2030-01-02'), '2030-01-02T23:59:59.000Z');
  assert.equal(bitisNormalle('2030-01-02T10:00:00Z'), '2030-01-02T10:00:00.000Z');
  assert.equal(hatakodu(() => bitisNormalle('yarın')), 'GECERSIZ_ISTEK');
});

test('kapsam: cihaz, kanal, kapsam içinde, kesişim', () => {
  assert.equal(kapsamNormalle(null), null);
  assert.deepEqual(kapsamNormalle({ cihazlar: ['aaaa1111', 'aaaa1111'], kanallar: [5, 2, 5] }), { cihazlar: ['aaaa1111'], kanallar: [2, 5] });
  assert.equal(hatakodu(() => kapsamNormalle([1])), 'GECERSIZ_ISTEK');
  assert.equal(hatakodu(() => kapsamNormalle({ kanallar: [-1] })), 'GECERSIZ_ISTEK');
  assert.equal(hatakodu(() => kapsamNormalle({ cihazlar: ['x y'] })), 'GECERSIZ_ISTEK');
  const a = { cihazlar: ['aaaa1111'], kanallar: [5] };
  assert.ok(kapsamKanalIzinli(null, 99, cihazIdOf));
  assert.ok(kapsamKanalIzinli(a, 1, cihazIdOf) && kapsamKanalIzinli(a, 5, cihazIdOf));
  assert.ok(!kapsamKanalIzinli(a, 6, cihazIdOf) && !kapsamKanalIzinli(a, 8, cihazIdOf));
  assert.ok(!kapsamKanalIzinli({ cihazlar: [], kanallar: [] }, 0, cihazIdOf));
  assert.deepEqual([...kapsamKumesi(a, KANAL_TOPLAM, cihazIdOf)], [0, 1, 2, 3, 5]);
  assert.ok(kapsamIcinde({ kanallar: [1, 2] }, a, KANAL_TOPLAM, cihazIdOf));
  assert.ok(!kapsamIcinde({ kanallar: [1, 6] }, a, KANAL_TOPLAM, cihazIdOf));
  assert.ok(kapsamIcinde(a, null, KANAL_TOPLAM, cihazIdOf));
  assert.ok(!kapsamIcinde(null, a, KANAL_TOPLAM, cihazIdOf));
  assert.deepEqual(kapsamKesisim(a, { kanallar: [1, 5, 6] }, KANAL_TOPLAM, cihazIdOf).kanallar, [1, 5]);
  assert.equal(kapsamKesisim(null, null, KANAL_TOPLAM, cihazIdOf), null);
  assert.deepEqual(kapsamKesisim(null, { kanallar: [2] }, KANAL_TOPLAM, cihazIdOf).kanallar, [2]);
});

test('hız sınırı: kayan pencere', () => {
  const h = new HizSiniri();
  for (let i = 0; i < 3; i++) assert.ok(h.dene('a', 3, 60_000, 1000 + i).tamam);
  const r = h.dene('a', 3, 60_000, 1010);
  assert.equal(r.tamam, false);
  assert.ok(r.sifirlanmaSn >= 1 && r.sifirlanmaSn <= 60);
  assert.ok(h.dene('b', 3, 60_000, 1010).tamam);               // başka anahtar etkilenmez
  assert.ok(h.dene('a', 3, 60_000, 1000 + 60_001).tamam);       // pencere kaydı
});

test('hata kısıtı: eşikte IP kilitlenir, başarıda sıfırlanır', () => {
  const k = new HataKisiti({ en: 3, pencereMs: 1000, kilitMs: 5000 });
  assert.equal(k.kilitliMi('1.1.1.1', 0), 0);
  k.hata('1.1.1.1', 0); k.hata('1.1.1.1', 1); assert.equal(k.kilitliMi('1.1.1.1', 2), 0);
  k.hata('1.1.1.1', 3);
  assert.ok(k.kilitliMi('1.1.1.1', 4) > 0);
  assert.equal(k.kilitliMi('1.1.1.1', 6000), 0);
  k.hata('2.2.2.2', 0); k.basari('2.2.2.2'); k.hata('2.2.2.2', 1); k.hata('2.2.2.2', 2);
  assert.equal(k.kilitliMi('2.2.2.2', 3), 0);
});

test('roller: yerleşik değişmez, özel rol CRUD, * yasak, kullanımdaki silinemez, yükseltme engeli', () => {
  const { depo, temizle } = yeniDepo({ rolKullanimda: (id) => id === 'kullanimda' });
  try {
    assert.ok(depo.rolVar('admin') && depo.rolVar('teknik') && depo.rolVar('network') && depo.rolVar('muhasebe') && !depo.rolVar('kullanici') && !depo.rolVar('ozel1'));
    // DC rolleri: izinleri bos dogar, yalniz izin listesi degisir, silinmez; * verilemez
    assert.deepEqual(depo.rolIzinleri('teknik'), []);
    assert.deepEqual(depo.rolGuncelle('teknik', { izinler: ['canli.izle'] }).izinler, ['canli.izle']);
    assert.equal(hatakodu(() => depo.rolGuncelle('teknik', { izinler: ['*'] })), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.rolGuncelle('teknik', { izinler: ['uye.yonet'] }, ['canli.izle'])), 'YETKI_YUKSELTME');
    assert.equal(hatakodu(() => depo.rolSil('teknik')), 'YERLESIK_DEGISMEZ');
    assert.equal(hatakodu(() => depo.rolGuncelle('admin', { izinler: ['canli.izle'] })), 'YERLESIK_DEGISMEZ');
    assert.equal(hatakodu(() => depo.rolSil('admin')), 'YERLESIK_DEGISMEZ');
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'Kötü Ad', ad: 'x', izinler: ['canli.izle'] }, 'admin')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'ozel1', ad: 'Özel', izinler: ['*'] }, 'admin')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'ozel1', ad: 'Özel', izinler: ['yok.izin'] }, 'admin')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'ozel1', ad: 'Özel', izinler: [] }, 'admin')), 'GECERSIZ_ISTEK');
    const r = depo.rolEkle({ id: 'ozel1', ad: 'Özel', aciklama: 'deneme', izinler: ['canli.izle', 'kayit.*'] }, 'admin');
    assert.deepEqual(r.izinler, ['canli.izle', 'kayit.*']);
    assert.equal(r.ad.tr, 'Özel');
    assert.ok(izinVar(depo.rolIzinleri('ozel1'), 'kayit.indir'));
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'ozel1', ad: 'x', izinler: ['canli.izle'] }, 'admin')), 'CAKISMA');
    assert.deepEqual(depo.rolGuncelle('ozel1', { izinler: ['canli.izle'] }).izinler, ['canli.izle']);
    // yükseltme: sahibi yalnız canli.izle olan biri kayit.* içeren rol veremez
    assert.equal(hatakodu(() => depo.rolEkle({ id: 'ozel2', ad: 'x', izinler: ['kayit.izle'] }, 'k', ['canli.izle'])), 'YETKI_YUKSELTME');
    depo.rolEkle({ id: 'kullanimda', ad: 'k', izinler: ['canli.izle'] }, 'admin');
    assert.equal(hatakodu(() => depo.rolSil('kullanimda')), 'CAKISMA');
    depo.rolSil('ozel1');
    assert.ok(!depo.rolVar('ozel1'));
  } finally { temizle(); }
});

test('API anahtarı: oluşturma, biçim, özet saklama, doğrulama, kalıcılık', () => {
  const { depo, dosya, gizli, temizle } = yeniDepo();
  ozelRoller(depo);
  try {
    const { kayit, anahtar } = depo.anahtarOlustur({ ad: 'mobil', rol: 'kullanici', kapsam: { cihazlar: ['aaaa1111'] }, ipler: ['10.0.0.0/24'], hizLimiti: 30, eszamanliAkis: 2 }, 'admin');
    assert.match(anahtar, /^kp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(kayit.karma, undefined);
    assert.ok(kayit.izinlerEfektif.includes('kayit.indir') && !kayit.izinlerEfektif.includes('cihaz.yonet'));
    const dosyaMetni = readFileSync(dosya, 'utf8');
    assert.ok(!dosyaMetni.includes(anahtar.slice('kp_12345678_'.length)), 'gizli düz metin saklanmamalı');
    assert.ok(dosyaMetni.includes('karma'));
    const a = depo.anahtarDogrula(anahtar, '10.0.0.9');
    assert.equal(a.id, kayit.id);
    assert.equal(depo.anahtarBul(kayit.id).sayac, 0);
    depo.kullanimiKaydet(kayit.id, '10.0.0.9');
    assert.equal(depo.anahtarBul(kayit.id).sayac, 1);
    assert.equal(depo.anahtarBul(kayit.id).sonKullanim.ip, '10.0.0.9');
    // IP kısıtı
    assert.equal(hatakodu(() => depo.anahtarDogrula(anahtar, '8.8.8.8')), 'IP_ENGELLI');
    // yanlış gizli / biçim
    assert.equal(hatakodu(() => depo.anahtarDogrula(`kp_${kayit.id}_${'A'.repeat(43)}`, '10.0.0.9')), 'GECERSIZ_ANAHTAR');
    assert.equal(hatakodu(() => depo.anahtarDogrula('abc', '10.0.0.9')), 'GECERSIZ_ANAHTAR');
    assert.equal(hatakodu(() => depo.anahtarDogrula(undefined, '10.0.0.9')), 'GECERSIZ_ANAHTAR');
    // kapat → yeniden yükle: anahtar hâlâ doğrulanır
    depo.kapat();
    const depo2 = new YetkiDeposu(dosya, gizli);
    assert.equal(depo2.anahtarDogrula(anahtar, '10.0.0.9').id, kayit.id);
    // başka gizli anahtarla (başka sunucu) doğrulanmaz
    const depo3 = new YetkiDeposu(dosya, randomBytes(32));
    assert.equal(hatakodu(() => depo3.anahtarDogrula(anahtar, '10.0.0.9')), 'GECERSIZ_ANAHTAR');
  } finally { temizle(); }
});

test('API anahtarı: alanlar doğrulanır, yükseltme ve kapsam taşması engellenir', () => {
  const { depo, temizle } = yeniDepo();
  ozelRoller(depo);
  try {
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: '', rol: 'kullanici' }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x' }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', rol: 'yok' }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', izinler: ['yok.izin'] }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', rol: 'kullanici', bitis: '2001-01-01' }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', rol: 'kullanici', hizLimiti: 0 }, 'a')), 'GECERSIZ_ISTEK');
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', rol: 'kullanici', eszamanliAkis: 99 }, 'a')), 'GECERSIZ_ISTEK');
    // yükseltme: sahibin izni yalnız canli.izle
    const ebeveyn = { ebeveynIzinler: ['canli.izle'], kanalToplam: KANAL_TOPLAM, cihazIdOf };
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'x', rol: 'kullanici' }, 'u', ebeveyn)), 'YETKI_YUKSELTME');
    assert.ok(depo.anahtarOlustur({ ad: 'x', izinler: ['canli.izle'] }, 'u', ebeveyn).anahtar);
    // kapsam: sahip yalnız cihaz A
    const kisitli = { ebeveynIzinler: ['*'], ebeveynKapsam: { cihazlar: ['aaaa1111'] }, kanalToplam: KANAL_TOPLAM, cihazIdOf };
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'y', rol: 'kullanici' }, 'u', kisitli)), 'YETKI_YUKSELTME');                    // kapsamsız
    assert.equal(hatakodu(() => depo.anahtarOlustur({ ad: 'y', rol: 'kullanici', kapsam: { cihazlar: ['bbbb2222'] } }, 'u', kisitli)), 'YETKI_YUKSELTME');
    assert.ok(depo.anahtarOlustur({ ad: 'y', rol: 'kullanici', kapsam: { kanallar: [1, 2] } }, 'u', kisitli).anahtar);
  } finally { temizle(); }
});

test('API anahtarı: süre, iptal, yenileme, silme, hata kısıtı', () => {
  const { depo, temizle } = yeniDepo();
  ozelRoller(depo);
  try {
    const { kayit, anahtar } = depo.anahtarOlustur({ ad: 'a', rol: 'izleyici' }, 'admin');
    // süre dolumu (dosyaya bitiş yazıp yeniden hesapla)
    const a = depo.veri.anahtarlar[0];
    a.bitis = new Date(Date.now() - 1000).toISOString();
    assert.equal(hatakodu(() => depo.anahtarDogrula(anahtar, '1.1.1.1')), 'SURESI_DOLDU');
    a.bitis = null;
    assert.equal(depo.anahtarDogrula(anahtar, '1.1.1.1').id, kayit.id);
    // yenileme: eski gizli geçersiz, yeni geçerli, kimlik aynı
    const yeni = depo.anahtarYenile(kayit.id);
    assert.equal(yeni.kayit.id, kayit.id);
    assert.equal(hatakodu(() => depo.anahtarDogrula(anahtar, '1.1.1.1')), 'GECERSIZ_ANAHTAR');
    assert.equal(depo.anahtarDogrula(yeni.anahtar, '1.1.1.1').id, kayit.id);
    // güncelleme
    assert.equal(depo.anahtarGuncelle(kayit.id, { ad: 'b', hizLimiti: 10 }).ad, 'b');
    assert.equal(hatakodu(() => depo.anahtarGuncelle(kayit.id, { rol: 'yok' })), 'GECERSIZ_ISTEK');
    // iptal: doğrulama ANAHTAR_IPTAL; güncelleme/yenileme reddedilir
    depo.anahtarIptal(kayit.id, 'admin');
    assert.equal(hatakodu(() => depo.anahtarDogrula(yeni.anahtar, '1.1.1.1')), 'ANAHTAR_IPTAL');
    assert.equal(hatakodu(() => depo.anahtarYenile(kayit.id)), 'CAKISMA');
    assert.equal(hatakodu(() => depo.anahtarGuncelle(kayit.id, { ad: 'c' })), 'CAKISMA');
    assert.equal(depo.anahtarBul(kayit.id).aktif, false);
    depo.anahtarSil(kayit.id);
    assert.equal(depo.anahtarBul(kayit.id), null);
    assert.equal(hatakodu(() => depo.anahtarSil(kayit.id)), 'BULUNAMADI');
    // kaba kuvvet: 10 hatadan sonra kilit (doğru anahtar bile reddedilir)
    const { anahtar: iyi } = depo.anahtarOlustur({ ad: 'k', rol: 'izleyici' }, 'admin');
    for (let i = 0; i < 10; i++) hatakodu(() => depo.anahtarDogrula('kp_00000000_' + 'A'.repeat(43), '9.9.9.9'));
    assert.equal(hatakodu(() => depo.anahtarDogrula(iyi, '9.9.9.9')), 'COK_FAZLA_DENEME');
    assert.equal(depo.anahtarDogrula(iyi, '9.9.9.10') ? 'tamam' : '', 'tamam');       // başka IP etkilenmez
  } finally { temizle(); }
});

test('Asal: izin, kapsam, günlük adı', () => {
  const ctx = { cihazIdOf, kanalToplam: () => KANAL_TOPLAM };
  const uye = new Asal({ tur: 'uye', ad: 'ali', kimlik: 'uye:ali', rol: 'kullanici', izinler: ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir'] }, ctx);
  assert.ok(uye.izinVar('canli.izle') && !uye.izinVar('cihaz.yonet'));
  assert.ok(uye.kanalIzinli(7) && uye.kapsamsiz());
  assert.equal(uye.gunlukAdi, 'ali');
  const anahtar = new Asal({ tur: 'anahtar', ad: 'mobil', kimlik: 'anahtar:ab12', anahtarId: 'ab12', izinler: ['canli.izle'], kapsam: { cihazlar: ['bbbb2222'] }, yontem: 'anahtar' }, ctx);
  assert.ok(anahtar.kanalIzinli(5) && !anahtar.kanalIzinli(1));
  assert.equal(anahtar.gunlukAdi, 'anahtar:ab12');
  assert.ok(anahtar.herhangiIzin(['kayit.izle', 'canli.izle']) && !anahtar.herhangiIzin(['kayit.izle']));
  assert.deepEqual(anahtar.acik().izinler, ['canli.izle']);
});

test('hız sınırı ve eşzamanlı akış: asal başına', () => {
  const { depo, temizle } = yeniDepo();
  ozelRoller(depo);
  try {
    const asal = new Asal({ tur: 'anahtar', kimlik: 'anahtar:z', hizLimiti: 2, eszamanliAkis: 1, izinler: ['canli.izle'] }, {});
    depo.hizDene(asal, 1000); depo.hizDene(asal, 1001);
    const e = (() => { try { depo.hizDene(asal, 1002); } catch (x) { return x; } })();
    assert.equal(e.kod, 'HIZ_SINIRI'); assert.equal(e.durum, 429); assert.ok(e.ekstra.yenidenDenemeSn >= 1);
    const birak = depo.akisAc(asal);
    assert.equal(hatakodu(() => depo.akisAc(asal)), 'AKIS_SINIRI');
    birak(); birak();                                  // ikinci çağrı zararsız
    const birak2 = depo.akisAc(asal); birak2();
    const sinirsiz = new Asal({ tur: 'uye', kimlik: 'uye:s', eszamanliAkis: 3, izinler: [] }, {});
    const b = [depo.akisAc(sinirsiz), depo.akisAc(sinirsiz), depo.akisAc(sinirsiz)];
    assert.equal(hatakodu(() => depo.akisAc(sinirsiz)), 'AKIS_SINIRI');
    b.forEach((f) => f());
    // ayni ortak akis (ikinci sekme) hak harcamaz; farkli akis harcar; son izleyici birakinca hak geri gelir
    const s1 = new Asal({ tur: 'uye', kimlik: 'uye:o', eszamanliAkis: 2, izinler: [] }, {});
    const o = [depo.akisAc(s1, 'canli:1'), depo.akisAc(s1, 'canli:1'), depo.akisAc(s1, 'canli:1'), depo.akisAc(s1, 'canli:2')];
    assert.equal(hatakodu(() => depo.akisAc(s1, 'canli:3')), 'AKIS_SINIRI');
    assert.equal(hatakodu(() => depo.akisAc(s1)), 'AKIS_SINIRI');
    const o2 = depo.akisAc(s1, 'canli:2'); o2();
    o[0](); o[1]();
    assert.equal(hatakodu(() => depo.akisAc(s1, 'canli:3')), 'AKIS_SINIRI');   // canli:1'in bir izleyicisi hala var
    o[2](); const o3 = depo.akisAc(s1, 'canli:3');
    o3(); o[3]();
    assert.equal(depo.akislar.has('uye:o'), false);
  } finally { temizle(); }
});
