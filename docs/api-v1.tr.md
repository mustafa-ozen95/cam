# Kamera Paneli API v1 — Türkçe

Sürüm: v1 · Taban adres: `http://SUNUCU:PORT/api/v1` · İngilizce: [api-v1.en.md](api-v1.en.md) · OpenAPI: [openapi.json](openapi.json)

Bu API; NVR/DVR/IP kameralardan **canlı görüntü**, **anlık görüntü**, **kayıt listesi**, **kayıttan oynatma** ve **kayıt indirme** sunar; ayrıca cihaz, üye, rol, API anahtarı ve denetim günlüğü yönetimi içerir. Tüm yanıtlar JSON'dur (akış uçları hariç). Tüm zamanlar cihazın **yerel saati** ile `YYYY-AA-GG SS:DD:SS` biçimindedir.

## 1. Kimlik doğrulama

İki yol vardır; ikisi de aynı uçlara erişir:

| Yöntem | Nasıl | Kullanım yeri |
|---|---|---|
| **API anahtarı** | `Authorization: Bearer kp_<id>_<gizli>` | Sunucudan sunucuya, entegrasyonlar |
| **Oturum çerezi** | Panelden giriş (`POST /api/giris`); durum değiştiren isteklerde `X-Kamera: 1` başlığı zorunlu (CSRF) | Panel arayüzü |

API anahtarı yalnız **oluşturma/yenileme yanıtında bir kez** gösterilir; sunucuda yalnız HMAC özeti saklanır. Kaybedilirse `yenile` ile yenisi üretilir (kimlik aynı kalır, eski gizli geçersiz olur).

### Hata yanıtı
```json
{ "hata": "Bu işlem için izin gerekir: kayit.indir", "kod": "YETKI_YOK", "gerekenIzin": "kayit.indir" }
```
| HTTP | kod | Anlamı |
|---|---|---|
| 400 | `GECERSIZ_ISTEK`, `GECERSIZ_JSON` | Girdi hatalı |
| 401 | `OTURUM_GEREKLI`, `GECERSIZ_ANAHTAR`, `ANAHTAR_IPTAL`, `SURESI_DOLDU` | Kimlik yok/geçersiz |
| 403 | `YETKI_YOK`, `KAPSAM_DISI`, `IP_ENGELLI`, `YETKI_YUKSELTME`, `CSRF`, `YERLESIK_DEGISMEZ` | Yetki yok |
| 404 | `BULUNAMADI` | Kaynak yok |
| 405 | `YONTEM` | Yöntem desteklenmiyor |
| 409 | `CAKISMA` | Çakışma (ad kullanılıyor, iptal edilmiş anahtar…) |
| 413 | `GOVDE_BUYUK` | Gövde > 1 MB |
| 429 | `HIZ_SINIRI`, `AKIS_SINIRI`, `COK_FAZLA_DENEME` | Sınır aşımı; `Retry-After` başlığı ve `yenidenDenemeSn` alanı gelir |
| 502 | `SUNUCU` | Cihaza ulaşılamadı / cihaz hatası |
| 503 | `MESGUL` | Cihazın eşzamanlı oynatma kapasitesi dolu |

## 2. Yetki modeli

### İzinler
| İzin | Açıklama |
|---|---|
| `canli.izle` | Canlı görüntü ve anlık görüntü |
| `kayit.listele` | Kayıt listesi |
| `kayit.izle` | Kayıttan oynatma |
| `kayit.indir` | Kayıt indirme |
| `cihaz.oku` | Cihaz, disk, saat bilgisi |
| `cihaz.saat` | Cihaz saatini sunucuyla eşitleme |
| `cihaz.yonet` | Cihaz ekle/düzenle/sil, NVR'a kamera ekle |
| `kanal.yonet` | Kanal adı ve görünürlük |
| `uye.yonet` | Üyeleri yönetme |
| `gunluk.oku` | Denetim günlüğü |
| `yetki.yonet` | Roller ve tüm API anahtarları |
| `api.anahtar` | Yalnız kendi API anahtarları |

Joker: `*` (hepsi) ve `grup.*` (örn. `kayit.*`). Özel rollerde `*` kullanılamaz.

