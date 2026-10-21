# Kamera paneli (cam)

[English](README.md) · **Türkçe**

NVR/DVR/IP kameralar için canlı izleme, kayıttan oynatma, indirme; rol/izin tabanlı üyelik, API anahtarları, denetim günlüğü. **Node.js 22+, bağımlılık yok**, ffmpeg gerekir. Arayüz Türkçe (varsayılan) / İngilizce.

| Tür | Cihaz | Protokol | Kayıt listesi |
|---|---|---|---|
| `uniview` | Uniview NVR (ör. NVR302-32S) | LAPI (HTTP Digest) + RTSP, H.265 | gün bazında "kayıt var" → 15 dk dilimler |
| `hikvision` | Hikvision NVR (ör. DS-7616NI-Q2) | ISAPI (HTTP Digest) + RTSP, H.264 | gerçek kayıt aralıkları → 15 dk dilimler; panelden NVR'a kamera kaydı |
| `xiongmai` | Xiongmai / NetSurveillance DVR-NVR | DVR-IP (TCP 34567) | cihazın dosya listesi |
| `kamera` | Tek IP kamera (Hikvision/Dahua/Uniview/özel RTSP) | RTSP | yalnız canlı |

## Klasör yapısı (Laravel düzeni, Node kuralları)
```
bin/cam.mjs                giriş noktası (npm start)
config/app.mjs             tüm ortam değişkenleri burada okunur
routes/                    web.mjs, api.mjs (/api), api-v1.mjs (/api/v1): rota → ara katman + denetleyici
src/bootstrap.mjs          hizmetleri kurar, denetleyicileri bağlar, rotaları yükler
src/core/                  uygulama (sunucu + istek döngüsü), yonlendirici, http yardımcıları
src/middleware/            ara katman: guvenlik (CSP/CSRF), kimlik (anahtar/çerez → asal), yetki (izin denetimi)
src/controllers/           denetleyiciler: giris, uyeler, cihazlar, akis, yetki, gunluk, gorunum, live, merkez — yalnız istek/yanıt
src/services/              hizmetler: cihazlar (sürücü kaydı, grup, kanal ayarı), gunluk (HMAC zincirli denetim günlüğü), live, merkez
src/models/                modeller: uye (üyelik, scrypt), yetki (izin/rol/anahtar çekirdeği), cihaz (şifreli cihaz deposu)
src/drivers/               sürücüler: taban, rtsp, uniview, hikvision, xiongmai(-dvr, -dvrip), ipkamera, grup, sahte (test)
resources/views/web/       arayüz (index.html, giris.html, css/, js/) — görünümde iş mantığı yok, API ile konuşur
resources/views/live/      /live sayfası (WebRTC)
docs/                      api-v1.tr.md, api-v1.en.md, openapi.json (scripts/openapi.mjs üretir); /dokuman adresinden sunulur
scripts/                   openapi.mjs, eys-sync.mjs
test/                      *.test.mjs (birim + API/güvenlik entegrasyon), helpers.mjs
veri/                      çalışma verisi (git dışı): kullanicilar.json, yetki.json, cihazlar.json, kanallar.json, gunluk.jsonl, gizli.anahtar
```

## Kurulum
`docker-compose.yml` Compose standardındadır (compose-spec.io): aynı dosya `docker compose` ile de, NineDeploy, Coolify,
Dokploy, Portainer gibi bir panelin "Git deposundan compose" kurulumuyla da çalışır. Ayarlar ortamdan gelir (`.env.example`).
HTTP portu dışarı açılmaz; alan adını ve TLS'i önündeki vekil verir (panele 80'den ulaşır). `/live` görüntüsü
`kamera-rtc` (mediamtx) servisinden, 8189/udp üzerinden akar; tarayıcıya verilecek sunucu adresi `KAMERA_RTC_ADRES`.
```
cp .env.example .env          # isteğe bağlı; chmod 600 .env
docker compose up -d --build  # ya da: npm start
cp docker-compose.override.example.yml docker-compose.override.yml   # vekil yoksa: panel doğrudan KAMERA_DIS_PORT'tan (1165)
# aynı kaynaktan ikinci kurulum: ayrı klasör + ayrı .env (KAMERA_KONTEYNER, KAMERA_RTC_KONTEYNER, KAMERA_VERI_VOLUME, KAMERA_RTC_PORT, KAMERA_CEREZ); veri ortak değildir
npm test                      # birim + entegrasyon (sahte cihazla, gerçek cihaz gerekmez)
node scripts/openapi.mjs      # OpenAPI belgesini rotalardan yeniden üret
```
İlk açılışta `admin` oluşturulur (`KAMERA_ADMIN_PAROLA` yoksa parola `veri/ilk-admin.txt`). Cihazlar **Cihaz** sekmesinden eklenir (kaydetmeden önce bağlantı denenir); `KAMERA_CIHAZLAR` yalnız `veri/cihazlar.json` yokken ilk tohumdur.

