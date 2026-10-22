/**
 * Turkish-era names -> current English names, in ONE place.
 *
 * Used by: migration v2 (values stored in the database) and the
 * audit log views (history rows keep their original text: the chain is signed over it, so they are never rewritten).
 *
 * The quoted Turkish strings below are DATA (names that were stored before the rename), not code names: they must stay as written.
 * Every converter is idempotent: a value that already has the current name passes through unchanged.
 */

const own = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : null);
const mapKeys = (o, map) => (own(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] ?? k, v])) : o);
const mapValue = (v, map) => (typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : v);

// ---------------------------------------------------------------- permissions and roles
export const PERMISSION_IDS = {
  'canli.izle': 'live.view', 'kayit.listele': 'recording.list', 'kayit.izle': 'recording.play', 'kayit.indir': 'recording.download',
  'cihaz.oku': 'device.read', 'cihaz.saat': 'device.clock', 'cihaz.yonet': 'device.manage', 'kanal.yonet': 'channel.manage',
  'uye.yonet': 'member.manage', 'gunluk.oku': 'audit.read', 'yetki.yonet': 'permission.manage', 'api.anahtar': 'api.key', 'guncelleme.denetle': 'update.check',
};
/** Wildcard prefixes ("kayit.*" -> "recording.*"). */
export const PERMISSION_PREFIXES = {
  canli: 'live', kayit: 'recording', cihaz: 'device', kanal: 'channel', uye: 'member', gunluk: 'audit', yetki: 'permission', guncelleme: 'update',
};
export const permissionId = (id) => {
  if (typeof id !== 'string') return id;
  if (Object.hasOwn(PERMISSION_IDS, id)) return PERMISSION_IDS[id];
  const m = /^([a-z]+)\.\*$/.exec(id);
  return m && Object.hasOwn(PERMISSION_PREFIXES, m[1]) ? `${PERMISSION_PREFIXES[m[1]]}.*` : id;
};
export const permissionList = (list) => (Array.isArray(list) ? [...new Set(list.map(permissionId))] : list);

/** Built-in role ids (admin and network kept their names). Custom role ids are data and never change. */
export const ROLE_IDS = { teknik: 'technical', muhasebe: 'accounting', kamera: 'camera' };
export const roleId = (r) => mapValue(r, ROLE_IDS);

// ---------------------------------------------------------------- members, keys, devices
export const scope = (o) => mapKeys(o, { cihazlar: 'devices', kanallar: 'channels' });

const PREFERENCE_KEYS = { hepsiSayi: 'allCount', hepsiSira: 'allOrder', arkaPlandaDurdur: 'pauseInBackground', izgaraAkis: 'gridStream' };
export const preferences = (o) => {
  const p = mapKeys(o, PREFERENCE_KEYS);
  return own(p) && p.gridStream !== undefined ? { ...p, gridStream: mapValue(p.gridStream, { alt: 'sub', ana: 'main' }) } : p;
};

export const keyLastUsed = (o) => mapKeys(o, { z: 'at' });
export const keyRevoked = (o) => mapKeys(o, { z: 'at', kim: 'by' });

export const deviceType = (t) => mapValue(t, { kamera: 'camera', sahte: 'mock' });
export const deviceTemplate = (t) => mapValue(t, { ozel: 'custom' });
/** Encrypted device password envelope: AES-GCM parts (the ciphertext itself is never touched). */
export const envelope = (o) => mapKeys(o, { etiket: 'tag', veri: 'data' });

// ---------------------------------------------------------------- settings documents
const VISIBILITY = { otomatik: 'auto', goster: 'show', gizle: 'hide' };
/** settings/channels: { "<channel>": { ad, gorunum } } */
export const channelsDoc = (o) => (own(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => {
  const c = mapKeys(v, { ad: 'name', gorunum: 'view' });
  return [k, own(c) && c.view !== undefined ? { ...c, view: mapValue(c.view, VISIBILITY) } : c];
})) : o);
/** settings/live-layout */
export const layoutDoc = (o) => mapKeys(o, { sutun: 'column', yollar: 'paths', kaydeden: 'savedBy', zaman: 'time' });
/** settings/update-status */
export const updateStatusDoc = (o) => {
  const d = mapKeys(o, {
    calisan: 'running', depo: 'repo', tetikleyen: 'trigger', durum: 'status', aciklama: 'description', zaman: 'time', geride: 'behind', ileride: 'ahead',
    commitler: 'commitList', son: 'last', son_tarih: 'lastDate',
  });
  if (!own(d)) return d;
  const out = { ...d };
  if (out.status !== undefined) out.status = mapValue(out.status, { guncel: 'current', yeni: 'new', ileride: 'ahead', ayrisik: 'diverged', bilinmiyor: 'unknown', hata: 'error' });
  if (Array.isArray(out.commitList)) out.commitList = out.commitList.map((c) => mapKeys(c, { baslik: 'header', tarih: 'date' }));
  return out;
};

