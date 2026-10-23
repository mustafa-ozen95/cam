/**
 * Uygulama yapilandirmasi (Laravel config/app.php karsiligi). Tum ortam degiskenleri BURADA okunur; baska dosya process.env'e bakmaz.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const count = (v, defaultValue) => (v === undefined || v === '' ? defaultValue : Number(v));
const env = process.env;
/** Tek satirlik dosya (imajdaki VERSION gibi); yoksa bos. */
const fileRow = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } };

export const config = Object.freeze({
  root: ROOT,
  dataDir: env.CAM_DATA ?? join(ROOT, 'data'),
  /** Gizli anahtar (base64, 32 bayt). Bossa data/secret.key dosyasi kullanilir (yoksa uretilir). Veritabanina GIRMEZ. */
  secretKey: env.CAM_SECRET_KEY || '',

  /** Veritabani (MariaDB/MySQL): diger panellerle ayni degisken adlari. Acilista veritabani gelmezse waitingSec kadar yeniden denenir. */
  database: {
    host: env.DB_HOST || 'db',
    port: count(env.DB_PORT, 3306),
    database: env.DB_DATABASE || 'cam',
    username: env.DB_USERNAME || 'cam',
    password: env.DB_PASSWORD ?? '',
    waitingSec: count(env.DB_WAIT_SEC, 60),
  },
  views: join(ROOT, 'resources', 'views', 'web'),
  docsDir: join(ROOT, 'docs'),

  server: {
    port: count(env.CAM_PORT, 8191),
    address: env.CAM_HOST ?? '0.0.0.0',
    header: env.CAM_TITLE || 'Kamera Paneli',
    tls: env.CAM_TLS_CERT && env.CAM_TLS_KEY ? { cert: env.CAM_TLS_CERT, key: env.CAM_TLS_KEY, port: count(env.CAM_TLS_PORT, 8443) } : null,
    /** Ters vekil (Cloudflare/nginx) arkasindaysa gercek IP bu basliktan okunur; dogrudan erisimde BOS birakin (taklit edilebilir). */
    trustedIpHeader: env.CAM_IP_HEADER || '',
    /**
     * TLS'i bitiren vekilin arkasinda (Caddy/nginx): cerez Secure, HSTS acik. Soket duz HTTP oldugu icin
     * uygulama bunu kendiliginden bilemez. IP basligi verildiyse vekil var sayilir; CAM_PROXY=0 ile kapatilir.
     */
    proxy: env.CAM_PROXY !== undefined ? env.CAM_PROXY === '1' : !!env.CAM_IP_HEADER,
    bodyLimit: 1_000_000,
  },

  /**
   * Kimlik Yonetim Merkezi (KYM) ile giris — Authorization Code + PKCE. Parola bu panele hic ugramaz.
   * Dort alan da doluysa acik; biri bossa dugme bile cizilmez. Yerel kullanici adi + parola girisi her zaman kalir.
   */
  identity: {
    address: (env.CAM_HUB_URL || '').replace(/\/+$/, ''),
    client: env.CAM_HUB_CLIENT_ID || '',
    secret: env.CAM_HUB_CLIENT_SECRET || '',
    redirectUri: env.CAM_HUB_REDIRECT_URI || '',           // merkezde kayitli adresle BIREBIR ayni (ornegin https://kamera.ornek.test/giris/merkez/geri)
    notifySecret: env.CAM_HUB_NOTIFY_SECRET || '', // merkezin "bu kimlik degisti" bildirimini imzaladigi sir
    name: env.CAM_HUB_NAME || 'Kimlik Yönetim Merkezi',
    checkMinutes: count(env.CAM_HUB_CHECK_MINUTES, 5),   // merkezdeki durum kac dakikada bir yeniden sorulsun
    /** Merkezdeki rol -> buradaki rol. Roller DC ile ayni kimlikte oldugu icin bos esleme = ayni ad. JSON: {"<merkez rolu>":"<yerel rol>"} */
    roleMap: JSON.parse(env.CAM_HUB_ROLE_MAP || '{}'),
    /** Eslenemeyen rol icin; bos = hesap acilmaz. */
    defaultRole: env.CAM_HUB_DEFAULT_ROLE || '',
  },

  session: {
    cookie: env.CAM_COOKIE || 'cam_session',     // ayni makinede birden cok panel: cerez adlari farkli olmali
    day: 30,
  },

  /**
   * Canli izleme sayfasi (/live): uyeliksiz, WebRTC. Goruntuyu mediamtx verir (ayri konteyner, compose: cam-rtc);
   * rtcApi onun yonetim adresi. Bossa /live kapali (404). rtcWhep izleme (WHEP) adresi: tarayicinin /live/rtc/<yol>/whep
   * istegini panel oraya gecirir, vekilde ayri bir kural gerekmez. Verilmezse rtcApi'nin konagi, mediamtx'in 8889'u.
   */
  live: {
    rtcApi: (env.CAM_RTC_API || '').replace(/\/+$/, ''),
    rtcWhep: (env.CAM_RTC_WHEP || (env.CAM_RTC_API ? env.CAM_RTC_API.replace(/\/+$/, '').replace(/:\d+$/, ':8889') : '')).replace(/\/+$/, ''),
    frame: env.CAM_LIVE_EMBED ?? '*',        // iframe ile gomebilecek kokenler ("*" her yer); bos = yalniz panel
    /** Kayitli duzen yokken gosterilecek kameralar: virgulle kanal no (1'den), sirayla. Bos = ilk 12 kamera. */
    defaultOrder: (env.CAM_LIVE_DEFAULT || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).map((n) => `k${n - 1}`),
  },

  device: {
    seed: env.CAM_DEVICES || '[]',             // yalniz devices tablosu bosken ilk cihazlar (JSON dizi)
    ratio: env.CAM_RATIO ?? '16:9',
    playbackMax: count(env.CAM_PLAYBACK_MAX, 4),
    downloadMax: count(env.CAM_DOWNLOAD_MAX, 2),
    streamMax: count(env.CAM_STREAM_MAX, 24),
    ffmpeg: env.CAM_FFMPEG || '',
    test: env.CAM_TEST === '1',                  // sahte surucu (yalniz testler)
  },

  permissions: {
    initialAdminPassword: env.CAM_ADMIN_PASSWORD || '',
    memberRateLimit: 1200, memberStreamLimit: 16,
  },

  /**
   * Guncelleme kontrolu (ust menude "Güncelleme"): calisan surum, deponun main dalindaki son BASARILI imaj derlemesiyle
   * karsilastirilir. Acik depo jetonsuz sorulur; ozel depo salt okunur jeton ister (fine-grained; Contents ve Actions:
   * read). Erisilemezse kontrol hata der; panelin baska yeri etkilenmez. hook: platformun deploy hook adresi (NineDeploy:
   * Service -> Settings -> Deploy hook); tanimliysa ve yeni surum varsa "Şimdi güncelle" onu tetikler. Icindeki jeton
   * deploy yetkisidir: gizli degisken olarak verilir, yanitta ve gunlukte gecmez.
   */
  updates: {
    repo: env.UPDATE_REPO || 'mustafa-ozen95/cam',
    is: 'image.yml', branch: 'main',
    token: env.UPDATE_TOKEN || '',
    hook: env.UPDATE_HOOK_URL || '',
    version: env.APP_VERSION || fileRow(join(ROOT, 'VERSION')),   // imaja derlemede yazilir (Dockerfile: ARG VERSION ya da .git)
    clock: '06:50',                                  // her sabah (sunucu saati, TZ)
    api: 'https://api.github.com',
  },

  language: { default: 'tr', supported: ['tr', 'en'] },
});
