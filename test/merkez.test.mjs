/**
 * Kimlik Yonetim Merkezi ile giris: sahte bir merkez (http) kurulur; PKCE akisi, hesap acma, rol eslemesi,
 * merkezin kapiyi kapatmasi (403), durum bildirimi (/api/kimlik/tazele) ve erisimin kalkmasi sinanir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uygulamaKur } from '../src/bootstrap.mjs';
import { yapilandirma as temel } from '../config/app.mjs';

const SIR = 'istemci-sirri', BILDIRIM = 'bildirim-sirri', ISTEMCI = 'kamera-istemci';
let merkezSunucu, M, uygulama, sunucu, B, veri;
/** Sahte merkezin davranisi; testler degistirir. */
const merkez = { meydan: null, kod: 'KOD-1', kullanici: { sub: '11111111-1111-7111-8111-111111111111', name: 'Ali Veli', email: 'ali.veli@ornek.test', email_verified: true, rol: 'admin', hesap_acilabilir: true }, yetkisiz: false, durum: { durum: 'aktif', girebilir: true, rol: 'admin' }, sorular: 0, cikislar: [] };

before(async () => {
  merkezSunucu = createServer(async (istek, res) => {
    const u = new URL(istek.url, 'http://x');
    const yanit = (k, j) => { res.writeHead(k, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/oauth/authorize') {
      merkez.meydan = u.searchParams.get('code_challenge');
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('client_id'), ISTEMCI);
      const geri = new URL(u.searchParams.get('redirect_uri')); geri.searchParams.set('code', merkez.kod); geri.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: geri.href }); return res.end();
    }
    if (u.pathname === '/oauth/token') {
      let g = ''; for await (const p of istek) g += p; const f = new URLSearchParams(g);
      if (f.get('client_secret') !== SIR || f.get('code') !== merkez.kod) return yanit(401, { error: 'invalid_client' });
      if (createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== merkez.meydan) return yanit(400, { error: 'invalid_grant' });
      return yanit(200, { access_token: 'JETON-1', token_type: 'Bearer' });
    }
    if (u.pathname === '/oauth/kullanici') {
      if (istek.headers.authorization !== 'Bearer JETON-1') return yanit(401, {});
      if (merkez.yetkisiz) return yanit(403, { kod: 'rol_yetkisiz', hata: 'Bu uygulamaya erişim yetkiniz yok.' });
      return yanit(200, merkez.kullanici);
    }
    if (u.pathname === '/api/oturum-kapandi') {
      let g = ''; for await (const p of istek) g += p; const j = JSON.parse(g);
      if (j.client_secret !== SIR) return yanit(401, {});
      merkez.cikislar.push(j.subject); return yanit(200, { sonuc: 'alındı' });
    }
    if (u.pathname === '/api/kimlik-durumu') {
      let g = ''; for await (const p of istek) g += p; const j = JSON.parse(g); merkez.sorular++;
      if (j.client_secret !== SIR) return yanit(401, {});
      return yanit(200, { kimlikler: Object.fromEntries(j.kimlikler.map((k) => [k, merkez.durum])) });
    }
    yanit(404, {});
  });
  merkezSunucu.listen(0, '127.0.0.1'); await new Promise((r) => merkezSunucu.once('listening', r));
  M = `http://127.0.0.1:${merkezSunucu.address().port}`;

  veri = mkdtempSync(join(tmpdir(), 'cam-merkez-'));
  const y = { ...temel, veriKlasoru: veri, sunucu: { ...temel.sunucu, port: 0, adres: '127.0.0.1' },
    cihaz: { ...temel.cihaz, test: true, tohum: JSON.stringify([{ ad: 'Sahte', tur: 'sahte', ana: '127.0.0.1', kullanici: 'a', parola: 'b', etiket: 'A' }]) },
    yetki: { ...temel.yetki, ilkAdminParola: 'adminparola1' },
    kimlik: { ...temel.kimlik, adres: M, istemci: ISTEMCI, sir: SIR, donus: '', bildirimSirri: BILDIRIM, dogrulamaDakika: 60, rolEsleme: {}, varsayilanRol: '' } };
  uygulama = await uygulamaKur(y);
  sunucu = uygulama.dinle(); await new Promise((r) => sunucu.once('listening', r));
  B = `http://127.0.0.1:${sunucu.address().port}`;
  y.kimlik.donus = `${B}/giris/merkez/geri`;   // donus adresi port bilinince yazilir (nesne paylasiliyor)
});
after(async () => { uygulama.kapat(); sunucu.close(); merkezSunucu.close(); rmSync(veri, { recursive: true, force: true }); });

const cerez = (r) => (r.headers.get('set-cookie') ?? '').split(',').map((c) => c.split(';')[0]).filter(Boolean);

