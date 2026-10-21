/**
 * Onyukleme (Laravel bootstrap/app.php karsiligi): hizmetleri kurar, denetleyicileri baglar, rotalari yukler, uygulamayi dondurur.
 * Giris noktasi bin/cam.mjs; testler de buradan uygulama kurar (gercek cihaz yerine sahte surucuyle).
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Uygulama } from './core/uygulama.mjs';
import { Veritabani } from './core/database.mjs';
import { Ayarlar } from './core/tables.mjs';
import { anahtarIzi, gizliAnahtarCoz } from './core/secret-key.mjs';
import { eskiVeriyiAktar } from './database/import-legacy.mjs';
import { basliklar, csrf } from './middleware/guvenlik.mjs';
import { kimlikKur } from './middleware/kimlik.mjs';
import { Uyelik } from './models/uye.mjs';
import { YetkiDeposu } from './models/yetki.mjs';
import { CihazHizmeti } from './services/cihazlar.mjs';
import { LiveHizmeti } from './services/live.mjs';
import { Gunluk } from './services/gunluk.mjs';
import { GuncellemeHizmeti } from './services/guncelleme.mjs';
import { MerkezBaglari, MerkezIstemcisi } from './services/merkez.mjs';
import { merkezDenetleyici } from './controllers/merkez.mjs';
import { girisDenetleyici } from './controllers/giris.mjs';
import { uyelerDenetleyici } from './controllers/uyeler.mjs';
import { cihazlarDenetleyici } from './controllers/cihazlar.mjs';
import { akisDenetleyici } from './controllers/akis.mjs';
import { yetkiDenetleyici } from './controllers/yetki.mjs';
import { gunlukDenetleyici } from './controllers/gunluk.mjs';
import { guncellemeDenetleyici } from './controllers/guncelleme.mjs';
import { gorunumDenetleyici } from './controllers/gorunum.mjs';
import { liveDenetleyici } from './controllers/live.mjs';
import { webRotalari } from '../routes/web.mjs';
import { apiRotalari } from '../routes/api.mjs';
import { apiV1Rotalari } from '../routes/api-v1.mjs';

export async function uygulamaKur(yapilandirma) {
  mkdirSync(yapilandirma.veriKlasoru, { recursive: true });
  // veritabani: gelene kadar bekler, gocleri kosturur, eski JSON verisini (varsa) bir kez aktarir
  const vt = await new Veritabani(yapilandirma.veritabani).baglan({ beklemeSn: yapilandirma.veritabani.beklemeSn });
  try { return await uygulamaKurVt(yapilandirma, vt); } catch (e) { await vt.kapat(); throw e; }
}

async function uygulamaKurVt(yapilandirma, vt) {
  await vt.gocYap();
  const ayarlar = new Ayarlar(vt);
  const gizli = gizliAnahtarCoz({ ortam: yapilandirma.gizliAnahtar, dosya: join(yapilandirma.veriKlasoru, 'gizli.anahtar') });
  // Bu veritabani baska bir anahtarla dolduysa acilis durur: yanlis anahtarla cihaz parolalari cozulemez, oturumlar ve gunluk imzalari tutmaz.
  const iz = anahtarIzi(gizli), kayitliIz = await ayarlar.oku('key-fingerprint');
  if (kayitliIz !== undefined && kayitliIz !== iz) throw new Error('Gizli anahtar bu veritabanını dolduran anahtarla aynı değil (KAMERA_GIZLI_ANAHTAR ya da veri/gizli.anahtar). Doğru anahtarı verin; anahtar kaybolduysa kayıtlı cihaz parolaları yeniden girilmelidir.');
  await eskiVeriyiAktar({ vt, veriKlasoru: yapilandirma.veriKlasoru, gizli });
  if (kayitliIz === undefined) await ayarlar.yaz('key-fingerprint', iz);
  // modeller (veritabanindan bellege)
  const uyeler = await new Uyelik(vt, gizli).yukle();
  const yetki = await new YetkiDeposu(vt, uyeler.gizli, { rolKullanimda: (id) => uyeler.rolKullanimda(id) }).yukle();
  uyeler.rolGecerli = (r) => yetki.rolVar(r);
  if (uyeler.bos()) {
    const parola = yapilandirma.yetki.ilkAdminParola || randomBytes(9).toString('base64url');
    await uyeler.ekle('admin', parola, 'admin');
    if (!yapilandirma.yetki.ilkAdminParola) { writeFileSync(join(yapilandirma.veriKlasoru, 'ilk-admin.txt'), `Kullanıcı adı: admin\nParola: ${parola}\n\nGiriş yaptıktan sonra Üyeler sekmesinden parolayı değiştirin ve bu dosyayı silin.\n`, { mode: 0o600 }); console.log('İlk admin hesabı oluşturuldu: veri/ilk-admin.txt'); }
  }
  // hizmetler
  const cihazlar = new CihazHizmeti({ yapilandirma, gizli: uyeler.gizli, vt, ayarlar });
  await cihazlar.sahteyiKaydet();
  await cihazlar.baslat();
  const gunluk = await new Gunluk(vt, (m) => uyeler.imza(m), yapilandirma.sunucu.guvenilenIpBasligi).yukle();
  cihazlar.grup.olay = (olay, ayrinti) => gunluk.yaz(olay, 'sistem', null, ayrinti);
  // Kimlik Yonetim Merkezi: istemci (OAuth akisi) ve baglar (merkezdeki kimlik -> buradaki uye). Yapilandirilmamissa akis kapali, baglar bos.
  const merkez = new MerkezIstemcisi(yapilandirma.kimlik);
  const baglar = await new MerkezBaglari(vt, { merkez, uyeler, gunluk, yapilandirma }).yukle();
  const live = await new LiveHizmeti({ yapilandirma, cihazlar, ayarlar }).yukle();
  const guncelleme = await new GuncellemeHizmeti({ ayarlar, ayar: yapilandirma.guncelleme }).yukle();
  const hizmetler = { vt, uyeler, yetki, cihazlar, gunluk, yapilandirma, merkez, baglar, live, guncelleme };

  // denetleyiciler + ara katmanlar
  const d = {
    giris: girisDenetleyici(hizmetler), uyeler: uyelerDenetleyici(hizmetler), cihazlar: cihazlarDenetleyici(hizmetler),
    akis: akisDenetleyici(hizmetler), yetki: yetkiDenetleyici(hizmetler), gunluk: gunlukDenetleyici(hizmetler), gorunum: gorunumDenetleyici(hizmetler),
    merkez: merkezDenetleyici(hizmetler), live: liveDenetleyici(hizmetler), guncelleme: guncellemeDenetleyici(hizmetler),
  };
  const ara = kimlikKur(hizmetler);

  const uygulama = new Uygulama({ yapilandirma, hizmetler });
  uygulama.kullan(basliklar).kullan(csrf);
  webRotalari(uygulama.yonlendirici, d, ara);
  apiRotalari(uygulama.yonlendirici, d, ara);
  apiV1Rotalari(uygulama.yonlendirici, d, ara, hizmetler);
  live.baslat();
  guncelleme.baslat();
  // Kapanis: bekleyen gunluk yazimlari ve ertelenmis yetki yazimi veritabanina islenir, sonra havuz kapanir.
  uygulama.kapat = async () => { guncelleme.kapat(); live.kapat(); cihazlar.kapat(); await yetki.kapat(); await gunluk.bekle(); await vt.kapat(); };
  return uygulama;
}
