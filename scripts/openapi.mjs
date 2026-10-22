/**
 * OpenAPI 3.1 belgesini rota tablosundan uretir (tek dogruluk kaynagi: routes/ + ara katman adlari).
 * Kullanim: node scripts/openapi.mjs  -> docs/openapi.json
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as base } from '../config/app.mjs';
import { createApp } from '../src/bootstrap.mjs';
import { tempDb } from '../test/helpers.mjs';
import { PERMISSIONS } from '../src/models/permission.mjs';

const DESCRIPTION = {
  'GET /api/v1': 'Sürüm ve bağlantılar', 'GET /api/v1/health': 'Canlılık denetimi (yalnız konteynerin kendi 127.0.0.1 adresinden; diğerlerine 404)', 'GET /api/v1/me': 'Kimlik: tür, yöntem, izinler, kapsam', 'GET /api/v1/permissions': 'İzin kataloğu',
  'GET /api/v1/cameras': 'Kapsamdaki kameralar', 'GET /api/v1/cameras/{channel}/snapshot': 'Anlık görüntü (image/jpeg)', 'GET /api/v1/cameras/{channel}/live': 'Canlı MJPEG akışı (type=Main|Extra1|Mini, raw=1)',
  'GET /api/v1/cameras/{channel}/recordings': 'Kayıt dilimleri (day, dayEnd)', 'GET /api/v1/cameras/{channel}/playback': 'Kayıttan oynatma MJPEG (from, to)', 'GET /api/v1/cameras/{channel}/download': 'Kayıt indirme mp4 (file, from, to)',
  'GET /api/v1/devices': 'Cihaz listesi ve tür kataloğu', 'GET /api/v1/devices/info': 'Birleşik cihaz bilgisi', 'POST /api/v1/devices': 'Cihaz ekle (bağlantı denenir)', 'PATCH /api/v1/devices/{id}': 'Cihaz düzenle', 'DELETE /api/v1/devices/{id}': 'Cihazı panelden kaldır',
  'POST /api/v1/devices/{id}/cameras': "NVR'a kamera kaydet", 'POST /api/v1/devices/clock': 'Cihaz saatini eşitle', 'PUT /api/v1/channels': 'Kanal adı/görünürlük ayarı',
  'GET /api/v1/members': 'Üyeler', 'POST /api/v1/members': 'Üye ekle', 'PATCH /api/v1/members/{name}': 'Üye düzenle', 'DELETE /api/v1/members/{name}': 'Üye sil',
  'GET /api/v1/audit-log': 'Denetim günlüğü', 'GET /api/v1/audit-log/verify': 'Günlük zincirini doğrula',
  'GET /api/v1/roles': 'Roller', 'POST /api/v1/roles': 'Özel rol ekle', 'PATCH /api/v1/roles/{id}': 'Rol düzenle', 'DELETE /api/v1/roles/{id}': 'Rol sil',
  'GET /api/v1/keys': 'API anahtarları', 'POST /api/v1/keys': 'Anahtar oluştur (gizli bir kez döner)', 'GET /api/v1/keys/{id}': 'Anahtar kaydı', 'PATCH /api/v1/keys/{id}': 'Anahtar düzenle',
  'POST /api/v1/keys/{id}/rotate': 'Gizliyi yenile', 'POST /api/v1/keys/{id}/revoke': 'Anahtarı iptal et', 'DELETE /api/v1/keys/{id}': 'Anahtar kaydını sil',
};
const BODY = {
  'POST /api/v1/devices': { type: 'string', host: 'string', username: 'string', password: 'string', name: 'string', label: 'string', channelCount: 'integer', httpPort: 'integer', rtspPort: 'integer', port: 'integer', template: 'string', path: 'string' },
  'PATCH /api/v1/devices/{id}': { host: 'string', username: 'string', password: 'string', name: 'string', label: 'string', channelCount: 'integer', httpPort: 'integer', rtspPort: 'integer', port: 'integer', template: 'string', path: 'string' },
  'POST /api/v1/devices/{id}/cameras': { name: 'string', ip: 'string', username: 'string', password: 'string', protocol: 'string', port: 'integer' },
  'POST /api/v1/devices/clock': { device: 'string' }, 'PUT /api/v1/channels': { setting: 'object', from: 'integer', last: 'integer' },
  'POST /api/v1/members': { name: 'string', password: 'string', role: 'string', scope: 'object', expiresAt: 'string', ips: 'array' }, 'PATCH /api/v1/members/{name}': { password: 'string', role: 'string', scope: 'object', expiresAt: 'string', ips: 'array' },
  'POST /api/v1/roles': { id: 'string', name: 'string', description: 'string', permissions: 'array' }, 'PATCH /api/v1/roles/{id}': { name: 'string', description: 'string', permissions: 'array' },
  'POST /api/v1/keys': { name: 'string', role: 'string', permissions: 'array', scope: 'object', expiresAt: 'string', ips: 'array', rateLimit: 'integer', concurrentStreams: 'integer', notes: 'string', owner: 'string' },
  'PATCH /api/v1/keys/{id}': { name: 'string', role: 'string', permissions: 'array', scope: 'object', expiresAt: 'string', ips: 'array', rateLimit: 'integer', concurrentStreams: 'integer', notes: 'string' },
};
const QUERY = {
  'GET /api/v1/cameras/{channel}/live': ['type', 'raw', 'g'], 'GET /api/v1/cameras/{channel}/recordings': ['day', 'dayEnd'], 'GET /api/v1/cameras/{channel}/playback': ['from', 'to', 'g'],
  'GET /api/v1/cameras/{channel}/download': ['file', 'from', 'to'], 'GET /api/v1/audit-log': ['page', 'size', 'event', 'username', 'ip', 'day'], 'GET /api/v1/keys': ['owner'],
};

const data = mkdtempSync(join(tmpdir(), 'cam-oa-'));
// Rota tablosu icin gecici bir veritabani acilir (DB_HOST, DB_USERNAME, DB_PASSWORD: veritabani olusturabilen kullanici) ve silinir.
const gv = await tempDb();
const y = { ...base, dataDir: data, database: gv.setting, device: { ...base.device, test: true, seed: '[{"name":"X","type":"mock","host":"127.0.0.1","username":"a","password":"b"}]' }, permissions: { ...base.permissions, initialAdminPassword: 'x'.repeat(10) } };
const app = await createApp(y);
const paths = {};
for (const r of app.router.list().filter((x) => x.pattern.startsWith('/api/v1'))) {
  const path = r.pattern.replace(/:(\w+)/g, '{$1}');
  for (const method of r.methods.filter((m) => m !== 'HEAD')) {
    const key = `${method} ${path}`;
    const permissionMiddleware = r.middlewares.find((a) => a.startsWith('permission:'));
    const permissions = permissionMiddleware ? permissionMiddleware.slice(5).split(/[+|]/) : [];
    const op = {
      summary: DESCRIPTION[key] ?? key,
      tags: [path.split('/')[3] ?? 'general'],
      security: r.middlewares.includes('identity') ? [{ apiKey: [] }, { session: [] }] : [],
      'x-permissions': permissions,
      parameters: [
        ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: m[1] === 'channel' ? 'integer' : 'string' } })),
        ...(QUERY[key] ?? []).map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })),
      ],
      responses: { 200: { description: 'Başarılı' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' } },
    };
    if (BODY[key]) op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(BODY[key]).map(([k, t]) => [k, { type: t }])) } } } };
    (paths[path] ??= {})[method.toLowerCase()] = op;
  }
}
const document = {
  openapi: '3.1.0',
  info: { title: 'Kamera Paneli API', version: '1.0.0', description: 'Ayrıntılı rehber: /docs/api-v1.tr.md (TR), /docs/api-v1.en.md (EN). Her uç noktanın gerekli izni x-permissions alanında.' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'kp_<id>_<gizli>' }, session: { type: 'apiKey', in: 'cookie', name: 'cam_session' } },
    responses: { Error: { description: 'Hata', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, requiredPermission: { type: 'string' }, retryAfterSec: { type: 'integer' } } } } } } },
  },
  'x-permissions': Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.tr])),
  paths,
};
writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(document, null, 2));
await app.close(); await gv.remove(); rmSync(data, { recursive: true, force: true });
console.log(`openapi.json: ${Object.keys(paths).length} yol`);