### Yerleşik roller
`admin` (hepsi; değiştirilemez) · `network` · `teknik` · `muhasebe` (DC panelleriyle aynı roller: izinsiz başlar; adları sabittir ve silinmezler, yalnızca izin listesi `PATCH /roller/{id}` ile `{izinler: [...]}` gönderilerek değiştirilir). Özel roller `POST /roller` ile açılır. Üye eklerken rol zorunludur; merkezle girenlerin rolü merkezdeki aynı adlı rolden gelir.

### Kapsam (kamera erişim listesi)
Üye ve anahtarlara `kapsam` verilebilir: `{"cihazlar":["<cihazId>"], "kanallar":[0,5]}`. Kapsamı olan bir asal yalnız bu kameraları görür; diğer kanallar `/kameralar` listesinde gizlenir, erişim denemesi `403 KAPSAM_DISI` döner. `null` = kısıtsız.

### Yetki yükseltme kuralı
Hiç kimse sahip olmadığı bir izni ya da kapsamı dışındaki bir kamerayı başkasına (üye, rol, anahtar) veremez. İhlal `403 YETKI_YUKSELTME` döner. Aynı kural **mevcut** üyeye de uygulanır: izinleri sizinkinden geniş (ya da kapsamı sizinkinin dışında) bir üyenin parolasını sıfırlayamaz, rolünü değiştiremez, silemezsiniz. Hesap bağları da taşınır: kısıtlı (bitiş/IP listesi olan) bir üye ya da anahtar, kendinden gevşek bitişli/IP'siz üye ya da anahtar üretemez; yeni anahtar varsayılan olarak üreticinin IP listesini ve bitişini alır.

### API anahtarı = sahibinin türevi
Anahtarın `sahip`i (üye) silinmişse süresi dolmuşsa, IP listesi dışındaysa ya da KYM'de erişimi kalkmışsa anahtar da çalışmaz; izinleri ve kapsamı sahibinin **güncel** rolünü aşmaz. Üye silinince anahtarları iptal edilir. `sahip`i üye olmayan (yetki.yonet'in verdiği entegrasyon etiketi) anahtar kendi haklarıyla çalışır. Çıkış yapmak ya da parolayı değiştirmek o üyenin tüm oturum çerezlerini geçersiz kılar.

### Sınırlar
Her anahtarın **hız limiti** (istek/dk, varsayılan 120) ve **eşzamanlı akış** sınırı (varsayılan 4) vardır; üyeler için 1200 istek/dk ve 16 akış. IP/CIDR listesi verilen anahtar yalnız o adreslerden çalışır. 10 ardışık geçersiz anahtar denemesinde IP 5 dakika kilitlenir.

## 3. Kanal numaraları
Panel tüm cihazların kanallarını tek bir listede numaralar: her cihazın kalıcı bir **başlangıç** değeri vardır (`GET /cihazlar` → `baslangic`, `kanalSayisi`). Global kanal = `baslangic + cihazdaki sıra`. Görünen ad `D1 (Kanal 1)` biçimindedir (`kod` + ad).

## 4. Uç noktalar

### Genel
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1` | kimlik | Sürüm ve bağlantılar |
| GET | `/api/v1/saglik` | — (yalnız konteynerin kendi 127.0.0.1 adresinden) | Canlılık (`tamam`); başka adreslerden 404. Konteyner HEALTHCHECK'i kullanır |
| GET | `/api/v1/ben` | kimlik | Kim olduğunuz: tür, yöntem, izinler, kapsam, bitiş, hız limiti |
| GET | `/api/v1/izinler` | yetki.yonet \| api.anahtar \| uye.yonet | İzin kataloğu (tr/en açıklamalı) |

### Kameralar
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/kameralar` | canli.izle \| kayit.* \| cihaz.oku | Kapsamınızdaki kameralar: `kanal`, `kod`, `ad`, `cihaz`, `bos`, `kamera` |
| GET | `/api/v1/kameralar/{kanal}/goruntu` | canli.izle | Anlık görüntü (`image/jpeg`, ana akış) |
| GET | `/api/v1/kameralar/{kanal}/canli?tur=Main\|Extra1\|Mini&ham=1` | canli.izle | Canlı MJPEG. `ham=1`: ardışık JPEG baytları; yoksa `multipart/x-mixed-replace`. `Mini` = 320 px/5 kare (mobil) |
| GET | `/api/v1/kameralar/{kanal}/kayitlar?gun=YYYY-AA-GG&gun2=` | kayit.listele | Kayıt dilimleri: `ad`, `bas`, `bit`, `boyut` (tahmini), `tur` (R sürekli, M hareket, A alarm) |
| GET | `/api/v1/kameralar/{kanal}/oynat?bas=&bit=&ham=1&g=960` | kayit.izle | Kayıttan oynatma (MJPEG). `bas`/`bit`: `YYYY-AA-GG SS:DD:SS` |
| GET | `/api/v1/kameralar/{kanal}/indir?dosya=&bas=&bit=` | kayit.indir | mp4 indirme (`Content-Disposition`), cihazdan doğrudan akar; `dosya` = kayıt listesindeki `ad` |

