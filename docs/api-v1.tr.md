# Kamera Paneli API v1 — Türkçe

Sürüm: v1 · Taban adres: `http://SERVER:PORT/api/v1` · İngilizce: [api-v1.en.md](api-v1.en.md) · OpenAPI: [openapi.json](openapi.json)

Bu API; NVR/DVR/IP kameralardan **canlı görüntü**, **anlık görüntü**, **kayıt listesi**, **kayıttan oynatma** ve **kayıt indirme** sunar; ayrıca cihaz, üye, rol, API anahtarı ve denetim günlüğü yönetimi içerir. Tüm yanıtlar JSON'dur (akış uçları hariç). Tüm zamanlar cihazın **yerel saati** ile `YYYY-AA-GG SS:DD:SS` biçimindedir.

## 1. Kimlik doğrulama

İki yol vardır; ikisi de aynı uçlara erişir:

| Yöntem | Nasıl | Kullanım yeri |
|---|---|---|
| **API anahtarı** | `Authorization: Bearer kp_<id>_<gizli>` | Sunucudan sunucuya, entegrasyonlar |
| **Oturum çerezi** | Panelden giriş (`POST /api/login`); durum değiştiren isteklerde `X-Cam: 1` başlığı zorunlu (CSRF) | Panel arayüzü |

API anahtarı yalnız **oluşturma/yenileme yanıtında bir kez** gösterilir; sunucuda yalnız HMAC özeti saklanır. Kaybedilirse `POST /api/v1/keys/{id}/rotate` ile yenisi üretilir (kimlik aynı kalır, eski gizli geçersiz olur).

