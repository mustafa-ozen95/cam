/**
 * OpenAPI 3.1 belgesini rota tablosundan uretir (tek dogruluk kaynagi: routes/ + ara katman adlari).
 * Kullanim: node scripts/openapi.mjs  -> docs/openapi.json
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { yapilandirma as temel } from '../config/app.mjs';
import { uygulamaKur } from '../src/bootstrap.mjs';
import { gecicivt } from '../test/helpers.mjs';
import { IZINLER } from '../src/models/permission.mjs';

const ACIKLAMA = {
  'GET /api/v1': 'Sürüm ve bağlantılar', 'GET /api/v1/saglik': 'Canlılık denetimi (yalnız konteynerin kendi 127.0.0.1 adresinden; diğerlerine 404)', 'GET /api/v1/ben': 'Kimlik: tür, yöntem, izinler, kapsam', 'GET /api/v1/izinler': 'İzin kataloğu',
  'GET /api/v1/kameralar': 'Kapsamdaki kameralar', 'GET /api/v1/kameralar/{kanal}/goruntu': 'Anlık görüntü (image/jpeg)', 'GET /api/v1/kameralar/{kanal}/canli': 'Canlı MJPEG akışı (tur=Main|Extra1|Mini, ham=1)',
  'GET /api/v1/kameralar/{kanal}/kayitlar': 'Kayıt dilimleri (gun, gun2)', 'GET /api/v1/kameralar/{kanal}/oynat': 'Kayıttan oynatma MJPEG (bas, bit)', 'GET /api/v1/kameralar/{kanal}/indir': 'Kayıt indirme mp4 (dosya, bas, bit)',
  'GET /api/v1/cihazlar': 'Cihaz listesi ve tür kataloğu', 'GET /api/v1/cihazlar/bilgi': 'Birleşik cihaz bilgisi', 'POST /api/v1/cihazlar': 'Cihaz ekle (bağlantı denenir)', 'PATCH /api/v1/cihazlar/{id}': 'Cihaz düzenle', 'DELETE /api/v1/cihazlar/{id}': 'Cihazı panelden kaldır',
  'POST /api/v1/cihazlar/{id}/kameralar': "NVR'a kamera kaydet", 'POST /api/v1/cihazlar/saat': 'Cihaz saatini eşitle', 'PUT /api/v1/kanallar': 'Kanal adı/görünürlük ayarı',
  'GET /api/v1/uyeler': 'Üyeler', 'POST /api/v1/uyeler': 'Üye ekle', 'PATCH /api/v1/uyeler/{ad}': 'Üye düzenle', 'DELETE /api/v1/uyeler/{ad}': 'Üye sil',
  'GET /api/v1/gunluk': 'Denetim günlüğü', 'GET /api/v1/gunluk/dogrula': 'Günlük zincirini doğrula',
  'GET /api/v1/roller': 'Roller', 'POST /api/v1/roller': 'Özel rol ekle', 'PATCH /api/v1/roller/{id}': 'Rol düzenle', 'DELETE /api/v1/roller/{id}': 'Rol sil',
  'GET /api/v1/anahtarlar': 'API anahtarları', 'POST /api/v1/anahtarlar': 'Anahtar oluştur (gizli bir kez döner)', 'GET /api/v1/anahtarlar/{id}': 'Anahtar kaydı', 'PATCH /api/v1/anahtarlar/{id}': 'Anahtar düzenle',
  'POST /api/v1/anahtarlar/{id}/yenile': 'Gizliyi yenile', 'POST /api/v1/anahtarlar/{id}/iptal': 'Anahtarı iptal et', 'DELETE /api/v1/anahtarlar/{id}': 'Anahtar kaydını sil', 'POST /api/v1/jetonlar': 'Daraltılmış jeton üret',
};
const GOVDE = {
  'POST /api/v1/cihazlar': { tur: 'string', ana: 'string', kullanici: 'string', parola: 'string', ad: 'string', etiket: 'string', kanalSayisi: 'integer', httpPort: 'integer', rtspPort: 'integer', port: 'integer', sablon: 'string', yol: 'string' },
  'PATCH /api/v1/cihazlar/{id}': { ana: 'string', kullanici: 'string', parola: 'string', ad: 'string', etiket: 'string', kanalSayisi: 'integer', httpPort: 'integer', rtspPort: 'integer', port: 'integer', sablon: 'string', yol: 'string' },
  'POST /api/v1/cihazlar/{id}/kameralar': { ad: 'string', ip: 'string', kullanici: 'string', parola: 'string', protokol: 'string', port: 'integer' },
  'POST /api/v1/cihazlar/saat': { cihaz: 'string' }, 'PUT /api/v1/kanallar': { ayar: 'object', bas: 'integer', son: 'integer' },
  'POST /api/v1/uyeler': { ad: 'string', parola: 'string', rol: 'string', kapsam: 'object', bitis: 'string', ipler: 'array' }, 'PATCH /api/v1/uyeler/{ad}': { parola: 'string', rol: 'string', kapsam: 'object', bitis: 'string', ipler: 'array' },
  'POST /api/v1/roller': { id: 'string', ad: 'string', aciklama: 'string', izinler: 'array' }, 'PATCH /api/v1/roller/{id}': { ad: 'string', aciklama: 'string', izinler: 'array' },
  'POST /api/v1/anahtarlar': { ad: 'string', rol: 'string', izinler: 'array', kapsam: 'object', bitis: 'string', ipler: 'array', hizLimiti: 'integer', eszamanliAkis: 'integer', notlar: 'string', sahip: 'string' },
  'PATCH /api/v1/anahtarlar/{id}': { ad: 'string', rol: 'string', izinler: 'array', kapsam: 'object', bitis: 'string', ipler: 'array', hizLimiti: 'integer', eszamanliAkis: 'integer', notlar: 'string' },
};
const SORGU = {
  'GET /api/v1/kameralar/{kanal}/canli': ['tur', 'ham', 'g'], 'GET /api/v1/kameralar/{kanal}/kayitlar': ['gun', 'gun2'], 'GET /api/v1/kameralar/{kanal}/oynat': ['bas', 'bit', 'ham', 'g'],
  'GET /api/v1/kameralar/{kanal}/indir': ['dosya', 'bas', 'bit'], 'GET /api/v1/gunluk': ['sayfa', 'boyut', 'olay', 'kullanici', 'ip', 'gun'], 'GET /api/v1/anahtarlar': ['sahip'],
};

const veri = mkdtempSync(join(tmpdir(), 'cam-oa-'));
// Rota tablosu icin gecici bir veritabani acilir (DB_HOST, DB_USERNAME, DB_PASSWORD: veritabani olusturabilen kullanici) ve silinir.
const gv = await gecicivt();
const y = { ...temel, veriKlasoru: veri, veritabani: gv.ayar, cihaz: { ...temel.cihaz, test: true, tohum: '[{"ad":"X","tur":"sahte","ana":"127.0.0.1","kullanici":"a","parola":"b"}]' }, yetki: { ...temel.yetki, ilkAdminParola: 'x'.repeat(10) } };
const app = await uygulamaKur(y);
const paths = {};
for (const r of app.yonlendirici.liste().filter((x) => x.kalip.startsWith('/api/v1'))) {
  const yol = r.kalip.replace(/:(\w+)/g, '{$1}');
  for (const yontem of r.yontemler.filter((m) => m !== 'HEAD')) {
    const anahtar = `${yontem} ${yol}`;
    const izinAra = r.aralar.find((a) => a.startsWith('izin:'));
    const izinler = izinAra ? izinAra.slice(5).split(/[+|]/) : [];
    const op = {
      summary: ACIKLAMA[anahtar] ?? anahtar,
      tags: [yol.split('/')[3] ?? 'genel'],
      security: r.aralar.includes('kimlik') ? [{ apiAnahtari: [] }, { oturum: [] }] : [],
      'x-izinler': izinler,
      parameters: [
        ...[...yol.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: m[1] === 'kanal' ? 'integer' : 'string' } })),
        ...(SORGU[anahtar] ?? []).map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })),
      ],
      responses: { 200: { description: 'Başarılı' }, 401: { $ref: '#/components/responses/Hata' }, 403: { $ref: '#/components/responses/Hata' }, 429: { $ref: '#/components/responses/Hata' } },
    };
    if (GOVDE[anahtar]) op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(GOVDE[anahtar]).map(([k, t]) => [k, { type: t }])) } } } };
    (paths[yol] ??= {})[yontem.toLowerCase()] = op;
  }
}
const belge = {
  openapi: '3.1.0',
  info: { title: 'Kamera Paneli API', version: '1.0.0', description: 'Ayrıntılı rehber: /dokuman/api-v1.tr.md (TR), /dokuman/api-v1.en.md (EN). Her uç noktanın gerekli izni x-izinler alanında.' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { apiAnahtari: { type: 'http', scheme: 'bearer', bearerFormat: 'kp_<id>_<gizli>' }, oturum: { type: 'apiKey', in: 'cookie', name: 'kamera_oturum' } },
    responses: { Hata: { description: 'Hata', content: { 'application/json': { schema: { type: 'object', properties: { hata: { type: 'string' }, kod: { type: 'string' }, gerekenIzin: { type: 'string' }, yenidenDenemeSn: { type: 'integer' } } } } } } },
  },
  'x-izinler': Object.fromEntries(Object.entries(IZINLER).map(([k, v]) => [k, v.tr])),
  paths,
};
writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(belge, null, 2));
await app.kapat(); await gv.sil(); rmSync(veri, { recursive: true, force: true });
console.log(`openapi.json: ${Object.keys(paths).length} yol`);
