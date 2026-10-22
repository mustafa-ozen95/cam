# Camera Panel API v1 — English

Version: v1 · Base URL: `http://SERVER:PORT/api/v1` · Turkish: [api-v1.tr.md](api-v1.tr.md) · OpenAPI: [openapi.json](openapi.json)

The API serves **live video**, **snapshots**, **recording lists**, **playback** and **recording downloads** from NVR/DVR/IP cameras, plus management of devices, members, roles, API keys and the audit log. All responses are JSON except the streaming endpoints. All timestamps use the device's **local time** in `YYYY-MM-DD HH:MM:SS`.

## 1. Authentication

| Method | How | Use |
|---|---|---|
| **API key** | `Authorization: Bearer kp_<id>_<secret>` | Server-to-server integrations |
| **Session cookie** | Panel login (`POST /api/login`); state-changing requests must send `X-Cam: 1` (CSRF) | Panel UI |

An API key secret is shown **once**, in the create/rotate response; the server stores only an HMAC digest. If lost, `POST /api/v1/keys/{id}/rotate` issues a new secret (same id; the old secret becomes invalid).

### Error response
```json
{ "error": "Bu işlem için izin gerekir: recording.download", "code": "PERMISSION_DENIED", "requiredPermission": "recording.download" }
```
| HTTP | code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_JSON` | Bad input |
| 401 | `LOGIN_REQUIRED`, `INVALID_KEY`, `KEY_REVOKED`, `EXPIRED` | Missing/invalid credentials |
| 403 | `PERMISSION_DENIED`, `OUT_OF_SCOPE`, `IP_BLOCKED`, `PRIVILEGE_ESCALATION`, `CSRF`, `BUILTIN_IMMUTABLE` | Forbidden |
| 404 | `NOT_FOUND` | Not found |
| 405 | `METHOD_NOT_ALLOWED` | Method not allowed |
| 409 | `CONFLICT` | Conflict |
| 413 | `BODY_TOO_LARGE` | Body > 1 MB |
| 429 | `RATE_LIMIT`, `STREAM_LIMIT`, `TOO_MANY_ATTEMPTS` | Limit exceeded; `Retry-After` header and `retryAfterSec` |
| 502 | `SERVER` | Device unreachable / device error |
| 503 | `BUSY` | Device playback capacity full |

## 2. Authorization model

### Permissions
| Permission | Description |
|---|---|
| `live.view` | Live view and snapshots |
| `recording.list` | List recordings |
| `recording.play` | Play back recordings |
| `recording.download` | Download recordings |
| `device.read` | Device, disk and clock info |
| `device.clock` | Sync device clock to server |
| `device.manage` | Add/edit/remove devices, add cameras to NVRs |
| `channel.manage` | Channel names and visibility |
| `member.manage` | Manage members |
| `audit.read` | Audit log |
| `permission.manage` | Roles and all API keys |
| `api.key` | Own API keys only |

Wildcards: `*` (everything) and `group.*` (e.g. `recording.*`). Custom roles may not use `*`.

### Built-in roles
`admin` (all; immutable) · `network` · `technical` · `accounting` (same roles as the DC panels: they start with no permissions; their names are fixed and they cannot be deleted, only their permission list can be changed with `PATCH /roles/{id}` sending `{permissions: [...]}`). Custom roles via `POST /roles`. A role is required when adding a member; users signing in via the centre get the role of the same name from the centre.

### Scope (camera access list)
Members and keys may carry a `scope`: `{"devices":["<deviceId>"], "channels":[0,5]}`. A scoped principal only sees those cameras; others are hidden from `/cameras` and access attempts return `403 OUT_OF_SCOPE`. `null` = unrestricted.

### No privilege escalation
Nobody can grant a permission they lack, or a camera outside their own scope, to anyone (member, role, key). Violations return `403 PRIVILEGE_ESCALATION`. The same rule applies to **existing** members: you cannot reset the password of, change the role of, or delete a member whose permissions exceed yours (or whose scope lies outside yours). Account bindings carry over too: a restricted member or key (expiry / IP list) cannot create members or keys with a looser expiry or without an IP list; a new key inherits its creator's IP list and expiry by default.

### An API key derives from its owner
If the key's `owner` (member) is deleted, expired, outside its IP list or revoked in the KYM, the key stops working; its permissions and scope never exceed the owner's **current** role. Deleting a member revokes its keys. A key whose `owner` is not a member (an integration label assigned by permission.manage) works with its own rights. Logging out or changing the password ends all of that member's session cookies.

### Limits
Each key has a **rate limit** (requests/min, default 120) and a **concurrent stream** limit (default 4); members get 1200/min and 16 streams. Keys with an IP/CIDR list only work from those addresses. After 10 consecutive invalid key attempts an IP is locked for 5 minutes.

## 3. Channel numbering
All devices' channels form one global list: each device has a persistent `startIndex` (start) and `channelCount` (`GET /devices`). Global channel = `startIndex + index on device`. Display names look like `D1 (Kanal 1)` (`code` + name).

## 4. Endpoints

### General
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1` | auth | Version and links |
| GET | `/api/v1/health` | — (only from the container's own 127.0.0.1) | Liveness (`ok`); 404 from any other address. Used by the container HEALTHCHECK |
| GET | `/api/v1/me` | auth | Who you are: type, method, permissions, scope, expiry, rate limit |
| GET | `/api/v1/permissions` | permission.manage \| api.key \| member.manage | Permission catalogue (tr/en) |

### Cameras
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/cameras` | live.view \| recording.* \| device.read | Cameras in your scope: `channel`, `code`, `name`, `device`, `empty`, `camera` |
| GET | `/api/v1/cameras/{channel}/snapshot` | live.view | Snapshot (`image/jpeg`, main stream) |
| GET | `/api/v1/cameras/{channel}/live?type=Main\|Extra1\|Mini&raw=1` | live.view | Live MJPEG. `raw=1`: concatenated JPEG bytes; otherwise `multipart/x-mixed-replace`. `Mini` = 320 px / 5 fps |
| GET | `/api/v1/cameras/{channel}/recordings?day=YYYY-MM-DD&dayEnd=` | recording.list | Recording segments: `name`, `from`, `to`, `size` (estimate), `type` (R continuous, M motion, A alarm) |
| GET | `/api/v1/cameras/{channel}/playback?from=&to=&raw=1&g=960` | recording.play | Playback (MJPEG) |
| GET | `/api/v1/cameras/{channel}/download?file=&from=&to=` | recording.download | mp4 download, streamed straight from the device; `file` = `name` from the list |

Streaming endpoints are subject to the per-key concurrent stream limit (`429 STREAM_LIMIT`).

### Devices
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/devices` | device.read | Devices (`id`, `name`, `type`, `host`, `label`, `channelCount`, `startIndex`, `error`) + type catalogue |
| GET | `/api/v1/devices/info` | device.read | Merged info: channel names, empty channels, disks (temperature/status), clocks |
| POST | `/api/v1/devices` | device.manage | Add: `{type, host, username, password, name?, label?, channelCount?, httpPort?, rtspPort?, port?, template?, path?}`; connection is tested first |
| PATCH | `/api/v1/devices/{id}` | device.manage | Edit (omitted fields unchanged; empty `password` keeps the old one — but if `host` or a port changes, `password` must be supplied again or the request fails with 400) |
| DELETE | `/api/v1/devices/{id}` | device.manage | Remove from panel (device recordings untouched; last device cannot be removed) |
| POST | `/api/v1/devices/{id}/cameras` | device.manage | Register a camera on an NVR (Hikvision): `{name, ip, username, password, protocol: HIKVISION\|ONVIF, port?}` |
| POST | `/api/v1/devices/clock` | device.clock | `{device: "<id>"}` sync device clock to server |
| PUT | `/api/v1/channels` | channel.manage | Channel settings `{setting: {"<channel>": {name, view: auto\|show\|hide}}, from?, last?}` |

Types: `uniview` (NVR, 32 ch), `hikvision` (NVR, 16), `xiongmai` (DVR, 4, `port` 34567), `camera` (single IP camera; `template`: hikvision/dahua/uniview/custom + `path`).

### Members
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/members` | member.manage | `name, role, createdAt, scope, expiresAt, ips` |
| POST | `/api/v1/members` | member.manage | `{name, password (≥8), role, scope?, expiresAt?, ips?}` |
| PATCH | `/api/v1/members/{name}` | member.manage | `{password?, role?, scope?, expiresAt?, ips?}` (last admin protected; members with more authority than you cannot be changed; you cannot loosen your own `expiresAt`/`ips` restriction; a password change ends that member's sessions) |
| DELETE | `/api/v1/members/{name}` | member.manage | Delete |

### Roles
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/roles` | permission.manage \| api.key \| member.manage | Built-in + custom roles |
| POST | `/api/v1/roles` | permission.manage | `{id (a-z0-9_-), name: "..."\|{tr,en}, description?, permissions: [...]}` |
| PATCH | `/api/v1/roles/{id}` | permission.manage | Edit custom role; for DC roles (network, technical, accounting) only `{permissions}` |
| DELETE | `/api/v1/roles/{id}` | permission.manage | Delete if unused |

### API keys
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/keys?owner=` | permission.manage \| api.key | List (api.key: own keys only) |
| POST | `/api/v1/keys` | permission.manage \| api.key | `{name, role?, permissions?, scope?, expiresAt?, ips?, rateLimit?, concurrentStreams?, notes?, owner?}` → `{record, key}` (secret once) |
| GET | `/api/v1/keys/{id}` | … | Record (no secret): `prefix`, `permissionsEffective`, `active`, `lastUsed`, `counter` |
| PATCH | `/api/v1/keys/{id}` | … | Edit fields |
| POST | `/api/v1/keys/{id}/rotate` | … | Rotate secret |
| POST | `/api/v1/keys/{id}/revoke` | … | Permanent revoke |
| DELETE | `/api/v1/keys/{id}` | … | Delete record |


### Audit log
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/audit-log?page=&size=&event=&username=&ip=&day=` | audit.read | Entries, newest first: IP, port, UA, proxy headers, details |
| GET | `/api/v1/audit-log/verify` | audit.read | Verifies the HMAC chain |

Events: `login`, `login-failed`, `playback`, `download-request`, `download-complete`, `download-partial`, `member-add/edit/delete`, `role-add/edit/delete`, `key-create/edit/rotate/revoke/delete`, `device-add/edit/delete`, `nvr-camera-add`, `channel-settings`, `clock-sync`, `logout`, plus the centre sign-in events (`hub-login`, `hub-login-denied`, `hub-login-error`, ...). Actions performed with a key are logged as `key:<id>`.

## 5. Examples
```bash
curl -X POST http://SERVER/api/v1/keys -H "Authorization: Bearer kp_..." -H "Content-Type: application/json" \
  -d '{"name":"vms","role":"technical","scope":{"devices":["7d228e49"]},"rateLimit":300}'
curl http://SERVER/api/v1/cameras -H "Authorization: Bearer kp_..."
curl -o frame.jpg http://SERVER/api/v1/cameras/0/snapshot -H "Authorization: Bearer kp_..."
```

## 6. Security notes
- Over plain HTTP keys travel in clear: put TLS in front (Cloudflare/nginx). Behind a reverse proxy set `CAM_IP_HEADER=CF-Connecting-IP`, otherwise IP lists use the socket address.
- Grant the narrowest permissions and scope; give third parties their own scoped, expiring key.
- Passwords: scrypt; device passwords: AES-256-GCM; keys: HMAC digest; secrets never reach the audit log.
- Response headers: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS on HTTPS.
