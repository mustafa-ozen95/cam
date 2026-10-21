# Camera Panel API v1 — English

Version: v1 · Base URL: `http://SERVER:PORT/api/v1` · Turkish: [api-v1.tr.md](api-v1.tr.md) · OpenAPI: [openapi.json](openapi.json)

The API serves **live video**, **snapshots**, **recording lists**, **playback** and **recording downloads** from NVR/DVR/IP cameras, plus management of devices, members, roles, API keys and the audit log. All responses are JSON except the streaming endpoints. All timestamps use the device's **local time** in `YYYY-MM-DD HH:MM:SS`.

## 1. Authentication

| Method | How | Use |
|---|---|---|
| **API key** | `Authorization: Bearer kp_<id>_<secret>` | Server-to-server integrations |
| **Session cookie** | Panel login (`POST /api/giris`); state-changing requests must send `X-Kamera: 1` (CSRF) | Panel UI |

An API key secret is shown **once**, in the create/rotate response; the server stores only an HMAC digest. If lost, `yenile` (rotate) issues a new secret (same id; the old secret becomes invalid).

### Error response
```json
{ "hata": "Bu işlem için izin gerekir: kayit.indir", "kod": "YETKI_YOK", "gerekenIzin": "kayit.indir" }
```
| HTTP | code | Meaning |
|---|---|---|
| 400 | `GECERSIZ_ISTEK`, `GECERSIZ_JSON` | Bad input |
| 401 | `OTURUM_GEREKLI`, `GECERSIZ_ANAHTAR`, `ANAHTAR_IPTAL`, `SURESI_DOLDU` | Missing/invalid credentials |
| 403 | `YETKI_YOK`, `KAPSAM_DISI`, `IP_ENGELLI`, `YETKI_YUKSELTME`, `CSRF`, `YERLESIK_DEGISMEZ` | Forbidden |
| 404 | `BULUNAMADI` | Not found |
| 405 | `YONTEM` | Method not allowed |
| 409 | `CAKISMA` | Conflict |
| 413 | `GOVDE_BUYUK` | Body > 1 MB |
| 429 | `HIZ_SINIRI`, `AKIS_SINIRI`, `COK_FAZLA_DENEME` | Limit exceeded; `Retry-After` header and `yenidenDenemeSn` |
| 502 | `SUNUCU` | Device unreachable / device error |
| 503 | `MESGUL` | Device playback capacity full |

## 2. Authorization model

### Permissions
| Permission | Description |
|---|---|
| `canli.izle` | Live view and snapshots |
| `kayit.listele` | List recordings |
| `kayit.izle` | Play back recordings |
| `kayit.indir` | Download recordings |
| `cihaz.oku` | Device, disk and clock info |
| `cihaz.saat` | Sync device clock to server |
| `cihaz.yonet` | Add/edit/remove devices, add cameras to NVRs |
| `kanal.yonet` | Channel names and visibility |
| `uye.yonet` | Manage members |
| `gunluk.oku` | Audit log |
| `yetki.yonet` | Roles and all API keys |
| `api.anahtar` | Own API keys only |

Wildcards: `*` (everything) and `group.*` (e.g. `kayit.*`). Custom roles may not use `*`.

### Built-in roles
`admin` (all; immutable) · `network` · `teknik` · `muhasebe` (same roles as the DC panels: they start with no permissions; their names are fixed and they cannot be deleted, only their permission list can be changed with `PATCH /roller/{id}` sending `{izinler: [...]}`). Custom roles via `POST /roller`. A role is required when adding a member; users signing in via the centre get the role of the same name from the centre.

### Scope (camera access list)
Members and keys may carry a `kapsam`: `{"cihazlar":["<deviceId>"], "kanallar":[0,5]}`. A scoped principal only sees those cameras; others are hidden from `/kameralar` and access attempts return `403 KAPSAM_DISI`. `null` = unrestricted.

### No privilege escalation
Nobody can grant a permission they lack, or a camera outside their own scope, to anyone (member, role, key). Violations return `403 YETKI_YUKSELTME`. The same rule applies to **existing** members: you cannot reset the password of, change the role of, or delete a member whose permissions exceed yours (or whose scope lies outside yours). Account bindings carry over too: a restricted member or key (expiry / IP list) cannot create members or keys with a looser expiry or without an IP list; a new key inherits its creator's IP list and expiry by default.