### Hata yanıtı
```json
{ "error": "Bu işlem için izin gerekir: recording.download", "code": "PERMISSION_DENIED", "requiredPermission": "recording.download" }
```
| HTTP | code | Anlamı |
|---|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_JSON` | Girdi hatalı |
| 401 | `LOGIN_REQUIRED`, `INVALID_KEY`, `KEY_REVOKED`, `EXPIRED` | Kimlik yok/geçersiz |
| 403 | `PERMISSION_DENIED`, `OUT_OF_SCOPE`, `IP_BLOCKED`, `PRIVILEGE_ESCALATION`, `CSRF`, `BUILTIN_IMMUTABLE` | Yetki yok |
| 404 | `NOT_FOUND` | Kaynak yok |
| 405 | `METHOD_NOT_ALLOWED` | Yöntem desteklenmiyor |
| 409 | `CONFLICT` | Çakışma (ad kullanılıyor, iptal edilmiş anahtar…) |
| 413 | `BODY_TOO_LARGE` | Gövde > 1 MB |
| 429 | `RATE_LIMIT`, `STREAM_LIMIT`, `TOO_MANY_ATTEMPTS` | Sınır aşımı; `Retry-After` başlığı ve `retryAfterSec` alanı gelir |
| 502 | `SERVER` | Cihaza ulaşılamadı / cihaz hatası |
| 503 | `BUSY` | Cihazın eşzamanlı oynatma kapasitesi dolu |

## 2. Yetki modeli

### İzinler
| İzin | Açıklama |
|---|---|
| `live.view` | Canlı görüntü ve anlık görüntü |
| `recording.list` | Kayıt listesi |
| `recording.play` | Kayıttan oynatma |
| `recording.download` | Kayıt indirme |
| `device.read` | Cihaz, disk, saat bilgisi |
| `device.clock` | Cihaz saatini sunucuyla eşitleme |
| `device.manage` | Cihaz ekle/düzenle/sil, NVR'a kamera ekle |
| `channel.manage` | Kanal adı ve görünürlük |
| `member.manage` | Üyeleri yönetme |
| `audit.read` | Denetim günlüğü |
| `permission.manage` | Roller ve tüm API anahtarları |
| `api.key` | Yalnız kendi API anahtarları |

Joker: `*` (hepsi) ve `grup.*` (örn. `recording.*`). Özel rollerde `*` kullanılamaz.

### Yerleşik roller
`admin` (hepsi; değiştirilemez) · `network` · `technical` · `accounting` (DC panelleriyle aynı roller: izinsiz başlar; adları sabittir ve silinmezler, yalnızca izin listesi `PATCH /roles/{id}` ile `{permissions: [...]}` gönderilerek değiştirilir). Özel roller `POST /roles` ile açılır. Üye eklerken rol zorunludur; merkezle girenlerin rolü merkezdeki aynı adlı rolden gelir.

### Kapsam (kamera erişim listesi)
Üye ve anahtarlara `scope` verilebilir: `{"devices":["<cihazId>"], "channels":[0,5]}`. Kapsamı olan bir asal yalnız bu kameraları görür; diğer kanallar `/cameras` listesinde gizlenir, erişim denemesi `403 OUT_OF_SCOPE` döner. `null` = kısıtsız.

### Yetki yükseltme kuralı
Hiç kimse sahip olmadığı bir izni ya da kapsamı dışındaki bir kamerayı başkasına (üye, rol, anahtar) veremez. İhlal `403 PRIVILEGE_ESCALATION` döner. Aynı kural **mevcut** üyeye de uygulanır: izinleri sizinkinden geniş (ya da kapsamı sizinkinin dışında) bir üyenin parolasını sıfırlayamaz, rolünü değiştiremez, silemezsiniz. Hesap bağları da taşınır: kısıtlı (bitiş/IP listesi olan) bir üye ya da anahtar, kendinden gevşek bitişli/IP'siz üye ya da anahtar üretemez; yeni anahtar varsayılan olarak üreticinin IP listesini ve bitişini alır.

### API anahtarı = sahibinin türevi
Anahtarın `owner` alanı (üye) silinmişse süresi dolmuşsa, IP listesi dışındaysa ya da KYM'de erişimi kalkmışsa anahtar da çalışmaz; izinleri ve kapsamı sahibinin **güncel** rolünü aşmaz. Üye silinince anahtarları iptal edilir. `owner`i üye olmayan (permission.manage'in verdiği entegrasyon etiketi) anahtar kendi haklarıyla çalışır. Çıkış yapmak ya da parolayı değiştirmek o üyenin tüm oturum çerezlerini geçersiz kılar.

### Sınırlar
Her anahtarın **hız limiti** (istek/dk, varsayılan 120) ve **eşzamanlı akış** sınırı (varsayılan 4) vardır; üyeler için 1200 istek/dk ve 16 akış. IP/CIDR listesi verilen anahtar yalnız o adreslerden çalışır. 10 ardışık geçersiz anahtar denemesinde IP 5 dakika kilitlenir.

## 3. Kanal numaraları
Panel tüm cihazların kanallarını tek bir listede numaralar: her cihazın kalıcı bir **başlangıç** değeri vardır (`GET /devices` → `startIndex`, `channelCount`). Global kanal = `startIndex + cihazdaki sıra`. Görünen ad `D1 (Kanal 1)` biçimindedir (`code` + ad).

## 4. Uç noktalar

### Genel
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1` | kimlik | Sürüm ve bağlantılar |
| GET | `/api/v1/health` | — (yalnız konteynerin kendi 127.0.0.1 adresinden) | Canlılık (`ok`); başka adreslerden 404. Konteyner HEALTHCHECK'i kullanır |
| GET | `/api/v1/me` | kimlik | Kim olduğunuz: tür, yöntem, izinler, kapsam, bitiş, hız limiti |
| GET | `/api/v1/permissions` | permission.manage \| api.key \| member.manage | İzin kataloğu (tr/en açıklamalı) |

