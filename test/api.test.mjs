/**
 * API + guvenlik entegrasyon testleri: uygulama sahte cihazla, gecici veri klasorunde, rastgele portta kurulur.
 * Kapsam: CSRF, oturum, roller/izinler (403), kapsam disi kanal (403), API anahtari (olusturma/IP/sure/iptal/yenileme/hiz siniri/kaba kuvvet),
 * yol gecisi, govde siniri, guvenlik basliklari, gunluk zinciri.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uygulamaKur } from '../src/bootstrap.mjs';
import { yapilandirma as temel } from '../config/app.mjs';
import { gecicivt } from './helpers.mjs';

let sunucu, uygulama, B, veri, gv;
const cerezler = new Map();
const istek = async (yol, { yontem = 'GET', govde, kim = 'admin', bearer, basliklar = {}, csrf = true, ham = false } = {}) => {
  const h = { ...basliklar };
  if (govde !== undefined) { h['Content-Type'] = 'application/json'; }
  if (csrf && !bearer) h['X-Kamera'] = '1';
  if (bearer) h.Authorization = `Bearer ${bearer}`; else if (kim && cerezler.get(kim)) h.Cookie = cerezler.get(kim);
  const r = await fetch(B + yol, { method: yontem, headers: h, body: govde === undefined ? undefined : (typeof govde === 'string' ? govde : JSON.stringify(govde)), redirect: 'manual' });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie && kim) cerezler.set(kim, setCookie.split(';')[0]);
  const metin = await r.text();
  let json = null; try { json = JSON.parse(metin); } catch {}
  return { durum: r.status, json, metin, basliklar: r.headers };
};
const giris = async (ad, parola) => { const r = await istek('/api/giris', { yontem: 'POST', govde: { ad, parola }, kim: ad }); assert.equal(r.durum, 200, r.metin); return r; };

before(async () => {
  veri = mkdtempSync(join(tmpdir(), 'cam-api-'));
  gv = await gecicivt();
  const y = { ...temel, veriKlasoru: veri, veritabani: gv.ayar, sunucu: { ...temel.sunucu, port: 0, adres: '127.0.0.1' }, cihaz: { ...temel.cihaz, test: true, tohum: JSON.stringify([{ ad: 'Sahte A', tur: 'sahte', ana: '127.0.0.1', kullanici: 'a', parola: 'b', etiket: 'A' }, { ad: 'Sahte B', tur: 'sahte', ana: '127.0.0.2', kullanici: 'a', parola: 'b', etiket: 'B' }]) }, yetki: { ...temel.yetki, ilkAdminParola: 'adminparola1' } };
  uygulama = await uygulamaKur(y);
  sunucu = uygulama.dinle();
  await new Promise((r) => sunucu.once('listening', r));
  B = `http://127.0.0.1:${sunucu.address().port}`;
  await giris('admin', 'adminparola1');
  // Eski yerlesik roller artik ozel rol: sinamalarin kullandigi izin kumeleri burada kurulur.
  for (const [id, izinler] of [['kullanici', ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir']], ['izleyici', ['canli.izle']], ['operator', ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir', 'cihaz.oku', 'cihaz.saat', 'kanal.yonet']]]) {
    const r = await istek('/api/yetki/roller', { yontem: 'POST', govde: { id, ad: id, izinler } }); assert.equal(r.durum, 200, r.metin);
  }
});
after(async () => { sunucu.close(); await uygulama.kapat(); await gv.sil(); rmSync(veri, { recursive: true, force: true }); });

test('güvenlik başlıkları her yanıtta', async () => {
  const r = await istek('/api/v1/saglik', { kim: null });
  assert.equal(r.durum, 200);
  for (const b of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) assert.ok(r.basliklar.get(b), b);
});

test('CSRF: çerezli POST X-Kamera başlığı olmadan reddedilir; Bearer ile gerekmez', async () => {
  const r = await istek('/api/cikis', { yontem: 'POST', csrf: false });
  assert.equal(r.durum, 403); assert.equal(r.json.kod, 'CSRF');
  const r2 = await istek('/api/giris', { yontem: 'POST', govde: { ad: 'admin', parola: 'adminparola1' }, csrf: false, kim: null });
  assert.equal(r2.durum, 403);
});

test('oturum: kimliksiz 401, yanlış parola 401, kilit', async () => {
  assert.equal((await istek('/api/ben', { kim: null })).durum, 401);
  assert.equal((await istek('/api/ben', { kim: null })).json.kod, 'OTURUM_GEREKLI');
  const r = await istek('/api/giris', { yontem: 'POST', govde: { ad: 'admin', parola: 'yanlis' }, kim: null });
  assert.equal(r.durum, 401);
  assert.equal((await istek('/api/ben')).json.ad, 'admin');
});

test('rol ve izin: kullanıcı yalnız izler; yönetim uçları 403 ve gerekenIzin döner', async () => {
  const u = await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'ali', parola: 'aliparola1', rol: 'kullanici' } });
  assert.equal(u.durum, 200, u.metin);
  await giris('ali', 'aliparola1');
  assert.equal((await istek('/api/bilgi', { kim: 'ali' })).durum, 200);
  assert.equal((await istek('/api/kayitlar?kanal=0&gun=2026-10-05', { kim: 'ali' })).durum, 200);
  for (const [yol, yontem, izin] of [['/api/uyeler', 'GET', 'uye.yonet'], ['/api/gunluk', 'GET', 'gunluk.oku'], ['/api/cihazlar', 'GET', 'cihaz.oku'], ['/api/yetki/roller', 'POST', 'yetki.yonet'], ['/api/kanallar', 'PUT', 'kanal.yonet'], ['/api/dvr/saat', 'POST', 'cihaz.saat']]) {
    const r = await istek(yol, { kim: 'ali', yontem, govde: yontem === 'GET' ? undefined : {} });
    assert.equal(r.durum, 403, `${yontem} ${yol}: ${r.metin}`); assert.equal(r.json.kod, 'YETKI_YOK'); assert.equal(r.json.gerekenIzin, izin);
  }
  // izleyici: kayıt izleyemez
  await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'veli', parola: 'veliparola1', rol: 'izleyici' } });
  await giris('veli', 'veliparola1');
  assert.equal((await istek('/akis/oynat?kanal=0&bas=2026-10-05 10:00:00&bit=2026-10-05 10:05:00', { kim: 'veli' })).durum, 403);
  assert.equal((await istek('/api/goruntu?kanal=0', { kim: 'veli' })).durum, 200);
});

test('kapsam: üye yalnız kapsamındaki kameraları görür ve kullanır', async () => {
  const cihazlar = (await istek('/api/cihazlar')).json.cihazlar;
  const b = cihazlar.find((c) => c.ad === 'Sahte B');
  const r = await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'ayse', parola: 'ayseparola1', rol: 'kullanici', kapsam: { cihazlar: [b.id] } } });
  assert.equal(r.durum, 200, r.metin);
  await giris('ayse', 'ayseparola1');
  const bilgi = (await istek('/api/bilgi', { kim: 'ayse' })).json;
  assert.deepEqual(bilgi.kanalBos.slice(0, 4), [true, true, true, true]);        // A cihazı gizli
  assert.deepEqual(bilgi.kanalBos.slice(4, 8), [false, false, false, false]);
  assert.equal(bilgi.cihazlar.length, 1);
  const dis = await istek('/api/kayitlar?kanal=0&gun=2026-10-05', { kim: 'ayse' });
  assert.equal(dis.durum, 403); assert.equal(dis.json.kod, 'KAPSAM_DISI');
  assert.equal((await istek('/api/kayitlar?kanal=5&gun=2026-10-05', { kim: 'ayse' })).durum, 200);
  assert.equal((await istek('/api/goruntu?kanal=1', { kim: 'ayse' })).durum, 403);
  const v1 = (await istek('/api/v1/kameralar', { kim: 'ayse' })).json.kameralar;
  assert.ok(v1.every((k) => k.kanal >= 4) && v1.length === 4);
});

test('yetki yükseltme: üye yöneten, kendi izninin üstünde rol veremez; kapsamlı yönetici kapsam dışına üye açamaz', async () => {
  await istek('/api/yetki/roller', { yontem: 'POST', govde: { id: 'uyeci', ad: 'Üyeci', izinler: ['uye.yonet', 'canli.izle'] } });
  await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'uyeci1', parola: 'uyeciparola1', rol: 'uyeci' } });
  await giris('uyeci1', 'uyeciparola1');
  const r = await istek('/api/uyeler', { kim: 'uyeci1', yontem: 'POST', govde: { ad: 'yeni1', parola: 'yeniparola1', rol: 'admin' } });
  assert.equal(r.durum, 403); assert.equal(r.json.kod, 'YETKI_YUKSELTME');
  assert.equal((await istek('/api/uyeler', { kim: 'uyeci1', yontem: 'POST', govde: { ad: 'yeni1', parola: 'yeniparola1', rol: 'izleyici' } })).durum, 200);
  assert.equal((await istek('/api/uyeler/yeni1', { kim: 'uyeci1', yontem: 'PATCH', govde: { rol: 'operator' } })).json.kod, 'YETKI_YUKSELTME');
  // kapsamlı yönetici
  const a = (await istek('/api/cihazlar')).json.cihazlar.find((c) => c.ad === 'Sahte A');
  await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'uyeci2', parola: 'uyeciparola2', rol: 'uyeci', kapsam: { cihazlar: [a.id] } } });
  await giris('uyeci2', 'uyeciparola2');
  assert.equal((await istek('/api/uyeler', { kim: 'uyeci2', yontem: 'POST', govde: { ad: 'yeni2', parola: 'yeniparola2', rol: 'izleyici' } })).json.kod, 'YETKI_YUKSELTME');       // kapsamsız üye
  assert.equal((await istek('/api/uyeler', { kim: 'uyeci2', yontem: 'POST', govde: { ad: 'yeni2', parola: 'yeniparola2', rol: 'izleyici', kapsam: { kanallar: [5] } } })).json.kod, 'YETKI_YUKSELTME');
  assert.equal((await istek('/api/uyeler', { kim: 'uyeci2', yontem: 'POST', govde: { ad: 'yeni2', parola: 'yeniparola2', rol: 'izleyici', kapsam: { kanallar: [1, 2] } } })).durum, 200);
  // son admin korunur
  assert.equal((await istek('/api/uyeler/admin', { yontem: 'PATCH', govde: { rol: 'kullanici' } })).durum, 400);
  assert.equal((await istek('/api/uyeler/admin', { yontem: 'DELETE' })).durum, 400);
});

let anahtar, anahtarId;
test('API anahtarı: oluşturma bir kez gösterir, Bearer ile çalışır, dosyada düz metin yok', async () => {
  const r = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'entegrasyon', rol: 'kullanici', kapsam: { kanallar: [0, 1] }, hizLimiti: 50, eszamanliAkis: 1 } });
  assert.equal(r.durum, 200, r.metin);
  anahtar = r.json.anahtar; anahtarId = r.json.kayit.id;
  assert.match(anahtar, /^kp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(await uygulama.hizmetler.vt.sorgu('SELECT * FROM api_keys')).includes(anahtar.slice('kp_12345678_'.length)));
  const ben = await istek('/api/v1/ben', { bearer: anahtar });
  assert.equal(ben.durum, 200); assert.equal(ben.json.tur, 'anahtar'); assert.ok(ben.json.izinler.includes('kayit.indir'));
  assert.equal((await istek('/api/v1/kameralar/0/kayitlar?gun=2026-10-05', { bearer: anahtar })).durum, 200);
  assert.equal((await istek('/api/v1/kameralar/3/kayitlar?gun=2026-10-05', { bearer: anahtar })).json.kod, 'KAPSAM_DISI');
  assert.equal((await istek('/api/v1/uyeler', { bearer: anahtar })).durum, 403);
  // listede gizli yok, son kullanım var
  const l = (await istek('/api/yetki/anahtarlar')).json.find((a) => a.id === anahtarId);
  assert.equal(l.karma, undefined); assert.ok(l.sonKullanim); assert.ok(l.sayac >= 1);
  // yanlış anahtar 401; biçimsiz 401
  assert.equal((await istek('/api/v1/ben', { bearer: anahtar.slice(0, -2) + 'zz' })).durum, 401);
  assert.equal((await istek('/api/v1/ben', { bearer: 'abc' })).durum, 401);
});

test('API anahtarı: api.anahtar izni yalnız kendi anahtarlarını görür/yönetir; yükseltme engeli', async () => {
  await istek('/api/yetki/roller', { yontem: 'POST', govde: { id: 'entegrator', ad: 'Entegratör', izinler: ['canli.izle', 'api.anahtar'] } });
  await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'ent', parola: 'entparola1', rol: 'entegrator' } });
  await giris('ent', 'entparola1');
  assert.equal((await istek('/api/yetki/anahtarlar', { kim: 'ent' })).json.length, 0);                  // admin'in anahtarı görünmez
  assert.equal((await istek(`/api/yetki/anahtarlar/${anahtarId}`, { kim: 'ent' })).durum, 403);
  const yuk = await istek('/api/yetki/anahtarlar', { kim: 'ent', yontem: 'POST', govde: { ad: 'x', rol: 'kullanici' } });
  assert.equal(yuk.json.kod, 'YETKI_YUKSELTME');
  const ok = await istek('/api/yetki/anahtarlar', { kim: 'ent', yontem: 'POST', govde: { ad: 'kendi', izinler: ['canli.izle'] } });
  assert.equal(ok.durum, 200, ok.metin); assert.equal(ok.json.kayit.sahip, 'ent');
  assert.equal((await istek('/api/yetki/anahtarlar', { kim: 'ent' })).json.length, 1);
  assert.equal((await istek('/api/yetki/anahtarlar', { kim: 'ent', yontem: 'POST', govde: { ad: 'baskasi', izinler: ['canli.izle'], sahip: 'admin' } })).json.kayit.sahip, 'ent');
});

test('API anahtarı: IP listesi, bitiş, iptal, yenileme, hız sınırı, eşzamanlı akış', async () => {
  // IP listesi: test istemcisi 127.0.0.1
  const r = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'ipli', rol: 'izleyici', ipler: ['10.9.9.0/24'] } });
  assert.equal((await istek('/api/v1/ben', { bearer: r.json.anahtar })).json.kod, 'IP_ENGELLI');
  await istek(`/api/yetki/anahtarlar/${r.json.kayit.id}`, { yontem: 'PATCH', govde: { ipler: ['127.0.0.1'] } });
  assert.equal((await istek('/api/v1/ben', { bearer: r.json.anahtar })).durum, 200);
  // bitiş geçmişte reddedilir
  assert.equal((await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'b', rol: 'izleyici', bitis: '2001-01-01' } })).durum, 400);
  // yenileme: eski geçersiz
  const y = await istek(`/api/yetki/anahtarlar/${r.json.kayit.id}/yenile`, { yontem: 'POST' });
  assert.equal((await istek('/api/v1/ben', { bearer: r.json.anahtar })).durum, 401);
  assert.equal((await istek('/api/v1/ben', { bearer: y.json.anahtar })).durum, 200);
  // iptal
  await istek(`/api/yetki/anahtarlar/${r.json.kayit.id}/iptal`, { yontem: 'POST' });
  assert.equal((await istek('/api/v1/ben', { bearer: y.json.anahtar })).json.kod, 'ANAHTAR_IPTAL');
  // hız sınırı: 3 istek/dk
  const h = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'hiz', rol: 'izleyici', hizLimiti: 3, eszamanliAkis: 1 } });
  for (let i = 0; i < 3; i++) assert.equal((await istek('/api/v1/ben', { bearer: h.json.anahtar })).durum, 200);
  const sinir = await istek('/api/v1/ben', { bearer: h.json.anahtar });
  assert.equal(sinir.durum, 429); assert.equal(sinir.json.kod, 'HIZ_SINIRI'); assert.ok(sinir.basliklar.get('retry-after'));
  // eşzamanlı akış: 1 → ikinci akış 429 (ayrı anahtar, sınır 1)
  const e = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'akis', rol: 'izleyici', eszamanliAkis: 1, hizLimiti: 100 } });
  const ac = new AbortController();
  const birinci = fetch(`${B}/api/v1/kameralar/0/canli?ham=1`, { headers: { Authorization: `Bearer ${e.json.anahtar}` }, signal: ac.signal });
  await new Promise((r2) => setTimeout(r2, 300));
  const ikinci = await istek('/api/v1/kameralar/1/canli?ham=1', { bearer: e.json.anahtar });
  assert.equal(ikinci.durum, 429); assert.equal(ikinci.json.kod, 'AKIS_SINIRI');
  ac.abort(); await birinci.catch(() => {});
});

test('kaba kuvvet: 10 geçersiz anahtardan sonra IP kilitlenir (doğru anahtar bile 429)', async () => {
  for (let i = 0; i < 10; i++) await istek('/api/v1/ben', { bearer: 'kp_00000000_' + 'A'.repeat(43) });
  const r = await istek('/api/v1/ben', { bearer: anahtar });
  assert.equal(r.durum, 429); assert.equal(r.json.kod, 'COK_FAZLA_DENEME');
  uygulama.hizmetler.yetki.hata.basari('127.0.0.1');        // testin devamı için kilidi aç
  assert.equal((await istek('/api/v1/ben', { bearer: anahtar })).durum, 200);
});

test('jeton kaldırıldı: kj1 Bearer ve ?jeton= kimlik sayılmaz, uç yok', async () => {
  assert.equal((await istek('/api/v1/ben', { bearer: 'kj1.e30.abc', kim: null })).durum, 401);
  assert.equal((await istek('/api/v1/ben?jeton=kj1.e30.abc', { kim: null })).durum, 401);
  assert.equal((await istek('/api/v1/jetonlar', { bearer: anahtar, yontem: 'POST', govde: {} })).durum, 404);
  assert.equal((await istek('/api/yetki/jeton', { yontem: 'POST', govde: {} })).durum, 404);
});

test('girdi güvenliği: yol geçişi, bozuk JSON, büyük gövde, bilinmeyen rota, yöntem', async () => {
  assert.equal((await istek('/css/../../package.json', { kim: null })).durum, 404);
  assert.equal((await istek('/css/..%2F..%2Fpackage.json', { kim: null })).durum, 404);
  assert.equal((await istek('/dokuman/..%2Fpackage.json', { kim: null })).durum, 401);       // dokuman oturum ister
  assert.equal((await istek('/dokuman/..%2Fpackage.json')).durum, 404);                       // oturumlu da yol gecisi yok
  assert.equal((await istek('/api/indir-akis?kanal=0&dosya=/../etc/passwd.h264&bas=2026-10-05 10:00:00&bit=2026-10-05 10:01:00')).durum, 400);
  const bozuk = await istek('/api/uyeler', { yontem: 'POST', govde: '{bozuk' });
  assert.equal(bozuk.durum, 400); assert.equal(bozuk.json.kod, 'GECERSIZ_JSON');
  const buyuk = await istek('/api/uyeler', { yontem: 'POST', govde: JSON.stringify({ ad: 'x'.repeat(1_100_000) }) });
  assert.ok([413, 400].includes(buyuk.durum));
  assert.equal((await istek('/api/yok', { kim: null })).durum, 404);
  assert.equal((await istek('/api/ben', { yontem: 'DELETE' })).durum, 405);
  // kanal sınırı
  assert.equal((await istek('/api/kayitlar?kanal=999&gun=2026-10-05')).durum, 400);
});

test('cihaz yönetimi ve günlük: parola sızmaz, zincir doğrulanır, olaylar yazılır', async () => {
  const c = await istek('/api/cihazlar', { yontem: 'POST', govde: { ad: 'Sahte C', tur: 'sahte', ana: '127.0.0.3', kullanici: 'u', parola: 'gizliparola', etiket: 'C' } });
  assert.equal(c.durum, 200, c.metin);
  assert.ok(!JSON.stringify((await istek('/api/cihazlar')).json).includes('gizliparola'));
  await uygulama.hizmetler.gunluk.bekle();
  const vt = uygulama.hizmetler.vt;
  assert.ok(!JSON.stringify(await vt.sorgu('SELECT * FROM devices')).includes('gizliparola'));
  assert.ok(!JSON.stringify(await vt.sorgu('SELECT * FROM audit_log')).includes('gizliparola'));
  // anahtarla yapılan işlem günlüğe anahtar:<id> adıyla yazılır
  const ak = await istek('/api/yetki/anahtarlar', { yontem: 'POST', govde: { ad: 'otomasyon', izinler: ['api.anahtar'] } });
  const alt = await istek('/api/v1/anahtarlar', { bearer: ak.json.anahtar, yontem: 'POST', govde: { ad: 'alt', izinler: ['api.anahtar'] } });
  assert.equal(alt.durum, 200, alt.metin);
  const g = (await istek('/api/gunluk?boyut=200')).json;
  const olaylar = new Set(g.kayitlar.map((k) => k.olay));
  for (const o of ['giris', 'giris-hata', 'uye-ekle', 'rol-ekle', 'anahtar-olustur', 'anahtar-iptal', 'cihaz-ekle']) assert.ok(olaylar.has(o), o);
  assert.ok(g.kayitlar.some((k) => k.kullanici === `anahtar:${ak.json.kayit.id}` && k.olay === 'anahtar-olustur'));
  assert.equal((await istek('/api/gunluk/dogrula')).json.tamam, true);
  assert.equal((await istek('/api/v1/cihazlar/bilgi')).json.cihazlar.length, 3);
  assert.equal((await istek(`/api/cihazlar/${c.json.id}`, { yontem: 'DELETE' })).durum, 200);
});

test('rota listesi: HER rota kimlik ister; kimliksiz yalnız giriş sayfasının ihtiyacı ve açık istisnalar', async () => {
  // /api/kimlik/tazele: merkezden gelen bildirim; kimligi HMAC imzasi (bkz. merkez.test.mjs), cerez/anahtar degil.
  // /api/v1/saglik: yalniz dongu adresinden yanit verir (HEALTHCHECK). Digerleri giris sayfasi: ana sayfa (oturum yoksa giris formu), css/js/font/simge, merkez ile giris akisi.
  const acik = new Set(['/api/giris', '/api/cikis', '/api/kimlik/tazele', '/api/kimlik/cikis', '/api/v1/saglik', '/', '/index.html', '/simge.svg', '/css/:a', '/css/:a/:b', '/css/:a/:b/:c', '/fonts/:a', '/js/:a', '/js/:a/:b', '/js/:a/:b/:c', '/giris/merkez', '/giris/merkez/geri',
    // /live: UYELIKSIZ izleme. Yalniz okuma: sayfa, kendi betik/stili, kamera adlari (adres yok), ortak duzen,
    // "admin miyim" sorusu. Duzeni yazmak (/live/duzen, PUT) kimlik ister ve bu listede DEGIL.
    // /live/rtc/:yol/whep: izleme baglantisi (SDP alisverisi); yalniz panelin listeledigi yollar, mediamtx'te okuma izni.
    '/live', '/live/kameralar.json', '/live/duzen.json', '/live/yetki', '/live/:dosya', '/live/rtc/:yol/whep']);
  const rotalar = uygulama.yonlendirici.liste();
  for (const r of rotalar) {
    if (acik.has(r.kalip)) continue;
    assert.ok(r.aralar.includes('kimlik'), `${r.kalip} kimlik ara katmanı yok`);
    if (r.kalip.startsWith('/api') || r.kalip.startsWith('/akis')) assert.ok(r.aralar.some((a) => a.startsWith('izin:')) || ['/api/ben', '/api/v1/ben', '/api/v1'].includes(r.kalip), `${r.kalip} izin ara katmanı yok`);
  }
  for (const k of ['/dokuman', '/dokuman/:dosya', '/api/v1']) assert.ok(rotalar.some((r) => r.kalip === k), k);
});

/**
 * Oynatma yuvalari: (1) ayni kisi ayni kanalda art arda atlarsa eski akis yenisinden once kapanir, 503 olmaz;
 * (2) bir cihaz doluyken obur cihazdan oynatma acilir (kontrol hedef cihaza yapilir).
 */
