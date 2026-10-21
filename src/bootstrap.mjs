/**
 * Onyukleme (Laravel bootstrap/app.php karsiligi): hizmetleri kurar, denetleyicileri baglar, rotalari yukler, uygulamayi dondurur.
 * Giris noktasi bin/cam.mjs; testler de buradan uygulama kurar (gercek cihaz yerine sahte surucuyle).
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Uygulama } from './core/uygulama.mjs';
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
  // modeller
  const uyeler = new Uyelik(join(yapilandirma.veriKlasoru, 'kullanicilar.json'), join(yapilandirma.veriKlasoru, 'gizli.anahtar'));
  const yetki = new YetkiDeposu(join(yapilandirma.veriKlasoru, 'yetki.json'), uyeler.gizli, { rolKullanimda: (id) => uyeler.rolKullanimda(id) });
  uyeler.rolGecerli = (r) => yetki.rolVar(r);
  if (uyeler.bos()) {
    const parola = yapilandirma.yetki.ilkAdminParola || randomBytes(9).toString('base64url');
    uyeler.ekle('admin', parola, 'admin');
    if (!yapilandirma.yetki.ilkAdminParola) { writeFileSync(join(yapilandirma.veriKlasoru, 'ilk-admin.txt'), `Kullanıcı adı: admin\nParola: ${parola}\n\nGiriş yaptıktan sonra Üyeler sekmesinden parolayı değiştirin ve bu dosyayı silin.\n`, { mode: 0o600 }); console.log('İlk admin hesabı oluşturuldu: veri/ilk-admin.txt'); }
  }
  // hizmetler
  const cihazlar = new CihazHizmeti({ yapilandirma, gizli: uyeler.gizli });
  await cihazlar.sahteyiKaydet();
  cihazlar.baslat();
  const gunluk = new Gunluk(join(yapilandirma.veriKlasoru, 'gunluk.jsonl'), (m) => uyeler.imza(m), yapilandirma.sunucu.guvenilenIpBasligi);
  cihazlar.grup.olay = (olay, ayrinti) => gunluk.yaz(olay, 'sistem', null, ayrinti);
  // Kimlik Yonetim Merkezi: istemci (OAuth akisi) ve baglar (merkezdeki kimlik -> buradaki uye). Yapilandirilmamissa akis kapali, baglar bos.
  const merkez = new MerkezIstemcisi(yapilandirma.kimlik);
  const baglar = new MerkezBaglari(join(yapilandirma.veriKlasoru, 'merkez-baglari.json'), { merkez, uyeler, gunluk, yapilandirma });
  const live = new LiveHizmeti({ yapilandirma, cihazlar });
  const guncelleme = new GuncellemeHizmeti({ dosya: join(yapilandirma.veriKlasoru, 'guncelleme.json'), ayar: yapilandirma.guncelleme });
  const hizmetler = { uyeler, yetki, cihazlar, gunluk, yapilandirma, merkez, baglar, live, guncelleme };

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
  uygulama.kapat = () => { guncelleme.kapat(); live.kapat(); cihazlar.kapat(); yetki.kapat(); };
  return uygulama;
}