Akış uçları her anahtar için eşzamanlı akış sınırına tabidir (`429 AKIS_SINIRI`).

### Cihazlar
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/cihazlar` | cihaz.oku | Cihaz listesi (`id`, `ad`, `tur`, `ana`, `etiket`, `kanalSayisi`, `baslangic`, `hata`) + tür kataloğu |
| GET | `/api/v1/cihazlar/bilgi` | cihaz.oku | Birleşik bilgi: kanal adları, boş kanallar, diskler (sıcaklık/durum), saat |
| POST | `/api/v1/cihazlar` | cihaz.yonet | Cihaz ekle: `{tur, ana, kullanici, parola, ad?, etiket?, kanalSayisi?, httpPort?, rtspPort?, port?, sablon?, yol?}`; kaydetmeden önce bağlantı denenir |
| PATCH | `/api/v1/cihazlar/{id}` | cihaz.yonet | Düzenle (verilmeyen alan değişmez; boş `parola` değişmez — ama `ana` ya da bir port değişiyorsa `parola` yeniden verilmeli, aksi halde 400) |
| DELETE | `/api/v1/cihazlar/{id}` | cihaz.yonet | Panelden kaldır (cihazdaki kayıtlar etkilenmez; son cihaz silinemez) |
| POST | `/api/v1/cihazlar/{id}/kameralar` | cihaz.yonet | NVR'a kamera kaydet (Hikvision): `{ad, ip, kullanici, parola, protokol: HIKVISION\|ONVIF, port?}` |
| POST | `/api/v1/cihazlar/saat` | cihaz.saat | `{cihaz: "<id>"}` cihaz saatini sunucuya eşitle |
| PUT | `/api/v1/kanallar` | kanal.yonet | Kanal ayarı `{ayar: {"<kanal>": {ad, gorunum: otomatik\|goster\|gizle}}, bas?, son?}` (aralık verilirse yalnız o cihaz) |

Tür kataloğu: `uniview` (NVR, 32 kanal), `hikvision` (NVR, 16), `xiongmai` (DVR, 4, `port` 34567), `kamera` (tek IP kamera, `sablon`: hikvision/dahua/uniview/ozel + `yol`).

### Üyeler
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/uyeler` | uye.yonet | `ad, rol, olusturma, kapsam, bitis, ipler` |
| POST | `/api/v1/uyeler` | uye.yonet | `{ad, parola (≥8), rol, kapsam?, bitis?, ipler?}` |
| PATCH | `/api/v1/uyeler/{ad}` | uye.yonet | `{parola?, rol?, kapsam?, bitis?, ipler?}` (son admin korunur; kendinden yetkili üye değiştirilemez; kendi `bitis`/`ipler` kısıtını gevşetemezsiniz; parola değişince o üyenin oturumları kapanır) |
| DELETE | `/api/v1/uyeler/{ad}` | uye.yonet | Sil |