### Kameralar
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/cameras` | live.view \| recording.* \| device.read | Kapsamınızdaki kameralar: `channel`, `code`, `name`, `device`, `empty`, `camera` |
| GET | `/api/v1/cameras/{channel}/snapshot` | live.view | Anlık görüntü (`image/jpeg`, ana akış) |
| GET | `/api/v1/cameras/{channel}/live?type=Main\|Extra1\|Mini&raw=1` | live.view | Canlı MJPEG. `raw=1`: ardışık JPEG baytları; yoksa `multipart/x-mixed-replace`. `Mini` = 320 px/5 kare (mobil) |
| GET | `/api/v1/cameras/{channel}/recordings?day=YYYY-AA-GG&dayEnd=` | recording.list | Kayıt dilimleri: `name`, `from`, `to`, `size` (tahmini), `type` (R sürekli, M hareket, A alarm) |
| GET | `/api/v1/cameras/{channel}/playback?from=&to=&raw=1&g=960` | recording.play | Kayıttan oynatma (MJPEG). `from`/`to`: `YYYY-AA-GG SS:DD:SS` |
| GET | `/api/v1/cameras/{channel}/download?file=&from=&to=` | recording.download | mp4 indirme (`Content-Disposition`), cihazdan doğrudan akar; `file` = kayıt listesindeki `name` |

Akış uçları her anahtar için eşzamanlı akış sınırına tabidir (`429 STREAM_LIMIT`).

### Cihazlar
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/devices` | device.read | Cihaz listesi (`id`, `name`, `type`, `host`, `label`, `channelCount`, `startIndex`, `error`) + tür kataloğu |
| GET | `/api/v1/devices/info` | device.read | Birleşik bilgi: kanal adları, boş kanallar, diskler (sıcaklık/durum), saat |
| POST | `/api/v1/devices` | device.manage | Cihaz ekle: `{type, host, username, password, name?, label?, channelCount?, httpPort?, rtspPort?, port?, template?, path?}`; kaydetmeden önce bağlantı denenir |
| PATCH | `/api/v1/devices/{id}` | device.manage | Düzenle (verilmeyen alan değişmez; boş `password` değişmez — ama `host` ya da bir port değişiyorsa `password` yeniden verilmeli, aksi halde 400) |
| DELETE | `/api/v1/devices/{id}` | device.manage | Panelden kaldır (cihazdaki kayıtlar etkilenmez; son cihaz silinemez) |
| POST | `/api/v1/devices/{id}/cameras` | device.manage | NVR'a kamera kaydet (Hikvision): `{name, ip, username, password, protocol: HIKVISION\|ONVIF, port?}` |
| POST | `/api/v1/devices/clock` | device.clock | `{device: "<id>"}` cihaz saatini sunucuya eşitle |
| PUT | `/api/v1/channels` | channel.manage | Kanal ayarı `{setting: {"<channel>": {name, view: auto\|show\|hide}}, from?, last?}` (aralık verilirse yalnız o cihaz) |

Tür kataloğu: `uniview` (NVR, 32 kanal), `hikvision` (NVR, 16), `xiongmai` (DVR, 4, `port` 34567), `camera` (tek IP kamera, `template`: hikvision/dahua/uniview/custom + `path`).

### Üyeler
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/members` | member.manage | `name, role, createdAt, scope, expiresAt, ips` |
| POST | `/api/v1/members` | member.manage | `{name, password (≥8), role, scope?, expiresAt?, ips?}` |
| PATCH | `/api/v1/members/{name}` | member.manage | `{password?, role?, scope?, expiresAt?, ips?}` (son admin korunur; kendinden yetkili üye değiştirilemez; kendi `expiresAt`/`ips` kısıtını gevşetemezsiniz; parola değişince o üyenin oturumları kapanır) |
| DELETE | `/api/v1/members/{name}` | member.manage | Sil |

### Roller
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/roles` | permission.manage \| api.key \| member.manage | Yerleşik + özel roller |
| POST | `/api/v1/roles` | permission.manage | `{id (a-z0-9_-), name: "..."\|{tr,en}, description?, permissions: [...]}` |
| PATCH | `/api/v1/roles/{id}` | permission.manage | Özel rolü düzenle; DC rollerinde (network, technical, accounting) yalnız `{permissions}` |
| DELETE | `/api/v1/roles/{id}` | permission.manage | Kullanımda değilse sil |