/** Tam akis: baslat -> merkez -> geri. Oturum cerezini dondurur (ya da hata kodunu). */
async function merkezleGir() {
  const b = await fetch(`${B}/giris/merkez`, { redirect: 'manual' });
  assert.equal(b.status, 302);
  const akisCerezi = cerez(b).find((c) => c.startsWith('kamera_merkez_akis='));
  assert.ok(akisCerezi, 'akis cerezi yazilmali');
  const m = await fetch(b.headers.get('location'), { redirect: 'manual' });
  assert.equal(m.status, 302);
  const g = await fetch(m.headers.get('location'), { redirect: 'manual', headers: { Cookie: akisCerezi } });
  assert.equal(g.status, 302);
  const konum = g.headers.get('location');
  if (konum !== '/') return { hata: new URL(konum, B).searchParams.get('merkez') };
  return { oturum: cerez(g).find((c) => c.startsWith('kamera_oturum=')) };
}
const ben = (oturum) => fetch(`${B}/api/ben`, { headers: { Cookie: oturum } });

test('giris sayfasi merkez dugmesini cizer', async () => {
  const html = await (await fetch(`${B}/`)).text();
  assert.match(html, /href="\/giris\/merkez"/);
  const hatali = await (await fetch(`${B}/?merkez=yetki`)).text();
  assert.match(hatali, /erişim yetkiniz yok/);
});

test('state eslesmeyen donus reddedilir', async () => {
  const g = await fetch(`${B}/giris/merkez/geri?code=x&state=uydurma`, { redirect: 'manual' });
  assert.equal(g.status, 302); assert.equal(g.headers.get('location'), '/?merkez=durum');
});

test('merkezle giris: hesap acilir, rol eslenir, oturum calisir', async () => {
  const { oturum, hata } = await merkezleGir();
  assert.equal(hata, undefined); assert.ok(oturum);
  const r = await ben(oturum); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.ad, 'ali.veli@ornek.test'); assert.equal(j.rol, 'admin');
  // ikinci giris ayni hesaba baglanir, yeni hesap acmaz
  const ikinci = await merkezleGir(); assert.ok(ikinci.oturum);
  const uyeler = await (await fetch(`${B}/api/uyeler`, { headers: { Cookie: ikinci.oturum } })).json();
  assert.equal(uyeler.filter((u) => u.ad.startsWith('ali.veli')).length, 1);
});

test('merkez kapiyi kapatirsa (403) giris reddedilir', async () => {
  merkez.yetkisiz = true;
  try { const { hata } = await merkezleGir(); assert.equal(hata, 'yetki'); } finally { merkez.yetkisiz = false; }
});

test('hesap acilamaz denince yeni kimlik giremez', async () => {
  const eski = merkez.kullanici;
  merkez.kullanici = { ...eski, sub: '22222222-2222-7222-8222-222222222222', email: 'yeni@ornek.test', hesap_acilabilir: false };
  try { const { hata } = await merkezleGir(); assert.equal(hata, 'yetki'); } finally { merkez.kullanici = eski; }
});