### An API key derives from its owner
If the key's `sahip` (member) is deleted, expired, outside its IP list or revoked in the KYM, the key stops working; its permissions and scope never exceed the owner's **current** role. Deleting a member revokes its keys. A key whose `sahip` is not a member (an integration label assigned by yetki.yonet) works with its own rights. Logging out or changing the password ends all of that member's session cookies.

### Limits
Each key has a **rate limit** (requests/min, default 120) and a **concurrent stream** limit (default 4); members get 1200/min and 16 streams. Keys with an IP/CIDR list only work from those addresses. After 10 consecutive invalid key attempts an IP is locked for 5 minutes.

## 3. Channel numbering
All devices' channels form one global list: each device has a persistent `baslangic` (start) and `kanalSayisi` (`GET /cihazlar`). Global channel = `baslangic + index on device`. Display names look like `D1 (Kanal 1)` (`kod` + name).

## 4. Endpoints

### General
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1` | auth | Version and links |
| GET | `/api/v1/saglik` | — (only from the container's own 127.0.0.1) | Liveness (`tamam`); 404 from any other address. Used by the container HEALTHCHECK |
| GET | `/api/v1/ben` | auth | Who you are: type, method, permissions, scope, expiry, rate limit |
| GET | `/api/v1/izinler` | yetki.yonet \| api.anahtar \| uye.yonet | Permission catalogue (tr/en) |

### Cameras
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/kameralar` | canli.izle \| kayit.* \| cihaz.oku | Cameras in your scope: `kanal`, `kod`, `ad`, `cihaz`, `bos`, `kamera` |
| GET | `/api/v1/kameralar/{kanal}/goruntu` | canli.izle | Snapshot (`image/jpeg`, main stream) |
| GET | `/api/v1/kameralar/{kanal}/canli?tur=Main\|Extra1\|Mini&ham=1` | canli.izle | Live MJPEG. `ham=1`: concatenated JPEG bytes; otherwise `multipart/x-mixed-replace`. `Mini` = 320 px / 5 fps |
| GET | `/api/v1/kameralar/{kanal}/kayitlar?gun=YYYY-MM-DD&gun2=` | kayit.listele | Recording segments: `ad`, `bas`, `bit`, `boyut` (estimate), `tur` (R continuous, M motion, A alarm) |
| GET | `/api/v1/kameralar/{kanal}/oynat?bas=&bit=&ham=1&g=960` | kayit.izle | Playback (MJPEG) |
| GET | `/api/v1/kameralar/{kanal}/indir?dosya=&bas=&bit=` | kayit.indir | mp4 download, streamed straight from the device; `dosya` = `ad` from the list |

Streaming endpoints are subject to the per-key concurrent stream limit (`429 AKIS_SINIRI`).

