# Kamera paneli (cam)

[English](README.md) · **Türkçe**

NVR/DVR/IP kameralar için canlı izleme, kayıttan oynatma, indirme; rol/izin tabanlı üyelik, API anahtarları, denetim günlüğü. **Node.js 22+, bağımlılık yok**, ffmpeg gerekir. Arayüz Türkçe (varsayılan) / İngilizce.

| Tür | Cihaz | Protokol | Kayıt listesi |
|---|---|---|---|
| `uniview` | Uniview NVR (ör. NVR302-32S) | LAPI (HTTP Digest) + RTSP, H.265 | gün bazında "kayıt var" → 15 dk dilimler |
| `hikvision` | Hikvision NVR (ör. DS-7616NI-Q2) | ISAPI (HTTP Digest) + RTSP, H.264 | gerçek kayıt aralıkları → 15 dk dilimler; panelden NVR'a kamera kaydı |
| `xiongmai` | Xiongmai / NetSurveillance DVR-NVR | DVR-IP (TCP 34567) | cihazın dosya listesi |
| `camera` | Tek IP kamera (Hikvision/Dahua/Uniview/özel RTSP) | RTSP | yalnız canlı |

## Klasör yapısı (Laravel düzeni, Node kuralları)
```
bin/cam.mjs                giriş noktası (npm start)
config/app.mjs             tüm ortam değişkenleri burada okunur
routes/                    web.mjs, api.mjs (/api), api-v1.mjs (/api/v1): rota → ara katman + denetleyici
src/bootstrap.mjs          hizmetleri kurar, denetleyicileri bağlar, rotaları yükler
src/core/                  uygulama (sunucu + istek döngüsü), yönlendirici, http yardımcıları
src/middleware/            ara katman: security (CSP/CSRF), identity (anahtar/çerez → asal), permissions (izin denetimi)
src/controllers/           denetleyiciler: login, members, devices, streams, permissions, audit-log, views, live, hub, updates — yalnız istek/yanıt
src/services/              hizmetler: devices (sürücü kaydı, grup, kanal ayarı), audit-log (HMAC zincirli denetim günlüğü), live, hub, updates
src/models/                modeller: member (üyelik, scrypt), permission (izin/rol/anahtar çekirdeği), device (şifreli cihaz deposu)
src/drivers/               sürücüler: base, rtsp, uniview, hikvision, xiongmai(-dvr, -dvrip), ip-camera, group, mock (test)
resources/views/web/       arayüz (index.html, login.html, css/, js/) — görünümde iş mantığı yok, API ile konuşur
resources/views/live/      /live sayfası (WebRTC)
docs/                      api-v1.tr.md, api-v1.en.md, openapi.json (scripts/openapi.mjs üretir); /docs adresinden sunulur
scripts/                   openapi.mjs, eys-sync.mjs
test/                      *.test.mjs (birim + API/güvenlik entegrasyon), helpers.mjs
src/database/             şema göçleri, tablo eşlemesi, JSON dönemi dosyalarının bir kerelik aktarımı
data/                      (git dışı) secret.key (CAM_SECRET_KEY boşsa), initial-admin.txt; aktarılana kadar JSON dönemi dosyaları
```

## Kurulum
`docker-compose.yml` Compose standardındadır (compose-spec.io). Ayarlar ortamdan gelir (`.env.example`).
Veri MariaDB'dedir (`db` servisi, adlandırılmış hacim `cam_database`); dışarıdaki bir veritabanı için `DB_HOST` ve kimlik bilgilerini
verin, `db` servisi kalkmasın diye `DB_REPLICAS=0` yapın.
HTTP portu dışarı açılmaz; alan adını ve TLS'i önündeki vekil verir (panele 80'den ulaşır). `/live` görüntüsü
`cam-rtc` (mediamtx) servisinden, 8189/udp üzerinden akar; tarayıcıya verilecek sunucu adresi `CAM_RTC_HOST`.
```
cp .env.example .env          # isteğe bağlı; chmod 600 .env
docker compose up -d --build  # ya da: npm start
cp docker-compose.override.example.yml docker-compose.override.yml   # vekil yoksa: panel doğrudan CAM_EXTERNAL_PORT'tan (1165)
# aynı kaynaktan ikinci kurulum: ayrı klasör + ayrı .env (CAM_CONTAINER, CAM_RTC_CONTAINER, CAM_DB_CONTAINER, CAM_DATA_VOLUME, CAM_DB_VOLUME, CAM_RTC_PORT, CAM_COOKIE); veri ortak değildir
npm test                      # birim + entegrasyon (sahte cihaz; bir MariaDB gerekir, bkz. "Veritabanı ve yedek")
node scripts/openapi.mjs      # OpenAPI belgesini rotalardan yeniden üret
```
İlk açılışta `admin` oluşturulur (`CAM_ADMIN_PASSWORD` yoksa parola `data/initial-admin.txt`). Cihazlar **Cihaz** sekmesinden eklenir (kaydetmeden önce bağlantı denenir); `CAM_DEVICES` yalnız `devices` tablosu boşken ilk tohumdur.