// ---------------------------------------------------------------- audit log (rows are NEVER rewritten; these only read/display them)
/** Header fields of the signed record: legacy name -> current name. The remaining fields (ip, port, tls, ua, detail) are read as they are. */
export const AUDIT_FIELDS = {
  z: 'time', yerel: 'localTime', olay: 'event', kullanici: 'username', yerelIp: 'localIp', yerelPort: 'localPort', istek: 'request', ileri: 'forwarded',
  onceki: 'previous', imza: 'signature',
};
/** Event names: legacy -> current. History keeps the legacy text; new events are written with the current name. */
export const AUDIT_EVENTS = {
  giris: 'login', cikis: 'logout', oynatma: 'playback', 'giris-hata': 'login-failed',
  'giris-merkez': 'hub-login', 'giris-merkez-red': 'hub-login-denied', 'giris-merkez-hata': 'hub-login-error',
  'merkez-hesap-acildi': 'hub-account-created', 'merkez-rol': 'hub-role-changed', 'merkez-rol-hata': 'hub-role-error',
  'merkez-erisim-kapandi': 'hub-access-revoked', 'merkez-erisim-acildi': 'hub-access-granted',
  'cihaz-ekle': 'device-add', 'cihaz-duzenle': 'device-edit', 'cihaz-sil': 'device-delete', 'nvr-kamera-ekle': 'nvr-camera-add',
  'saat-ayari': 'clock-sync', 'kanal-ayari': 'channel-settings',
  'indirme-istek': 'download-request', 'indirme-teslim': 'download-complete', 'indirme-yarim': 'download-partial',
  'uye-ekle': 'member-add', 'uye-duzenle': 'member-edit', 'uye-sil': 'member-delete',
  'rol-ekle': 'role-add', 'rol-duzenle': 'role-edit', 'rol-sil': 'role-delete',
  'anahtar-olustur': 'key-create', 'anahtar-duzenle': 'key-edit', 'anahtar-yenile': 'key-rotate', 'anahtar-iptal': 'key-revoke', 'anahtar-sil': 'key-delete',
};
export const auditEvent = (name) => mapValue(name, AUDIT_EVENTS);
/** Names that mean the same event (current first, then legacy): filtering by one finds the history under the other. */
export const auditEventNames = (name) => {
  const current = auditEvent(name);
  return [current, ...Object.entries(AUDIT_EVENTS).filter(([, v]) => v === current).map(([k]) => k)];
};
/** Legacy records are recognised by their signature field. */
export const isLegacyAuditRecord = (k) => own(k) && Object.hasOwn(k, 'imza') && !Object.hasOwn(k, 'signature');
/** Same record with the current header field names and event name (for display; the stored text is untouched). */
export const auditRecordView = (k) => {
  if (!isLegacyAuditRecord(k)) return k;
  const v = mapKeys(k, AUDIT_FIELDS);
  return { ...v, event: auditEvent(v.event) };
};
/**
 * Chain step: checks one parsed record against the previous signature. Works on the record AS STORED (legacy or current names, original
 * key order): the signature covers `previous + JSON.stringify(record without its signature)`. Returns the record's signature or null.
 */
export function auditChainStep(k, previous, sign) {
  if (!own(k)) return null;
  const legacy = isLegacyAuditRecord(k);
  const sigKey = legacy ? 'imza' : 'signature', prevKey = legacy ? 'onceki' : 'previous';
  const { [sigKey]: signature, ...rest } = k;
  if (k[prevKey] !== previous || sign(previous + JSON.stringify(rest)) !== signature) return null;
  return signature;
}
