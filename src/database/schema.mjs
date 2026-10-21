/**
 * Table definitions (for the Koleksiyon in src/core/tables.mjs): database column <-> field of the in-memory object.
 * A schema change goes into migrations.mjs as a new version; this file only holds the mapping.
 */
const s = (column, field, empty) => ({ s: column, a: field ?? column, t: 's', bos: empty });
const i = (column, field, empty) => ({ s: column, a: field, t: 'i', bos: empty });
const j = (column, field, empty) => ({ s: column, a: field, t: 'j', bos: empty });

export const UYELER = {
  tablo: 'users', anahtar: 'ad',
  sutunlar: [s('name', 'ad'), s('role', 'rol'), s('salt', 'tuz'), s('hash', 'karma'), s('created_at', 'olusturma'), i('session_version', 'oturumSurum', 0), j('scope', 'kapsam', null),
    s('expires_at', 'bitis', null), j('ips', 'ipler', []), j('preferences', 'tercih')],
};
export const CIHAZLAR = {
  tablo: 'devices', anahtar: 'id',
  sutunlar: [s('id'), s('name', 'ad', ''), s('type', 'tur'), s('host', 'ana'), s('username', 'kullanici'), j('password', 'parola'), s('label', 'etiket'), i('channel_count', 'kanalSayisi'),
    i('http_port', 'httpPort'), i('rtsp_port', 'rtspPort'), i('port', 'port'), s('template', 'sablon'), s('path', 'yol'), i('start_index', 'baslangic'), s('created_at', 'olusturma')],
};
export const ROLLER = {
  tablo: 'roles', anahtar: 'id',
  sutunlar: [s('id'), s('name', 'ad'), s('description', 'aciklama'), j('permissions', 'izinler', []), s('created_by', 'olusturan'), s('created_at', 'olusturma')],
};
export const YERLESIK_IZINLER = {
  tablo: 'builtin_role_permissions', anahtar: 'rol',
  sutunlar: [s('role', 'rol'), j('permissions', 'izinler', [])],
};
export const ANAHTARLAR = {
  tablo: 'api_keys', anahtar: 'id',
  sutunlar: [s('id'), s('name', 'ad'), s('prefix', 'onek'), s('hash', 'karma'), s('role', 'rol', null), j('permissions', 'izinler', []), j('scope', 'kapsam', null), s('expires_at', 'bitis', null),
    j('ips', 'ipler', []), i('rate_limit', 'hizLimiti'), i('concurrent_streams', 'eszamanliAkis'), s('owner', 'sahip', null), s('created_by', 'olusturan'), s('created_at', 'olusturma'),
    j('last_used', 'sonKullanim', null), i('counter', 'sayac', 0), j('revoked', 'iptal', null), s('notes', 'notlar', ''), i('version', 'surum')],
};
export const MERKEZ_BAGLARI = {
  tablo: 'hub_links', anahtar: 'sub',
  sutunlar: [s('sub'), s('username', 'ad'), s('user_stamp', 'uyeKimlik'), s('email', 'eposta'), s('role', 'rol', null), { s: 'can_login', a: 'girebilir', t: 'b' }, s('checked_at', 'kontrol', null),
    s('last_login', 'sonGiris', null), i('last_logout_ms', 'sonCikis')],
};