test('merkezde erisim kalkinca bildirimle oturum duser; geri gelince acilir', async () => {
  const { oturum } = await merkezleGir();
  assert.equal((await ben(oturum)).status, 200);
  merkez.durum = { durum: 'askida', girebilir: false, rol: 'admin' };
  const imza = createHmac('sha256', BILDIRIM).update(merkez.kullanici.sub).digest('hex');
  // imzasiz bildirim merkeze sordurmaz: durum askida olsa da oturum surer
  const sorularOnce = merkez.sorular;
  await fetch(`${B}/api/kimlik/tazele`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: merkez.kullanici.sub }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(merkez.sorular, sorularOnce, 'imzasiz bildirim merkeze soru acmamali');
  assert.equal((await ben(oturum)).status, 200, 'imzasiz bildirim erisimi degistirmemeli');
  const t = await fetch(`${B}/api/kimlik/tazele`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kimlik-Imza': imza }, body: JSON.stringify({ subject: merkez.kullanici.sub }) });
  assert.equal(t.status, 200);
  await uygulama.hizmetler.baglar.tazele(merkez.kullanici.sub);
  assert.equal((await ben(oturum)).status, 401, 'erisimi kalkan kisi 401 almali');
  merkez.durum = { durum: 'aktif', girebilir: true, rol: 'network' };
  await uygulama.hizmetler.baglar.tazele(merkez.kullanici.sub);
  const r = await ben(oturum); assert.equal(r.status, 200);
  assert.equal((await r.json()).rol, 'network', 'merkezdeki rol degisince ayni adli DC rolu uygulanmali');
  merkez.durum = { durum: 'aktif', girebilir: true, rol: 'admin' };
  await uygulama.hizmetler.baglar.tazele(merkez.kullanici.sub);
});

test('yerel parola girisi merkezden bagimsiz calisir', async () => {
  const r = await fetch(`${B}/api/giris`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kamera': '1' }, body: JSON.stringify({ ad: 'admin', parola: 'adminparola1' }) });
  assert.equal(r.status, 200);
});

// ---- guvenlik denetimi duzeltmeleri ----
/** Yerel admin oturumu (parola girisi) ile yonetim istekleri. */
async function yerelAdmin() {
  const r = await fetch(`${B}/api/giris`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kamera': '1' }, body: JSON.stringify({ ad: 'admin', parola: 'adminparola1' }) });
  assert.equal(r.status, 200);
  const oturum = cerez(r).find((c) => c.startsWith('kamera_oturum='));
  return (yol, yontem = 'GET', govde) => fetch(`${B}${yol}`, { method: yontem, headers: { Cookie: oturum, 'X-Kamera': '1', ...(govde ? { 'Content-Type': 'application/json' } : {}) }, body: govde ? JSON.stringify(govde) : undefined });
}

test('merkezdeki kamera rolu panelde kamera rolune eslenir: izler, yonetemez', async () => {
  const eski = merkez.kullanici, eskiDurum = merkez.durum;
  merkez.kullanici = { ...eski, sub: '55555555-5555-7555-8555-555555555555', name: 'Kam Era', email: 'kam.era@ornek.test', rol: 'kamera' };
  merkez.durum = { durum: 'aktif', girebilir: true, rol: 'kamera' };
  try {
    const { oturum } = await merkezleGir(); assert.ok(oturum);
    const j = await (await ben(oturum)).json();
    assert.equal(j.rol, 'kamera');
    assert.equal((await fetch(`${B}/api/uyeler`, { headers: { Cookie: oturum } })).status, 403);
  } finally { merkez.kullanici = eski; merkez.durum = eskiDurum; }
});

test('kym-bag: silinen uyenin adi yeniden kullanilsa eski kimlik yeni hesabi devralamaz ve rolunu degistiremez', async () => {
  const eski = merkez.kullanici;
  merkez.kullanici = { ...eski, sub: '33333333-3333-7333-8333-333333333333', name: 'Zed Kim', email: 'zed.kim@ornek.test', rol: 'admin' };
  try {
    const ilk = await merkezleGir(); assert.ok(ilk.oturum);
    assert.equal((await (await ben(ilk.oturum)).json()).ad, 'zed.kim@ornek.test');
    const yonetim = await yerelAdmin();
    assert.equal((await yonetim('/api/uyeler/zed.kim@ornek.test', 'DELETE')).status, 200);
    assert.ok(!Object.values(uygulama.hizmetler.baglar.veri).some((b) => b.ad === 'zed.kim@ornek.test'), 'uye silinince bag da gider');
    assert.equal((await yonetim('/api/uyeler', 'POST', { ad: 'zed.kim@ornek.test', parola: 'zedparola12', rol: 'teknik' })).status, 200);
    const ikinci = await merkezleGir(); assert.ok(ikinci.oturum);
    const j = await (await ben(ikinci.oturum)).json();
    assert.notEqual(j.ad, 'zed.kim@ornek.test', 'eski kimlik yeni zed.kim hesabina girmemeli');
    const yerel = (await (await yonetim('/api/uyeler')).json()).find((u) => u.ad === 'zed.kim@ornek.test');
    assert.equal(yerel.rol, 'teknik', 'yeni hesabin rolu merkezdeki rolle ezilmemeli');
  } finally { merkez.kullanici = eski; }
});

test('kym-bag: merkezde erisimi kalkan uyenin API anahtari da islemez', async () => {
  const eski = merkez.kullanici, sub = '44444444-4444-7444-8444-444444444444';
  merkez.kullanici = { ...eski, sub, name: 'Key Owner', email: 'key.owner@ornek.test', rol: 'admin' };
  try {
    const { oturum } = await merkezleGir(); assert.ok(oturum);
    const yonetim = await yerelAdmin();
    const k = await (await yonetim('/api/yetki/anahtarlar', 'POST', { ad: 'k', izinler: ['canli.izle'], sahip: 'key.owner@ornek.test' })).json();
    const bearer = () => fetch(`${B}/api/v1/ben`, { headers: { Authorization: `Bearer ${k.anahtar}` } });
    assert.equal((await bearer()).status, 200);
    merkez.durum = { durum: 'askida', girebilir: false, rol: 'admin' };
    await uygulama.hizmetler.baglar.tazele(sub);
    assert.equal((await bearer()).status, 401, 'merkezde erisimi kalkan sahibin anahtari islememeli');
    merkez.durum = { durum: 'aktif', girebilir: true, rol: 'admin' };
    await uygulama.hizmetler.baglar.tazele(sub);
    assert.equal((await bearer()).status, 200);
  } finally { merkez.kullanici = eski; merkez.durum = { durum: 'aktif', girebilir: true, rol: 'admin' }; }
});

test('cerez etiketi: merkez akis cerezi oturum cerezi olarak, oturum cerezi akis cerezi olarak gecmez', async () => {
  const yonetim = await yerelAdmin();
  assert.equal((await yonetim('/api/uyeler', 'POST', { ad: 'undefined', parola: 'undefparola1', rol: 'teknik' })).status, 200);
  const b = await fetch(`${B}/giris/merkez`, { redirect: 'manual' });
  const akis = cerez(b).find((c) => c.startsWith('kamera_merkez_akis=')).split('=').slice(1).join('=');
  assert.equal((await ben(`kamera_oturum=${akis}`)).status, 401, "akis cerezi 'undefined' uyesine oturum vermemeli");
  const oturum = (await (await fetch(`${B}/api/giris`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kamera': '1' }, body: JSON.stringify({ ad: 'admin', parola: 'adminparola1' }) })).headers.get('set-cookie')).split(';')[0].split('=').slice(1).join('=');
  const g = await fetch(`${B}/giris/merkez/geri?code=x&state=y`, { redirect: 'manual', headers: { Cookie: `kamera_merkez_akis=${oturum}` } });
  assert.equal(g.headers.get('location'), '/?merkez=durum', 'oturum cerezi akis cerezi olarak kabul edilmemeli');
});

// ORTAK CIKIS: merkezdeki son cikistan once acilan oturum islemez; buradan cikis merkeze bildirilir.
const cikisBildir = (an, imza) => fetch(`${B}/api/kimlik/cikis`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kimlik-Imza': imza ?? createHmac('sha256', BILDIRIM).update(`cikis|${merkez.kullanici.sub}|${an}`).digest('hex') }, body: JSON.stringify({ subject: merkez.kullanici.sub, an }) });

test('merkezin imzali cikis bildirimi acik oturumu kapatir; sonra acilan oturum surer', async () => {
  const { oturum } = await merkezleGir();
  assert.equal((await ben(oturum)).status, 200);
  const an = Date.now() + 5;
  assert.equal((await cikisBildir(an, 'yanlis')).status, 200);
  assert.equal((await cikisBildir(an + 1, createHmac('sha256', BILDIRIM).update(`cikis|${merkez.kullanici.sub}|${an}`).digest('hex'))).status, 200);
  assert.equal((await ben(oturum)).status, 200, 'imzasi tutmayan (ya da baska an icin) bildirim oturumu kapatmamali');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await cikisBildir(an)).status, 200);
  const r = await ben(oturum); assert.equal(r.status, 401);
  assert.equal((await r.json()).kod, 'MERKEZ_CIKIS');
  const sayfa = await (await fetch(`${B}/`, { headers: { Cookie: oturum } })).text();
  assert.ok(sayfa.includes('gate__'), 'API 401 verirken ana sayfa paneli vermemeli: giris sayfasi gelmeli (yoksa sayfa durmadan yenilenir)');
  const { oturum: yeni } = await merkezleGir();
  assert.equal((await ben(yeni)).status, 200, 'cikistan sonra acilan oturum surmeli');
  await cikisBildir(an - 1000);
  assert.equal((await ben(yeni)).status, 200, 'gec gelen eski an yeni oturumu kapatmamali');
});

test('buradan cikis merkeze bildirilir', async () => {
  const { oturum } = await merkezleGir();
  merkez.cikislar.length = 0;
  const r = await fetch(`${B}/api/cikis`, { method: 'POST', headers: { Cookie: oturum, 'X-Kamera': '1' } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && !merkez.cikislar.length; i++) await new Promise((t) => setTimeout(t, 10));
  assert.deepEqual(merkez.cikislar, [merkez.kullanici.sub]);
});

test('durum sorgusundaki son_cikis uygulanir (bildirim kaybolsa da)', async () => {
  const { oturum } = await merkezleGir();
  await new Promise((r) => setTimeout(r, 5));
  merkez.durum = { durum: 'aktif', girebilir: true, rol: 'admin', son_cikis: Date.now() };
  try {
    await uygulama.hizmetler.baglar.tazele(merkez.kullanici.sub);
    assert.equal((await ben(oturum)).status, 401);
  } finally { merkez.durum = { durum: 'aktif', girebilir: true, rol: 'admin' }; }
});