## Yetki ve API
- İzin kataloğu, DC rolleri (admin, network, teknik, muhasebe) ve özel roller, kamera **kapsamı** (cihaz/kanal listesi), hesap bitişi, IP/CIDR listesi.
- **API anahtarı** (`kp_…`, özet saklanır, bir kez gösterilir; hız limiti, eşzamanlı akış, IP listesi, bitiş, iptal, yenileme).
- Yetki yükseltme engeli: kimse sahip olmadığı izni/kapsamı veremez; **mevcut** üyeye de dokunamaz (kendinden yetkili/kapsamı dışındaki üyenin parolası, rolü, silinmesi), hesap bağları (bitiş, IP listesi, hız/akış sınırı) da kimseden gevşek devredilemez ve kişi kendi kısıtını kaldıramaz.
- API anahtarı sahibinin türevidir: sahip silinirse/süresi dolarsa/IP dışına çıkarsa/KYM'de erişimi kalkarsa anahtar da işlemez, izinleri sahibin **güncel** rolünü aşmaz; üye silinince anahtarları iptal olur. Sahibi üye olmayan (yetki.yonet'in verdiği entegrasyon etiketli) anahtar kendi haklarıyla çalışır. Sahiplik anahtarın görünen adıyla değil `sahip` alanıyla belirlenir.
- Kamera kapsamı yazma işlerinde de uygulanır (kanal ayarı, cihaz düzenleme/silme/saat); kapsamlı biri cihaz ekleyemez, kayıtları silemez. `/api/bilgi` kapsam dışı kanal/cihaz verisi döndürmez. Kanal numaraları KALICIDIR (`cihazlar.json` · `ustSinir`): silinen cihazın bloğu yeni cihaza verilmez, böylece sayısal kanal kapsamları yeni cihaza kaymaz.
- Belge: `/dokuman/api-v1.tr.md`, `/dokuman/api-v1.en.md`, `/dokuman/openapi.json` (**oturum ister**).

## Kimlik Yönetim Merkezi (KYM) ile giriş
DC panelleriyle aynı akış (Authorization Code + PKCE): kullanıcı merkezin sayfasında giriş yapar, parola bu panele uğramaz. Merkezde (Yönetim → Uygulamalar) bir istemci açılır; dönüş adresi `https://<alan>/giris/merkez/geri` olmalı ve **hangi rollerin girebileceği merkezde** seçilir. Dört değişken de doluysa giriş sayfasında "… ile giriş" düğmesi çıkar; yerel kullanıcı adı + parola girişi her zaman kalır (merkez erişilemezken de panele girilebilsin).