## Veritabanı ve yedek
Bütün veri (üyeler, cihazlar, roller, API anahtarları, denetim günlüğü, kanal ayarı, /live düzeni, güncelleme durumu, KYM bağları)
MariaDB/MySQL'dedir (sürücü `mysql2`, utf8mb4). Bağlantı: `DB_HOST` (varsayılan `db`), `DB_PORT` (3306), `DB_DATABASE` (`cam`),
`DB_USERNAME` (`cam`), `DB_PASSWORD` (zorunlu). Açılışta panel veritabanını bekler (`DB_WAIT_SEC`, varsayılan 60 sn), sonra kendi
göçlerini çalıştırır (sürüm tablosu `migrations`, sıralı, tekrar çalıştırmak bir şey yapmaz). Veritabanına ulaşılamıyorsa `/api/v1/health` sağlıksızdır.
- Tablolar: `users`, `devices`, `roles`, `builtin_role_permissions`, `api_keys`, `hub_links`, `audit_log` (satır başına kayıt; imza zinciri korunur ve veritabanından doğrulanır), `settings` (ad → JSON), `migrations`.
- **Gizli anahtar** veritabanına girmez (döküm, şifreli cihaz parolalarıyla aynı yerde durmasın): `CAM_SECRET_KEY` (base64, 32 bayt; `openssl rand -base64 32`); boşsa `data/secret.key` kullanılır (yoksa 0600 ile üretilir). Değişken o dosyadan ya da veritabanını dolduran anahtardan farklıysa açılış açık bir iletiyle durur. Anahtarı yedeklerle birlikte saklayın.
- **Yedek = veritabanı dökümü** (ör. `docker compose exec db sh -c 'mariadb-dump --single-transaction -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' > cam.sql`) + gizli anahtar.
- **Bir kerelik aktarım**: açılışta tüm tablolar boşsa ve `data/` içinde JSON dönemi dosyaları varsa (kullanicilar.json, yetki.json, cihazlar.json, kanallar.json, gunluk.jsonl, merkez-baglari.json, guncelleme.json, live-duzen.json) hepsi tek işlemde aktarılır; günlük zinciri veritabanından doğrulanır, satır sayıları dosyalarla karşılaştırılır. Yalnız hepsi tutarsa dosyalar `<ad>.imported` adıyla yeniden adlandırılır (silinmez). Tutmazsa her şey geri alınır, dosyalar yerinde kalır ve açılış nedeniyle durur. Tablolar doluyken eski dosyalar duruyorsa hiçbir şeye dokunulmaz, uyarı yazılır. Aktarım ne yaptığını sayılarla stdout'a yazar.

## Yetki ve API
- İzin kataloğu, DC rolleri (admin, network, technical, accounting) ve özel roller, kamera **kapsamı** (cihaz/kanal listesi), hesap bitişi, IP/CIDR listesi.
- **API anahtarı** (`kp_…`, özet saklanır, bir kez gösterilir; hız limiti, eşzamanlı akış, IP listesi, bitiş, iptal, yenileme).
- Yetki yükseltme engeli: kimse sahip olmadığı izni/kapsamı veremez; **mevcut** üyeye de dokunamaz (kendinden yetkili/kapsamı dışındaki üyenin parolası, rolü, silinmesi), hesap bağları (bitiş, IP listesi, hız/akış sınırı) da kimseden gevşek devredilemez ve kişi kendi kısıtını kaldıramaz.
- API anahtarı sahibinin türevidir: sahip silinirse/süresi dolarsa/IP dışına çıkarsa/KYM'de erişimi kalkarsa anahtar da işlemez, izinleri sahibin **güncel** rolünü aşmaz; üye silinince anahtarları iptal olur. Sahibi (`owner`) üye olmayan (permission.manage'in verdiği entegrasyon etiketli) anahtar kendi haklarıyla çalışır. Sahiplik anahtarın görünen adıyla değil `owner` alanıyla belirlenir.
- Kamera kapsamı yazma işlerinde de uygulanır (kanal ayarı, cihaz düzenleme/silme/saat); kapsamlı biri cihaz ekleyemez, kayıtları silemez. `/api/info` kapsam dışı kanal/cihaz verisi döndürmez. Kanal numaraları KALICIDIR (`settings` · `device-block-limit`): silinen cihazın bloğu yeni cihaza verilmez, böylece sayısal kanal kapsamları yeni cihaza kaymaz.
- Belge: `/docs/api-v1.tr.md`, `/docs/api-v1.en.md`, `/docs/openapi.json` (**oturum ister**).

