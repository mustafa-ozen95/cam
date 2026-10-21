/**
 * Uygulama yapilandirmasi (Laravel config/app.php karsiligi). Tum ortam degiskenleri BURADA okunur; baska dosya process.env'e bakmaz.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sayi = (v, varsayilan) => (v === undefined || v === '' ? varsayilan : Number(v));
const env = process.env;
/** Tek satirlik dosya (imajdaki SURUM gibi); yoksa bos. */
const dosyaSatiri = (yol) => { try { return readFileSync(yol, 'utf8').trim(); } catch { return ''; } };

export const yapilandirma = Object.freeze({
  kok: KOK,
  veriKlasoru: env.KAMERA_VERI ?? join(KOK, 'veri'),
  gorunumler: join(KOK, 'resources', 'views', 'web'),
  dokumanKlasoru: join(KOK, 'docs'),

  sunucu: {
    port: sayi(env.KAMERA_PORT, 8191),
    adres: env.KAMERA_ADRES ?? '0.0.0.0',
    baslik: env.KAMERA_BASLIK || 'Kamera Paneli',
    tls: env.KAMERA_TLS_CERT && env.KAMERA_TLS_KEY ? { cert: env.KAMERA_TLS_CERT, key: env.KAMERA_TLS_KEY, port: sayi(env.KAMERA_TLS_PORT, 8443) } : null,
    /** Ters vekil (Cloudflare/nginx) arkasindaysa gercek IP bu basliktan okunur; dogrudan erisimde BOS birakin (taklit edilebilir). */
    guvenilenIpBasligi: env.KAMERA_IP_BASLIGI || '',
    /**
     * TLS'i bitiren vekilin arkasinda (Caddy/nginx): cerez Secure, HSTS acik. Soket duz HTTP oldugu icin
     * uygulama bunu kendiliginden bilemez. IP basligi verildiyse vekil var sayilir; KAMERA_VEKIL=0 ile kapatilir.
     */
    vekil: env.KAMERA_VEKIL !== undefined ? env.KAMERA_VEKIL === '1' : !!env.KAMERA_IP_BASLIGI,
    govdeSiniri: 1_000_000,
  },

  /**
   * Kimlik Yonetim Merkezi (KYM) ile giris — Authorization Code + PKCE. Parola bu panele hic ugramaz.
   * Dort alan da doluysa acik; biri bossa dugme bile cizilmez. Yerel kullanici adi + parola girisi her zaman kalir.
   */
  kimlik: {
    adres: (env.KAMERA_KIMLIK_ADRES || '').replace(/\/+$/, ''),
    istemci: env.KAMERA_KIMLIK_ISTEMCI || '',
    sir: env.KAMERA_KIMLIK_SIR || '',
    donus: env.KAMERA_KIMLIK_DONUS || '',           // merkezde kayitli adresle BIREBIR ayni (ornegin https://kamera.ornek.test/giris/merkez/geri)
    bildirimSirri: env.KAMERA_KIMLIK_BILDIRIM_SIR || '', // merkezin "bu kimlik degisti" bildirimini imzaladigi sir
    ad: env.KAMERA_KIMLIK_AD || 'Kimlik Yönetim Merkezi',
    dogrulamaDakika: sayi(env.KAMERA_KIMLIK_DOGRULAMA_DAKIKA, 5),   // merkezdeki durum kac dakikada bir yeniden sorulsun
    /** Merkezdeki rol -> buradaki rol. Roller DC ile ayni kimlikte oldugu icin bos esleme = ayni ad. JSON: {"<merkez rolu>":"<yerel rol>"} */
    rolEsleme: JSON.parse(env.KAMERA_KIMLIK_ROL_ESLEME || '{}'),
    /** Eslenemeyen rol icin; bos = hesap acilmaz. */
    varsayilanRol: env.KAMERA_KIMLIK_VARSAYILAN_ROL || '',
  },

  oturum: {
    cerez: env.KAMERA_CEREZ || 'kamera_oturum',     // ayni makinede birden cok panel: cerez adlari farkli olmali
    gun: 30,
  },

  /**
   * Canli izleme sayfasi (/live): uyeliksiz, WebRTC. Goruntuyu mediamtx verir (ayri konteyner, compose: kamera-rtc);
   * rtcApi onun yonetim adresi. Bossa /live kapali (404). rtcWhep izleme (WHEP) adresi: tarayicinin /live/rtc/<yol>/whep
   * istegini panel oraya gecirir, vekilde ayri bir kural gerekmez. Verilmezse rtcApi'nin konagi, mediamtx'in 8889'u.
   */
  live: {
    rtcApi: (env.KAMERA_RTC_API || '').replace(/\/+$/, ''),
    rtcWhep: (env.KAMERA_RTC_WHEP || (env.KAMERA_RTC_API ? env.KAMERA_RTC_API.replace(/\/+$/, '').replace(/:\d+$/, ':8889') : '')).replace(/\/+$/, ''),
    cerceve: env.KAMERA_LIVE_CERCEVE ?? '*',        // iframe ile gomebilecek kokenler ("*" her yer); bos = yalniz panel
    /** Kayitli duzen yokken gosterilecek kameralar: virgulle kanal no (1'den), sirayla. Bos = ilk 12 kamera. */
    varsayilan: (env.KAMERA_LIVE_VARSAYILAN || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).map((n) => `k${n - 1}`),
  },

  cihaz: {
    tohum: env.KAMERA_CIHAZLAR || '[]',             // yalniz veri/cihazlar.json yokken ilk cihazlar (JSON dizi)
    oran: env.KAMERA_ORAN ?? '16:9',
    oynatmaMax: sayi(env.KAMERA_OYNATMA_MAX, 4),
    indirmeMax: sayi(env.KAMERA_INDIRME_MAX, 2),
    akisMax: sayi(env.KAMERA_AKIS_MAX, 24),
    ffmpeg: env.KAMERA_FFMPEG || '',
    test: env.KAMERA_TEST === '1',                  // sahte surucu (yalniz testler)
  },

  yetki: {
    ilkAdminParola: env.KAMERA_ADMIN_PAROLA || '',
    uyeHizLimiti: 1200, uyeAkisSiniri: 16,
  },

  /**
   * Guncelleme kontrolu (ust menude "Güncelleme"): calisan surum, deponun main dalindaki son BASARILI imaj derlemesiyle
   * karsilastirilir. Yalniz bakar, kurmaz. Acik depo jetonsuz sorulur; ozel depo salt okunur jeton ister (fine-grained;
   * Contents ve Actions: read). Erisilemezse kontrol hata der; panelin baska yeri etkilenmez.
   */
  guncelleme: {
    depo: env.GUNCELLEME_DEPO || 'mustafa-ozen95/cam',
    is: 'imaj.yml', dal: 'main',
    jeton: env.GUNCELLEME_JETONU || '',
    surum: env.UYGULAMA_SURUMU || dosyaSatiri(join(KOK, 'SURUM')),   // imaja derlemede yazilir (Dockerfile: ARG SURUM ya da .git)
    saat: '06:50',                                  // her sabah (sunucu saati, TZ)
    api: 'https://api.github.com',
  },

  dil: { varsayilan: 'tr', destek: ['tr', 'en'] },
});