```
KAMERA_KIMLIK_ADRES=https://dc.ornek.test          KAMERA_KIMLIK_ISTEMCI=<istemci kimliği>
KAMERA_KIMLIK_SIR=<istemci sırrı>                   KAMERA_KIMLIK_DONUS=https://kamera.ornek.test/giris/merkez/geri
KAMERA_KIMLIK_BILDIRIM_SIR=<bildirim sırrı>         KAMERA_KIMLIK_AD="Kimlik Yönetim Merkezi"
KAMERA_KIMLIK_ROL_ESLEME='{}'                         KAMERA_KIMLIK_VARSAYILAN_ROL=           KAMERA_KIMLIK_DOGRULAMA_DAKIKA=5
```
- **Roller DC panelleriyle aynı:** `admin` (her şey, değişmez), `network`, `teknik`, `muhasebe` (izinsiz doğar; izinleri Yetki → Roller'den verilir, ad/kimlik sabit). Merkezdeki rol aynı adlı role eşlenir; farklı eşleme `ROL_ESLEME` ile, karşılığı olmayan rol `VARSAYILAN_ROL` ile (boşsa hesap açılmaz). Özel roller de eklenebilir.
- İlk girişte merkez "hesap açılabilir" diyorsa üye açılır (ad e-postanın yerel kısmından, parola rastgele). Bağ `veri/merkez-baglari.json`; bağ üyenin **adına değil kendisine** (oluşturma damgası, `uyeKimlik`) bağlıdır: üye silinince bağ da silinir, aynı adla açılan yeni üye eski kimliği devralamaz. Eski (damgasız) bağlar açılışta mevcut üyeye damgalanır; üyesi olmayanlar atılır.
- Merkezde erişimi kalkan ya da rolü değişen kişi burada da değişir: merkez `POST /api/kimlik/tazele` ile (HMAC imzalı) anında bildirir; ayrıca her `DOGRULAMA_DAKIKA` dakikada bir `/api/kimlik-durumu` sorulur. Merkeze ulaşılamazsa son bilinen durum geçerli kalır.
- Ters vekil (Caddy/nginx) arkasında `KAMERA_IP_BASLIGI=X-Real-IP` verin; o zaman çerezler `Secure`, HSTS açık (`KAMERA_VEKIL=0` ile kapatılır).

## Güvenlik
Kimliksiz erişilebilen yalnız giriş sayfasının ihtiyacıdır: giriş formu, `css/js/font/simge`, `POST /api/giris|cikis`, KYM giriş akışı ve `/api/kimlik/tazele` (HMAC imzalı). **API belgesi (`/dokuman`) ve `/api/v1` oturum ister**; `/api/v1/saglik` yalnız konteynerin kendi `127.0.0.1` adresinden yanıt verir (HEALTHCHECK) ve ayrıntı taşımaz; statik uçtan `.json`/`.md` sunulmaz. Oturum çerezi üyenin oluşturma damgasına ve oturum sürümüne bağlıdır: **çıkış yapmak ya da parola değişmek o üyenin tüm çerezlerini geçersiz kılar**; imza amaçları (oturum, KYM akışı) ayrı etiketlidir. Girişte IP başına kısıt (dakikada 20 hata → 60 sn) parola karması hesaplanmadan önce uygulanır, karma zaman uyumsuzdur; ters vekil arkasında `KAMERA_IP_BASLIGI` verilmezse bu kısıt vekil adresine uygulanır. Cihaz adresi/portu değişirse parola yeniden girilmelidir (kayıtlı parola yalnız girildiği hedefe gider).
Parolalar scrypt; cihaz parolaları AES-256-GCM; anahtarlar HMAC özeti; çerez HttpOnly+SameSite (HTTPS'de Secure); CSRF başlığı; CSP/nosniff/frame/referrer başlıkları; gövde 1 MB sınırı; yol geçişi koruması; kaba kuvvet kilidi (giriş ve anahtar); günlükte gizli yok; HMAC zincirli denetim günlüğü. Ters vekil arkasında `KAMERA_IP_BASLIGI` (ör. `CF-Connecting-IP`) ayarlanmazsa IP listeleri soket adresine göre çalışır. Düz HTTP'de önüne TLS koyun.

## Ortam değişkenleri
`KAMERA_PORT` (8191; imajda 80), `KAMERA_ADRES`, `KAMERA_BASLIK`, `KAMERA_CEREZ` (aynı IP'de birden çok panel: farklı ad), `KAMERA_VERI` (veri klasörü), `KAMERA_CIHAZLAR` (ilk tohum, JSON), `KAMERA_ADMIN_PAROLA`, `KAMERA_ORAN` (16:9), `KAMERA_OYNATMA_MAX` (4), `KAMERA_INDIRME_MAX` (2), `KAMERA_AKIS_MAX` (cihaz başına 24), `KAMERA_FFMPEG`, `KAMERA_IP_BASLIGI`, `KAMERA_VEKIL`, `KAMERA_TLS_CERT/KEY/PORT`, `KAMERA_LIVE_CERCEVE` (`/live`'ı gömebilecek kökenler), `KAMERA_LIVE_VARSAYILAN` (kayıtlı düzen yokken `/live` kameraları: virgülle kanal no, 1'den, sırayla; boş = ilk 12), `KAMERA_KIMLIK_*` (yukarıda), `GUNCELLEME_JETONU` (aşağıda), `KAMERA_TEST=1` (sahte sürücü, yalnız test).

## Güncelleme kontrolü
Üst menüdeki **Güncelleme** (`guncelleme.denetle` izni; admin'de var) çalışan sürümü GitHub'da main dalının **son başarılı imaj derlemesiyle** karşılaştırır: kaç commit geride, hangi commit'ler yeni. Yön de ölçülür; çalışan sürüm son derlemeden yeniyse "güncelleme" denmez. Kontrol her sabah 06:50'de kendiliğinden yapılır, düğme hemen yapar; yeni sürüm varsa bu izni olanlar sayfanın üstünde uyarı görür. Ekran **yalnızca bakar**; güncelleme sunucudan yapılır. DC panellerindeki Ayarlar → Güncelleme ile aynı kurallar.
- Çalışan sürüm imaja derlemede yazılır (`ARG SURUM` → `UYGULAMA_SURUMU`; iş akışı commit'i verir). Derlemeye commit vermeyen platformlarda (NineDeploy gibi) derleme bağlamındaki `.git`'ten okunur (`docker/surum-oku.sh`; `.dockerignore` yalnız `HEAD` ve ref'leri alır). Sonuç `veri/guncelleme.json`.
- Depo açık: jeton gerekmez, GitHub'a jetonsuz sorulur (sınır IP başına saatte 60 istek). Depo özelse `GUNCELLEME_JETONU` salt okunur bir jeton olmalı (fine-grained, yalnız panel depoları, Contents ve Actions: read).
- Panel GitHub'a çıkamıyorsa (kapalı ağ) kontrol "erişilemedi" der.

## Dil
Arayüz dizgeleri Türkçe yazılır; `resources/views/web/js/dil.js` sözlüğü ve kuralları EN'e çevirir (seçim üst çubuktaki hesap menüsünden yapılır ve tarayıcıda saklanır). Yeni bir dizge eklerken sözlüğe İngilizcesini ekleyin; dinamik metinler için kural (regex) yazın. Rol/izin adları sunucudan `{tr, en}` gelir.

## Tasarım (EYS ile birebir)
İç ekranlar EYS panelinin tasarım şablonunu **değiştirmeden** kullanır: üst çubuk, hesap menüsü, sütun şeridi (canlı, kayıtlar, cihaz üç bölmeli), yönetim tabloları, pencereler, bildirimler ve tema aynı işaretleme ve aynı CSS ile çizilir.
- `resources/views/web/css/eys/` ve `resources/views/web/js/eys/` EYS'den **kopyadır, elle değiştirilmez.** EYS değişince `node scripts/eys-sync.mjs <EYS deposu>` ile yeniden kopyalanır (`--kontrol` yalnız farkı söyler); dosya özetleri `css/eys/OZET.json`'da, `test/eys-tasarim.test.mjs` elle yapılan değişikliği yakalar.
- `css/app.css` yalnız `fonts.css` (yerel yazı tipleri), `eys/app.css` ve `kamera.css`'i içe aktarır.
- `css/kamera.css` **yalnızca ekler**: kameraya özgü parçalar (ızgara, oynatıcı, zaman çizelgesi, kayıt satırı, tam ekran). EYS'nin tanımladığı bir seçiciyi yeniden tanımlamaz (test denetler); gerekiyorsa `.detail--genis` gibi yeni bir değiştirici eklenir.
- `js/bolme.js`: dar ekranda doğru bölmeye iner (EYS `columns.js` kuralı, seçim adreste değil sayfa durumunda olduğu için).