### Roller
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/roller` | yetki.yonet \| api.anahtar \| uye.yonet | Yerleşik + özel roller |
| POST | `/api/v1/roller` | yetki.yonet | `{id (a-z0-9_-), ad: "..."\|{tr,en}, aciklama?, izinler: [...]}` |
| PATCH | `/api/v1/roller/{id}` | yetki.yonet | Özel rolü düzenle; DC rollerinde (network, teknik, muhasebe) yalnız `{izinler}` |
| DELETE | `/api/v1/roller/{id}` | yetki.yonet | Kullanımda değilse sil |

### API anahtarları
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/anahtarlar?sahip=` | yetki.yonet \| api.anahtar | Liste (api.anahtar: yalnız kendininkiler) |
| POST | `/api/v1/anahtarlar` | yetki.yonet \| api.anahtar | `{ad, rol?, izinler?, kapsam?, bitis?, ipler?, hizLimiti?, eszamanliAkis?, notlar?, sahip?}` → `{kayit, anahtar}` (anahtar bir kez) |
| GET | `/api/v1/anahtarlar/{id}` | … | Kayıt (gizli yok): `onek`, `izinlerEfektif`, `aktif`, `sonKullanim`, `sayac` |
| PATCH | `/api/v1/anahtarlar/{id}` | … | Alanları düzenle |
| POST | `/api/v1/anahtarlar/{id}/yenile` | … | Yeni gizli; eskisi geçersiz |
| POST | `/api/v1/anahtarlar/{id}/iptal` | … | Kalıcı iptal (geri alınamaz; kayıt kalır) |
| DELETE | `/api/v1/anahtarlar/{id}` | … | Kaydı sil |


### Günlük
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/gunluk?sayfa=&boyut=&olay=&kullanici=&ip=&gun=` | gunluk.oku | Denetim kayıtları (en yeni üstte): IP, port, UA, vekil başlıkları, olay ayrıntısı |
| GET | `/api/v1/gunluk/dogrula` | gunluk.oku | HMAC zincirini doğrular (`tamam`, `kayit`) |

Olaylar: `giris`, `giris-hata`, `oynatma`, `indirme-istek`, `indirme-teslim`, `indirme-yarim`, `uye-ekle/duzenle/sil`, `rol-ekle/duzenle/sil`, `anahtar-olustur/duzenle/yenile/iptal/sil`, `cihaz-ekle/duzenle/sil`, `nvr-kamera-ekle`, `kanal-ayari`, `saat-ayari`. Anahtarla yapılan işlemler `anahtar:<id>` adıyla yazılır.

## 5. Örnekler

```bash
# anahtar oluştur (admin oturumu/anahtarı ile)
curl -X POST http://SUNUCU/api/v1/anahtarlar -H "Authorization: Bearer kp_..." \
  -H "Content-Type: application/json" -d '{"ad":"vms","rol":"teknik","kapsam":{"cihazlar":["7d228e49"]},"hizLimiti":300}'

# kameralar
curl http://SUNUCU/api/v1/kameralar -H "Authorization: Bearer kp_..."
# anlık görüntü
curl -o kare.jpg http://SUNUCU/api/v1/kameralar/0/goruntu -H "Authorization: Bearer kp_..."
# kayıt listesi ve indirme
curl "http://SUNUCU/api/v1/kameralar/0/kayitlar?gun=2026-10-05" -H "Authorization: Bearer kp_..."
curl -o kayit.mp4 "http://SUNUCU/api/v1/kameralar/0/indir?dosya=/nvr/c1/1791151200.h264&bas=2026-10-05%2003:00:00&bit=2026-10-05%2003:15:00" -H "Authorization: Bearer kp_..."
```

## 6. Güvenlik notları
- Panel düz HTTP'de ise anahtarlar ağda açık gider: önüne TLS (Cloudflare/nginx) koyun; ters vekil kullanıyorsanız `KAMERA_IP_BASLIGI=CF-Connecting-IP` ayarlayın (yoksa IP listeleri soket adresine göre çalışır).
- Anahtarlara en dar izin ve kapsamı verin; üçüncü tarafa ayrı, kapsamı ve süresi sınırlı bir anahtar açın.
- Parolalar scrypt ile, cihaz parolaları AES-256-GCM ile, anahtarlar HMAC özetiyle saklanır; günlükte hiçbir gizli yazılmaz.
- Yanıt başlıkları: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HTTPS'de HSTS.