### Devices
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/cihazlar` | cihaz.oku | Devices (`id`, `ad`, `tur`, `ana`, `etiket`, `kanalSayisi`, `baslangic`, `hata`) + type catalogue |
| GET | `/api/v1/cihazlar/bilgi` | cihaz.oku | Merged info: channel names, empty channels, disks (temperature/status), clocks |
| POST | `/api/v1/cihazlar` | cihaz.yonet | Add: `{tur, ana, kullanici, parola, ad?, etiket?, kanalSayisi?, httpPort?, rtspPort?, port?, sablon?, yol?}`; connection is tested first |
| PATCH | `/api/v1/cihazlar/{id}` | cihaz.yonet | Edit (omitted fields unchanged; empty `parola` keeps the old one — but if `ana` or a port changes, `parola` must be supplied again or the request fails with 400) |
| DELETE | `/api/v1/cihazlar/{id}` | cihaz.yonet | Remove from panel (device recordings untouched; last device cannot be removed) |
| POST | `/api/v1/cihazlar/{id}/kameralar` | cihaz.yonet | Register a camera on an NVR (Hikvision): `{ad, ip, kullanici, parola, protokol: HIKVISION\|ONVIF, port?}` |
| POST | `/api/v1/cihazlar/saat` | cihaz.saat | `{cihaz: "<id>"}` sync device clock to server |
| PUT | `/api/v1/kanallar` | kanal.yonet | Channel settings `{ayar: {"<kanal>": {ad, gorunum: otomatik\|goster\|gizle}}, bas?, son?}` |

Types: `uniview` (NVR, 32 ch), `hikvision` (NVR, 16), `xiongmai` (DVR, 4, `port` 34567), `kamera` (single IP camera; `sablon`: hikvision/dahua/uniview/ozel + `yol`).

### Members
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/uyeler` | uye.yonet | `ad, rol, olusturma, kapsam, bitis, ipler` |
| POST | `/api/v1/uyeler` | uye.yonet | `{ad, parola (≥8), rol, kapsam?, bitis?, ipler?}` |
| PATCH | `/api/v1/uyeler/{ad}` | uye.yonet | `{parola?, rol?, kapsam?, bitis?, ipler?}` (last admin protected; members with more authority than you cannot be changed; you cannot loosen your own `bitis`/`ipler` restriction; a password change ends that member's sessions) |
| DELETE | `/api/v1/uyeler/{ad}` | uye.yonet | Delete |

### Roles
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/roller` | yetki.yonet \| api.anahtar \| uye.yonet | Built-in + custom roles |
| POST | `/api/v1/roller` | yetki.yonet | `{id (a-z0-9_-), ad: "..."\|{tr,en}, aciklama?, izinler: [...]}` |
| PATCH | `/api/v1/roller/{id}` | yetki.yonet | Edit custom role; for DC roles (network, teknik, muhasebe) only `{izinler}` |
| DELETE | `/api/v1/roller/{id}` | yetki.yonet | Delete if unused |

### API keys
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/anahtarlar?sahip=` | yetki.yonet \| api.anahtar | List (api.anahtar: own keys only) |
| POST | `/api/v1/anahtarlar` | yetki.yonet \| api.anahtar | `{ad, rol?, izinler?, kapsam?, bitis?, ipler?, hizLimiti?, eszamanliAkis?, notlar?, sahip?}` → `{kayit, anahtar}` (secret once) |
| GET | `/api/v1/anahtarlar/{id}` | … | Record (no secret): `onek`, `izinlerEfektif`, `aktif`, `sonKullanim`, `sayac` |
| PATCH | `/api/v1/anahtarlar/{id}` | … | Edit fields |
| POST | `/api/v1/anahtarlar/{id}/yenile` | … | Rotate secret |
| POST | `/api/v1/anahtarlar/{id}/iptal` | … | Permanent revoke |
| DELETE | `/api/v1/anahtarlar/{id}` | … | Delete record |


### Audit log
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/gunluk?sayfa=&boyut=&olay=&kullanici=&ip=&gun=` | gunluk.oku | Entries, newest first: IP, port, UA, proxy headers, details |
| GET | `/api/v1/gunluk/dogrula` | gunluk.oku | Verifies the HMAC chain |

Events: `giris`, `giris-hata`, `oynatma`, `indirme-istek`, `indirme-teslim`, `indirme-yarim`, `uye-ekle/duzenle/sil`, `rol-ekle/duzenle/sil`, `anahtar-olustur/duzenle/yenile/iptal/sil`, `cihaz-ekle/duzenle/sil`, `nvr-kamera-ekle`, `kanal-ayari`, `saat-ayari`. Actions performed with a key are logged as `anahtar:<id>`.

## 5. Examples
```bash
curl -X POST http://SERVER/api/v1/anahtarlar -H "Authorization: Bearer kp_..." -H "Content-Type: application/json" \
  -d '{"ad":"vms","rol":"teknik","kapsam":{"cihazlar":["7d228e49"]},"hizLimiti":300}'
curl http://SERVER/api/v1/kameralar -H "Authorization: Bearer kp_..."
curl -o frame.jpg http://SERVER/api/v1/kameralar/0/goruntu -H "Authorization: Bearer kp_..."
```

## 6. Security notes
- Over plain HTTP keys travel in clear: put TLS in front (Cloudflare/nginx). Behind a reverse proxy set `KAMERA_IP_BASLIGI=CF-Connecting-IP`, otherwise IP lists use the socket address.
- Grant the narrowest permissions and scope; give third parties their own scoped, expiring key.
- Passwords: scrypt; device passwords: AES-256-GCM; keys: HMAC digest; secrets never reach the audit log.
- Response headers: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS on HTTPS.