### API anahtarları
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/keys?owner=` | permission.manage \| api.key | Liste (api.key: yalnız kendininkiler) |
| POST | `/api/v1/keys` | permission.manage \| api.key | `{name, role?, permissions?, scope?, expiresAt?, ips?, rateLimit?, concurrentStreams?, notes?, owner?}` → `{record, key}` (anahtar bir kez) |
| GET | `/api/v1/keys/{id}` | … | Kayıt (gizli yok): `prefix`, `permissionsEffective`, `active`, `lastUsed`, `counter` |
| PATCH | `/api/v1/keys/{id}` | … | Alanları düzenle |
| POST | `/api/v1/keys/{id}/rotate` | … | Yeni gizli; eskisi geçersiz |
| POST | `/api/v1/keys/{id}/revoke` | … | Kalıcı iptal (geri alınamaz; kayıt kalır) |
| DELETE | `/api/v1/keys/{id}` | … | Kaydı sil |


### Günlük
| Yöntem | Yol | İzin | Açıklama |
|---|---|---|---|
| GET | `/api/v1/audit-log?page=&size=&event=&username=&ip=&day=` | audit.read | Denetim kayıtları (en yeni üstte): IP, port, UA, vekil başlıkları, olay ayrıntısı |
| GET | `/api/v1/audit-log/verify` | audit.read | HMAC zincirini doğrular (`ok`, `record`) |

Olaylar: `login`, `login-failed`, `playback`, `download-request`, `download-complete`, `download-partial`, `member-add/edit/delete`, `role-add/edit/delete`, `key-create/edit/rotate/revoke/delete`, `device-add/edit/delete`, `nvr-camera-add`, `channel-settings`, `clock-sync`, `logout`, plus the centre sign-in events (`hub-login`, `hub-login-denied`, `hub-login-error`, ...). Anahtarla yapılan işlemler `key:<id>` adıyla yazılır.

## 5. Örnekler

```bash
# anahtar oluştur (admin oturumu/anahtarı ile)
curl -X POST http://SERVER/api/v1/keys -H "Authorization: Bearer kp_..." \
  -H "Content-Type: application/json" -d '{"name":"vms","role":"technical","scope":{"devices":["7d228e49"]},"rateLimit":300}'

# cameras
curl http://SERVER/api/v1/cameras -H "Authorization: Bearer kp_..."
# anlık görüntü
curl -o frame.jpg http://SERVER/api/v1/cameras/0/snapshot -H "Authorization: Bearer kp_..."
# kayıt listesi ve indirme
curl "http://SERVER/api/v1/cameras/0/recordings?day=2026-10-05" -H "Authorization: Bearer kp_..."
curl -o recording.mp4 "http://SERVER/api/v1/cameras/0/download?file=/nvr/c1/1791151200.h264&from=2026-10-05%2003:00:00&to=2026-10-05%2003:15:00" -H "Authorization: Bearer kp_..."
```

## 6. Güvenlik notları
- Panel düz HTTP'de ise anahtarlar ağda açık gider: önüne TLS (Cloudflare/nginx) koyun; ters vekil kullanıyorsanız `CAM_IP_HEADER=CF-Connecting-IP` ayarlayın (yoksa IP listeleri soket adresine göre çalışır).
- Anahtarlara en dar izin ve kapsamı verin; üçüncü tarafa ayrı, kapsamı ve süresi sınırlı bir anahtar açın.
- Parolalar scrypt ile, cihaz parolaları AES-256-GCM ile, anahtarlar HMAC özetiyle saklanır; günlükte hiçbir gizli yazılmaz.
- Yanıt başlıkları: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HTTPS'de HSTS.