## Kimlik Yönetim Merkezi (KYM) ile giriş
DC panelleriyle aynı akış (Authorization Code + PKCE): kullanıcı merkezin sayfasında giriş yapar, parola bu panele uğramaz. Merkezde (Yönetim → Uygulamalar) bir istemci açılır; dönüş adresi `https://<alan>/login/hub/callback` olmalı ve **hangi rollerin girebileceği merkezde** seçilir. Dört değişken de doluysa giriş sayfasında "… ile giriş" düğmesi çıkar; yerel kullanıcı adı + parola girişi her zaman kalır (merkez erişilemezken de panele girilebilsin).

```
CAM_HUB_URL=https://dc.ornek.test          CAM_HUB_CLIENT_ID=<istemci kimliği>
CAM_HUB_CLIENT_SECRET=<istemci sırrı>                   CAM_HUB_REDIRECT_URI=https://kamera.ornek.test/login/hub/callback
CAM_HUB_NOTIFY_SECRET=<bildirim sırrı>         CAM_HUB_NAME="Kimlik Yönetim Merkezi"
CAM_HUB_ROLE_MAP='{}'                         CAM_HUB_DEFAULT_ROLE=           CAM_HUB_CHECK_MINUTES=5
```
- **Roller DC panelleriyle aynı:** `admin` (her şey, değişmez), `network`, `technical`, `accounting` (izinsiz doğar; izinleri Yetki → Roller'den verilir, ad/kimlik sabit). Merkezdeki rol aynı adlı role eşlenir; farklı eşleme `CAM_HUB_ROLE_MAP` ile, karşılığı olmayan rol `CAM_HUB_DEFAULT_ROLE` ile (boşsa hesap açılmaz). Özel roller de eklenebilir.
- İlk girişte merkez "hesap açılabilir" diyorsa üye açılır (ad e-postanın yerel kısmından, parola rastgele). Bağ `hub_links` tablosunda; bağ üyenin **adına değil kendisine** (oluşturma damgası, `userStamp`) bağlıdır: üye silinince bağ da silinir, aynı adla açılan yeni üye eski kimliği devralamaz. Eski (damgasız) bağlar açılışta mevcut üyeye damgalanır; üyesi olmayanlar atılır.
- Merkezde erişimi kalkan ya da rolü değişen kişi burada da değişir: merkez `POST /api/kimlik/tazele` ile (HMAC imzalı) anında bildirir; ayrıca her `CAM_HUB_CHECK_MINUTES` dakikada bir `/api/kimlik-durumu` sorulur. Merkeze ulaşılamazsa son bilinen durum geçerli kalır.
- Ters vekil (Caddy/nginx) arkasında `CAM_IP_HEADER=X-Real-IP` verin; o zaman çerezler `Secure`, HSTS açık (`CAM_PROXY=0` ile kapatılır).

## Güvenlik
Kimliksiz erişilebilen yalnız giriş sayfasının ihtiyacıdır: giriş formu, `css/js/font/icon`, `POST /api/login|logout`, KYM giriş akışı ve `/api/kimlik/tazele` (HMAC imzalı). **API belgesi (`/docs`) ve `/api/v1` oturum ister**; `/api/v1/health` yalnız konteynerin kendi `127.0.0.1` adresinden yanıt verir (HEALTHCHECK) ve ayrıntı taşımaz; statik uçtan `.json`/`.md` sunulmaz. Oturum çerezi üyenin oluşturma damgasına ve oturum sürümüne bağlıdır: **çıkış yapmak ya da parola değişmek o üyenin tüm çerezlerini geçersiz kılar**; imza amaçları (oturum, KYM akışı) ayrı etiketlidir. Girişte IP başına kısıt (dakikada 20 hata → 60 sn) parola karması hesaplanmadan önce uygulanır, karma zaman uyumsuzdur; ters vekil arkasında `CAM_IP_HEADER` verilmezse bu kısıt vekil adresine uygulanır. Cihaz adresi/portu değişirse parola yeniden girilmelidir (kayıtlı parola yalnız girildiği hedefe gider).
Parolalar scrypt; cihaz parolaları AES-256-GCM; anahtarlar HMAC özeti; çerez HttpOnly+SameSite (HTTPS'de Secure); CSRF başlığı; CSP/nosniff/frame/referrer başlıkları; gövde 1 MB sınırı; yol geçişi koruması; kaba kuvvet kilidi (giriş ve anahtar); günlükte gizli yok; HMAC zincirli denetim günlüğü. Ters vekil arkasında `CAM_IP_HEADER` (ör. `CF-Connecting-IP`) ayarlanmazsa IP listeleri soket adresine göre çalışır. Düz HTTP'de önüne TLS koyun.

## Ortam değişkenleri
`CAM_PORT` (8191; imajda 80), `CAM_HOST`, `CAM_TITLE`, `CAM_COOKIE` (aynı IP'de birden çok panel: farklı ad), `CAM_DATA` (veri klasörü), `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_WAIT_SEC`, `CAM_SECRET_KEY`, `CAM_DEVICES` (ilk tohum, JSON), `CAM_ADMIN_PASSWORD`, `CAM_RATIO` (16:9), `CAM_PLAYBACK_MAX` (4), `CAM_DOWNLOAD_MAX` (2), `CAM_STREAM_MAX` (cihaz başına 24), `CAM_FFMPEG`, `CAM_IP_HEADER`, `CAM_PROXY`, `CAM_TLS_CERT/KEY/PORT`, `CAM_LIVE_EMBED` (`/live`'ı gömebilecek kökenler), `CAM_LIVE_DEFAULT` (kayıtlı düzen yokken `/live` kameraları: virgülle kanal no, 1'den, sırayla; boş = ilk 12), `CAM_HUB_*` (yukarıda), `UPDATE_TOKEN` (aşağıda), `CAM_TEST=1` (sahte sürücü, yalnız test).

## Güncelleme kontrolü
Üst menüdeki **Güncelleme** (`update.check` izni; admin'de var) çalışan sürümü GitHub'da main dalının **son başarılı imaj derlemesiyle** karşılaştırır: kaç commit geride, hangi commit'ler yeni. Yön de ölçülür; çalışan sürüm son derlemeden yeniyse "güncelleme" denmez. Kontrol her sabah 06:50'de kendiliğinden yapılır, düğme hemen yapar; yeni sürüm varsa bu izni olanlar sayfanın üstünde uyarı görür. Ekran **yalnızca bakar**; güncelleme sunucudan yapılır. DC panellerindeki Ayarlar → Güncelleme ile aynı kurallar.
- Çalışan sürüm imaja derlemede yazılır (`ARG VERSION` → `APP_VERSION`; iş akışı commit'i verir). Derleme commit vermiyorsa derleme bağlamındaki `.git`'ten okunur (`docker/read-version.sh`; `.dockerignore` yalnız `HEAD` ve ref'leri alır). Sonuç veritabanında (`settings`, `update-status`).
- Depo açık: jeton gerekmez, GitHub'a jetonsuz sorulur (sınır IP başına saatte 60 istek). Depo özelse `UPDATE_TOKEN` salt okunur bir jeton olmalı (fine-grained, yalnız panel depoları, Contents ve Actions: read).
- Panel GitHub'a çıkamıyorsa (kapalı ağ) kontrol "erişilemedi" der.

## Dil
Arayüz dizgeleri Türkçe yazılır; `resources/views/web/js/lang.js` sözlüğü ve kuralları EN'e çevirir (seçim üst çubuktaki hesap menüsünden yapılır ve tarayıcıda saklanır). Yeni bir dizge eklerken sözlüğe İngilizcesini ekleyin; dinamik metinler için kural (regex) yazın. Rol/izin adları sunucudan `{tr, en}` gelir.

## Tasarım (EYS ile birebir)
İç ekranlar EYS panelinin tasarım şablonunu **değiştirmeden** kullanır: üst çubuk, hesap menüsü, sütun şeridi (canlı, kayıtlar, cihaz üç bölmeli), yönetim tabloları, pencereler, bildirimler ve tema aynı işaretleme ve aynı CSS ile çizilir.
- `resources/views/web/css/eys/` ve `resources/views/web/js/eys/` EYS'den **kopyadır, elle değiştirilmez.** EYS değişince `node scripts/eys-sync.mjs <EYS deposu>` ile yeniden kopyalanır (`--check` yalnız farkı söyler); dosya özetleri `css/eys/OZET.json`'da, `test/eys-design.test.mjs` elle yapılan değişikliği yakalar.
- `css/app.css` yalnız `fonts.css` (yerel yazı tipleri), `eys/app.css` ve `camera.css`'i içe aktarır.
- `css/camera.css` **yalnızca ekler**: kameraya özgü parçalar (ızgara, oynatıcı, zaman çizelgesi, kayıt satırı, tam ekran). EYS'nin tanımladığı bir seçiciyi yeniden tanımlamaz (test denetler); gerekiyorsa `.detail--genis` gibi yeni bir değiştirici eklenir.
- `js/split.js`: dar ekranda doğru bölmeye iner (EYS `columns.js` kuralı, seçim adreste değil sayfa durumunda olduğu için).