test('oynatma: hızlı atlama 503 vermez, dolu cihaz öbürünü engellemez', async () => {
  const kanallar = (await istek('/api/v1/kameralar')).json.kameralar;
  const ilkCihaz = kanallar[0].cihaz;
  const a = kanallar.filter((k) => k.cihaz === ilkCihaz).map((k) => k.kanal).slice(0, 4);
  const b = kanallar.find((k) => k.cihaz !== ilkCihaz).kanal;
  assert.equal(a.length, 4);
  const cerez = cerezler.get('admin');
  const ac = (kanal, saat) => { const ctrl = new AbortController(); const p = fetch(`${B}/akis/oynat?kanal=${kanal}&bas=2026-10-12%2010:${saat}:00&bit=2026-10-12%2010:59:59`, { headers: { Cookie: cerez }, signal: ctrl.signal }); return { ctrl, p }; };
  const ilk = a.map((k) => ac(k, '00'));
  const ilkYanit = await Promise.all(ilk.map((x) => x.p));
  assert.deepEqual(ilkYanit.map((r) => r.status), [200, 200, 200, 200]);
  // ayni kanallarda hemen yeni istek: eskileri istemci kapatmadan once gelir
  const ikinci = a.map((k) => ac(k, '05'));
  const ikinciYanit = await Promise.all(ikinci.map((x) => x.p));
  assert.deepEqual(ikinciYanit.map((r) => r.status), [200, 200, 200, 200], 'ayni kanalda atlama 503 vermemeli');
  // A dolu (4/4); B'den oynatma acilabilmeli
  const bYanit = await ac(b, '00').p;
  assert.equal(bYanit.status, 200, 'dolu cihaz obur cihazi engellememeli');
  for (const x of [...ilk, ...ikinci]) x.ctrl.abort();
  try { await bYanit.body?.cancel(); } catch {}
  await new Promise((r) => setTimeout(r, 100));
});
