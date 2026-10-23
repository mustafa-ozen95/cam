/**
 * Yetkilendirme cekirdegi (saf mantik; HTTP'den bagimsiz, birim testli).
 *
 *  - IZINLER: ince taneli izin katalogu ("grup.eylem"); "*" her sey, "grup.*" bir grubun tumu.
 *  - ROLLER: yerlesik (degismez) + ozel roller (roller, yerlesik_izinler tablolari).
 *  - KAPSAM: kamera erisim listesi { cihazlar:[id], kanallar:[n] }; null = kisitsiz.
 *  - API ANAHTARLARI: kp_<id>_<gizli>; yalniz HMAC ozeti saklanir, gizli bir kez gosterilir; sona erme, IP/CIDR listesi, hiz siniri, eszamanli akis siniri.
 *  - HIZ SINIRI ve kimlik dogrulama hata kisiti (IP basina kaba kuvvet korumasi).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { apiKeyHashKey } from '../core/crypto-labels.mjs';
import { Lock, Collection, saveTogether, writeOrRollback } from '../core/tables.mjs';
import { API_KEYS, ROLES, BUILTIN_PERMISSIONS } from '../database/schema.mjs';

export class PermissionError extends Error {
  /** kod: makine okunur (PERMISSION_DENIED...), durum: HTTP kodu, ekstra: yanita eklenecek alanlar */
  constructor(code, message, status = 403, extra = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

// ---------------------------------------------------------------- izinler ve roller
export const PERMISSIONS = {
  'live.view': { group: 'viewing', tr: 'Canlı görüntü ve anlık görüntü (kare)', en: 'Live view and snapshots' },
  'recording.list': { group: 'viewing', tr: 'Kayıt listesini görme', en: 'List recordings' },
  'recording.play': { group: 'viewing', tr: 'Kayıttan oynatma', en: 'Play back recordings' },
  'recording.download': { group: 'viewing', tr: 'Kayıt indirme', en: 'Download recordings' },
  'device.read': { group: 'device', tr: 'Cihaz, disk ve saat bilgisini görme', en: 'View device, disk and clock information' },
  'device.clock': { group: 'device', tr: 'Cihaz saatini sunucu saatine eşitleme', en: 'Synchronise device clocks to the server clock' },
  'device.manage': { group: 'device', tr: 'Cihaz ekleme/düzenleme/silme ve NVR\'a kamera ekleme', en: 'Add, edit and remove devices; add cameras to NVRs' },
  'channel.manage': { group: 'device', tr: 'Kanal adı ve görünürlük ayarı', en: 'Edit channel names and visibility' },
  'member.manage': { group: 'management', tr: 'Üyeleri yönetme', en: 'Manage members' },
  'audit.read': { group: 'management', tr: 'Denetim günlüğünü okuma ve doğrulama', en: 'Read and verify the audit log' },
  'permission.manage': { group: 'management', tr: 'Rolleri ve tüm API anahtarlarını yönetme', en: 'Manage roles and all API keys' },
  'api.key': { group: 'management', tr: 'Yalnız kendi API anahtarlarını yönetme', en: 'Manage own API keys only' },
  'update.check': { group: 'management', tr: 'Güncelleme durumunu görme ve kontrol etme', en: 'View and check for updates' },
  'update.apply': { group: 'management', tr: 'Yeni sürümü kurdurma (platformun deploy hook\'u)', en: 'Start an update (platform deploy hook)' },
};
export const PERMISSION_GROUPS = {
  viewing: { tr: 'İzleme', en: 'Viewing' },
  device: { tr: 'Cihaz', en: 'Devices' },
  management: { tr: 'Yönetim', en: 'Administration' },
};

/**
 * YERLESIK ROLLER = DC PANELLERININ ROLLERI.
 * Kimlikler KYM/EYS ile ayni (admin, network, teknik, muhasebe, kamera): merkezdeki rol buraya birebir eslenir.
 *
 * admin her seyi yapar ve degismez. Digerlerinin izinleri BOS dogar
 * ve panelden verilir (Yetki → Roller → Düzenle): ad/kimlik sabit, yalniz izin listesi degisir ve yetki.json'da
 * saklanir (veri.builtinPermissions). Bos izinli role sahip uye giris yapar ama hicbir bolum gormez.
 */
export const BUILTIN_ROLES = {
  admin: { name: { tr: 'Yönetici', en: 'Administrator' }, description: { tr: 'Her şeyi yapar.', en: 'Can do everything.' }, permissions: ['*'], builtin: true },
  network: { name: { tr: 'Network', en: 'Network' }, description: { tr: 'Ağ ekibi. İzinleri buradan verilir.', en: 'Network team. Permissions are granted here.' }, permissions: [], builtin: true, permissionEditable: true },
  technical: { name: { tr: 'Teknik', en: 'Technical' }, description: { tr: 'Teknik ekip. İzinleri buradan verilir.', en: 'Technical team. Permissions are granted here.' }, permissions: [], builtin: true, permissionEditable: true },
  accounting: { name: { tr: 'Muhasebe', en: 'Accounting' }, description: { tr: 'Muhasebe. İzinleri buradan verilir.', en: 'Accounting. Permissions are granted here.' }, permissions: [], builtin: true, permissionEditable: true },
  // Kamera rolu: merkezde yalniz bu panele girer; burada izleme izinleriyle dogar, panelden daraltilabilir.
  camera: { name: { tr: 'Kamera', en: 'Camera' }, description: { tr: 'Kamera ekibi: canlı izleme ve kayıtlar. İzinleri buradan verilir.', en: 'Camera team: live view and recordings. Permissions are granted here.' }, permissions: ['live.view', 'recording.list', 'recording.play', 'recording.download'], builtin: true, permissionEditable: true },
};

const PERMISSION_NAMES = Object.keys(PERMISSIONS);
const GROUP_NAMES = new Set(Object.values(PERMISSIONS).map((i) => i.group));
const GROUP_PERMISSION = (g) => PERMISSION_NAMES.filter((i) => PERMISSIONS[i].group === g);

/** Gecerli izin metni mi? ("*", "grup.*" ya da katalogdaki bir izin) */
export function permissionValid(permission) {
  if (permission === '*') return true;
  if (typeof permission !== 'string') return false;
  if (PERMISSIONS[permission]) return true;
  const m = /^([a-z]+)\.\*$/.exec(permission);
  return !!m && PERMISSION_NAMES.some((i) => i.startsWith(`${m[1]}.`));
}
export function permissionSet(list) { return list instanceof Set ? list : new Set(list ?? []); }
/** izinler (dizi/Set; "*" ve "grup.*" icerebilir) gereken izni veriyor mu? */
export function hasPermission(permissions, required) {
  const k = permissionSet(permissions);
  if (k.has('*') || k.has(required)) return true;
  const i = required.indexOf('.');
  return i > 0 && k.has(`${required.slice(0, i)}.*`);
}
/** "*" ve "grup.*" kalibini somut izinlere acar (gosterim ve alt-kume denetimi icin). */
export function expandPermission(list) {
  const output = new Set();
  for (const i of list ?? []) {
    if (i === '*') PERMISSION_NAMES.forEach((x) => output.add(x));
    else if (i.endsWith('.*')) PERMISSION_NAMES.filter((x) => x.startsWith(i.slice(0, -1))).forEach((x) => output.add(x));
    else if (PERMISSIONS[i]) output.add(i);
  }
  return [...output];
}
/** cocuk izinleri ebeveynin izinlerinin alt kumesi mi? (yetki yukseltmeyi onler) */
export function isPermissionSubset(child, parent) {
  const e = permissionSet(parent);
  return expandPermission(child).every((i) => hasPermission(e, i));
}
export function permissionIntersection(a, b) {
  const kb = permissionSet(b);
  return expandPermission(a).filter((i) => hasPermission(kb, i));
}

// ---------------------------------------------------------------- IP / CIDR
function ipv4Count(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const cleanIp = (ip) => String(ip ?? '').replace(/^::ffff:/i, '').toLowerCase();
/** IPv4, IPv4/CIDR ya da tam IPv6 adresi mi? */
export function ipRuleValid(rule) {
  if (typeof rule !== 'string') return false;
  if (rule.includes('/')) { const [network, to] = rule.split('/'); const b = Number(to); return ipv4Count(network) !== null && /^\d{1,2}$/.test(to) && b >= 0 && b <= 32; }
  return ipv4Count(rule) !== null || /^[0-9a-f:]{2,39}$/i.test(rule) && rule.includes(':');
}
/** ip, kurallardan (bos liste = kisitsiz) birine uyuyor mu? */
export function ipMatches(ip, rules) {
  if (!rules?.length) return true;
  const a = cleanIp(ip), n = ipv4Count(a);
  for (const k of rules) {
    if (k.includes('/')) {
      const [network, to] = k.split('/'), g = ipv4Count(network), b = Number(to);
      if (n === null || g === null) continue;
      const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
      if (((n & mask) >>> 0) === ((g & mask) >>> 0)) return true;
    } else if (cleanIp(k) === a) return true;
  }
  return false;
}

// ---------------------------------------------------------------- kapsam (kamera erisim listesi)
/** Kapsami dogrular/normallestirir. null/undefined = kisitsiz; { cihazlar:[], kanallar:[] } = hicbir kanal. */
export function normalizeScope(k) {
  if (k === null || k === undefined) return null;
  if (typeof k !== 'object' || Array.isArray(k)) throw new PermissionError('INVALID_REQUEST', 'Kapsam bir nesne olmalı ({devices, channels})', 400);
  const devices = [...new Set((k.devices ?? []).map(String))];
  if (devices.some((c) => !/^[A-Za-z0-9_-]{2,64}$/.test(c))) throw new PermissionError('INVALID_REQUEST', 'Kapsamdaki cihaz kimliği geçersiz', 400);
  const channels = [...new Set((k.channels ?? []).map(Number))];
  if (channels.some((n) => !Number.isInteger(n) || n < 0 || n > 1023)) throw new PermissionError('INVALID_REQUEST', 'Kapsamdaki kanal numarası geçersiz', 400);
  return { devices, channels: channels.sort((a, b) => a - b) };
}
/** kanal, kapsama giriyor mu? deviceIdOf(kanal) -> cihaz kimligi. */
export function scopeChannelAllowed(scope, channel, deviceIdOf) {
  if (!scope) return true;
  if (scope.channels?.includes(channel)) return true;
  if (scope.devices?.length) { const id = deviceIdOf?.(channel); if (id && scope.devices.includes(id)) return true; }
  return false;
}
export function scopeSet(scope, channelTotal, deviceIdOf) {
  const s = new Set();
  for (let k = 0; k < channelTotal; k++) if (scopeChannelAllowed(scope, k, deviceIdOf)) s.add(k);
  return s;
}
/** cocuk kapsam ebeveyn kapsamin icinde mi? (kisitli bir sahip, kapsamindan genis anahtar uretemez) */
export function scopeWithin(child, parent, channelTotal, deviceIdOf) {
  if (!parent) return true;
  const e = scopeSet(parent, channelTotal, deviceIdOf);
  // Acik kanal numarasi mevcut bir kanala denk gelmeli: "henuz olmayan" kanal numarasi onceden verilemez (sonradan eklenen cihaz o kapsama girerdi).
  if (child?.channels?.some((k) => !e.has(k))) return false;
  for (const k of scopeSet(child, channelTotal, deviceIdOf)) if (!e.has(k)) return false;
  return true;
}
/** iki kapsamin kesisimi. Sonuc acik kanal listesidir. */
export function scopeIntersection(a, b, channelTotal, deviceIdOf) {
  if (!a && !b) return null;
  if (!a) return { devices: [], channels: [...scopeSet(b, channelTotal, deviceIdOf)] };
  if (!b) return { devices: [], channels: [...scopeSet(a, channelTotal, deviceIdOf)] };
  const sb = scopeSet(b, channelTotal, deviceIdOf);
  return { devices: [], channels: [...scopeSet(a, channelTotal, deviceIdOf)].filter((k) => sb.has(k)) };
}

// ---------------------------------------------------------------- hiz siniri / hata kisiti
/** Kayan pencere hiz siniri (anahtar basina istek/dakika). */
export class RateLimit {
  constructor() { this.record = new Map(); }
  /** { tamam, kalan, resetSec } */
  attempt(key, limit, windowMs = 60_000, now = Date.now()) {
    let d = this.record.get(key);
    if (!d) { d = []; this.record.set(key, d); }
    while (d.length && d[0] <= now - windowMs) d.shift();
    if (d.length >= limit) return { ok: false, remaining: 0, resetSec: Math.max(1, Math.ceil((d[0] + windowMs - now) / 1000)) };
    d.push(now);
    return { ok: true, remaining: limit - d.length, resetSec: Math.ceil(windowMs / 1000) };
  }
  clear(now = Date.now(), windowMs = 60_000) { for (const [k, d] of this.record) { while (d.length && d[0] <= now - windowMs) d.shift(); if (!d.length) this.record.delete(k); } }
}
/** Kimlik dogrulama hatalari icin IP basina kilit: pencerede en cok `maxErrors` hata, sonra kilit. */
export class ErrorLimit {
  constructor({ maxErrors = 10, windowMs = 600_000, lockMs = 300_000 } = {}) { Object.assign(this, { maxErrors, windowMs, lockMs }); this.ips = new Map(); }
  isLocked(ip, now = Date.now()) { const d = this.ips.get(ip); return d?.lock > now ? Math.ceil((d.lock - now) / 1000) : 0; }
  error(ip, now = Date.now()) {
    let d = this.ips.get(ip);
    if (!d || now - d.first > this.windowMs) { d = { n: 0, first: now, lock: 0 }; this.ips.set(ip, d); }
    d.n++; if (d.n >= this.maxErrors) d.lock = now + this.lockMs;
  }
  success(ip) { this.ips.delete(ip); }
}

// ---------------------------------------------------------------- yardimcilar
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const ISO_DATE = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/;
/** bitis metnini ISO'ya cevirir (yalniz tarih verilirse o gunun sonu, UTC). null = suresiz. */
export function normalizeExpiresAt(b) {
  if (b === null || b === undefined || b === '') return null;
  if (typeof b !== 'string' || !ISO_DATE.test(b)) throw new PermissionError('INVALID_REQUEST', 'Bitiş tarihi geçersiz (YYYY-AA-GG ya da ISO)', 400);
  const t = Date.parse(b.length === 10 ? `${b}T23:59:59Z` : b);
  if (Number.isNaN(t)) throw new PermissionError('INVALID_REQUEST', 'Bitiş tarihi geçersiz', 400);
  return new Date(t).toISOString();
}
export function normalizeIps(l) {
  if (l === null || l === undefined) return [];
  if (!Array.isArray(l) || l.length > 20) throw new PermissionError('INVALID_REQUEST', 'IP listesi en çok 20 öğe olabilir', 400);
  const t = l.map((x) => String(x).trim()).filter(Boolean);
  const bad = t.find((x) => !ipRuleValid(x));
  if (bad) throw new PermissionError('INVALID_REQUEST', `IP/CIDR geçersiz: ${bad}`, 400);
  return [...new Set(t)];
}

// ---------------------------------------------------------------- asal (kimlik sahibi: uye ya da anahtar)
/**
 * Asal: bir istegi yapan taraf. tur: 'member' | 'key'. yontem: 'cookie' | 'key'.
 * ctx: { deviceIdOf(kanal), channelTotal() }  (kapsam hesabi icin)
 */
export class Principal {
  constructor(o, ctx) {
    Object.assign(this, { type: 'member', method: 'cookie', name: '', owner: null, identity: '', role: null, permissions: [], scope: null, expiresAt: null, ips: [], rateLimit: 600, concurrentStreams: 8, keyId: null }, o);
    this.ctx = ctx; this.set = new Set(this.permissions);
  }
  hasPermission(g) { return hasPermission(this.set, g); }
  /** izinlerden herhangi biri */
  anyPermission(list) { return list.some((g) => this.hasPermission(g)); }
  channelAllowed(channel) { return scopeChannelAllowed(this.scope, channel, this.ctx?.deviceIdOf); }
  isUnscoped() { return !this.scope; }
  /**
   * Bu asalin ADINA islem yaptigi uye: uyede kendisi, API anahtarinda anahtar kaydindaki SAHIP. `ad` anahtarin serbest metin goruntu adidir
   * (olusturan belirler) — sahiplik/yetki kararlarinda ASLA kullanilmaz.
   */
  get memberName() { return this.type === 'key' ? this.owner : this.name; }
  /** Gunluge yazilacak kisa kimlik: "admin" ya da "anahtar:a1b2c3d4" */
  get auditActor() { return this.type === 'key' ? `key:${this.keyId}` : this.name; }
  toPublic() {
    return { type: this.type, name: this.name, identity: this.identity, role: this.role, method: this.method, permissions: expandPermission(this.permissions), permissionRaw: this.permissions, scope: this.scope, expiresAt: this.expiresAt, ips: this.ips, rateLimit: this.rateLimit, keyId: this.keyId };
  }
}

// ---------------------------------------------------------------- yetki deposu (roller + API anahtarlari)
const KEY_FORMAT = /^kp_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const ROLE_ID = /^[a-z][a-z0-9_-]{1,31}$/;

const blockEscalation = (message) => { throw new PermissionError('PRIVILEGE_ESCALATION', message, 403); };
/**
 * Bir kaydin IP listesi ve bitisi `sinir`dan gevsek olamaz. sinir.ipler bos = IP kisiti yok; sinir.bitis null = suresiz.
 * varsayilanla=true (olusturma): eksik deger sinirdan alinir; false (guncelleme): eksik/gevsek deger reddedilir.
 * IP karsilastirmasi metin esitligiyle yapilir (CIDR kapsama hesabi yok): fazla siki, ama asla gevsek degil.
 */
function clampLinks({ ips, expiresAt }, limit, defaulting) {
  if (limit.ips?.length) {
    if (!ips.length && defaulting) ips = [...limit.ips];
    if (!ips.length || ips.some((k) => !limit.ips.includes(k))) blockEscalation('IP listeniz dışında ya da IP kısıtsız anahtar/hesap veremezsiniz');
  }
  if (limit.expiresAt) {
    if (!expiresAt && defaulting) expiresAt = limit.expiresAt;
    if (!expiresAt || Date.parse(expiresAt) > Date.parse(limit.expiresAt)) blockEscalation('Kendi bitişinizden uzun ya da süresiz anahtar/hesap veremezsiniz');
  }
  return { ips, expiresAt };
}
export { clampLinks };

export class PermissionStore {
  /**
   * vt: Veritabani; gizli: panelin gizli anahtari (Buffer). Veriyi yukle() getirir.
   * secenek.roleInUse(rolId) -> bool (uye/anahtar bu rolu kullaniyor mu)
   */
  constructor(db, secret, option = {}) {
    this.db = db; this.option = option; this.lock = new Lock();
    this.collRoles = new Collection(db, ROLES); this.collBuiltin = new Collection(db, BUILTIN_PERMISSIONS); this.collKey = new Collection(db, API_KEYS);
    // Etiket (cam/api-key) degisirse verilmis API anahtarlarinin hicbiri dogrulanmaz (karma tek yonlu, tasinamaz: migrations.mjs, surum 3).
    this.hashKey = apiKeyHashKey(secret);
    this.data = { version: 1, roles: {}, keys: [], builtinPermissions: {} };
    this.error = new ErrorLimit(); this.rate = new RateLimit(); this.streams = new Map();
    this.dirty = false; this.timer = null;
    // bellek: hiz penceresi ve hata kisiti kayitlari periyodik temizlenir (unref: sureci acik tutmaz)
    this.cleanup = setInterval(() => { this.rate.clear(); for (const [ip, d] of this.error.ips) if (Date.now() - d.first > this.error.windowMs && d.lock < Date.now()) this.error.ips.delete(ip); }, 60_000); this.cleanup.unref?.();
  }

  /** Acilista veritabanindan belleğe. */
  async load() {
    const [roles, builtin, keys] = await Promise.all([this.collRoles.load(), this.collBuiltin.load(), this.collKey.load()]);
    this.#getToMemory(roles, builtin, keys);
    return this;
  }
  #getToMemory(roles, builtin, keys) {
    this.data = {
      version: 1, keys,
      roles: Object.fromEntries(roles.map(({ id, ...r }) => [id, r])),
      builtinPermissions: Object.fromEntries(builtin.map((x) => [x.role, x.permissions])),
    };
  }
  #lists() {
    return [
      [this.collRoles, Object.entries(this.data.roles).map(([id, r]) => ({ id, ...r }))],
      [this.collBuiltin, Object.entries(this.data.builtinPermissions ?? {}).map(([role, permissions]) => ({ role, permissions }))],
      [this.collKey, this.data.keys],
    ];
  }
  /** Bellegin su anki halini yazar (degisen satirlar; hepsi tek islemde). */
  async #write() { await saveTogether(this.db, this.#lists()); this.dirty = false; }
  /** Bellek degisikligi (fn, esinkron) + veritabani yazimi tek parca ve sirayla; yazim basarisizsa bellek son basarili haline doner. */
  #transaction(fn) {
    return this.lock.run(async () => {
      const result = fn();
      await writeOrRollback(() => this.#write(), () => this.#getToMemory(this.collRoles.rollback(), this.collBuiltin.rollback(), this.collKey.rollback()), 'permissions');
      return result;
    });
  }
  /** Sik degisen alanlar (son kullanim) icin ertelenmis yazim; basarisizsa kirli kalir, sonraki turda yeniden denenir. */
  #defer() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.lock.run(() => this.#write()).catch((e) => { console.error('api anahtari son kullanimi yazilamadi:', e?.message ?? e); this.#defer(); });
    }, 15_000);
    this.timer.unref?.();
  }
  /** Kapanis: bekleyen ertelenmis yazim varsa veritabanina islenir. */
  async close() {
    clearInterval(this.cleanup);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) await this.lock.run(() => this.#write()).catch((e) => console.error('api anahtari son kullanimi yazilamadi:', e?.message ?? e));
  }

  // ---------- roller
  roles() {
    return [...Object.entries(BUILTIN_ROLES).map(([id, r]) => ({ id, ...r, permissions: r.permissionEditable ? (this.data.builtinPermissions?.[id] ?? r.permissions) : r.permissions })),
      ...Object.entries(this.data.roles).map(([id, r]) => ({ id, name: r.name, description: r.description, permissions: r.permissions, builtin: false, createdBy: r.createdBy, createdAt: r.createdAt }))];
  }
  findRole(id) { return this.roles().find((r) => r.id === id) ?? null; }
  roleVar(id) { return !!this.findRole(id); }
  rolePermissions(id) { return this.findRole(id)?.permissions ?? []; }

  #verifyRole(g, existing = null) {
    const name = typeof g.name === 'string' ? { tr: g.name, en: g.name } : g.name;
    if (!name || typeof name !== 'object' || !String(name.tr ?? name.en ?? '').trim()) throw new PermissionError('INVALID_REQUEST', 'Rol adı gerekli', 400);
    const nameClean = { tr: String(name.tr ?? name.en).trim().slice(0, 60), en: String(name.en ?? name.tr).trim().slice(0, 60) };
    const description = typeof g.description === 'string' ? { tr: g.description.slice(0, 200), en: g.description.slice(0, 200) } : (g.description ? { tr: String(g.description.tr ?? '').slice(0, 200), en: String(g.description.en ?? g.description.tr ?? '').slice(0, 200) } : { tr: '', en: '' });
    const permissions = [...new Set(g.permissions ?? existing?.permissions ?? [])];
    if (!permissions.length) throw new PermissionError('INVALID_REQUEST', 'Rolde en az bir izin olmalı', 400);
    const bad = permissions.find((i) => !permissionValid(i));
    if (bad) throw new PermissionError('INVALID_REQUEST', `Bilinmeyen izin: ${bad}`, 400);
    if (permissions.includes('*')) throw new PermissionError('INVALID_REQUEST', 'Özel rollerde "*" kullanılamaz (tam yetki için yerleşik admin rolü vardır)', 400);
    return { name: nameClean, description, permissions };
  }
  addRole(g, createdBy, parentPermissions = ['*']) {
    return this.#transaction(() => {
    const id = String(g.id ?? '').trim();
    if (!ROLE_ID.test(id)) throw new PermissionError('INVALID_REQUEST', 'Rol kimliği küçük harf/rakam/-/_ ile başlamalı (2-32 karakter)', 400);
    if (this.roleVar(id)) throw new PermissionError('CONFLICT', 'Bu rol kimliği kullanılıyor', 409);
    const r = this.#verifyRole(g);
    if (!isPermissionSubset(r.permissions, parentPermissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
    this.data.roles[id] = { ...r, createdBy, createdAt: new Date().toISOString() };
    return this.findRole(id);
    });
  }
  updateRole(id, g, parentPermissions = ['*']) {
    return this.#transaction(() => {
    // DC rolleri (network/teknik/muhasebe): ad sabit, yalniz izinler degisir; bos liste gecerli (izinsiz rol).
    if (BUILTIN_ROLES[id]?.permissionEditable) {
      const permissions = [...new Set(g.permissions ?? [])];
      const bad = permissions.find((i) => !permissionValid(i));
      if (bad) throw new PermissionError('INVALID_REQUEST', `Bilinmeyen izin: ${bad}`, 400);
      if (permissions.includes('*')) throw new PermissionError('INVALID_REQUEST', 'Bu rolde "*" kullanılamaz (tam yetki yalnız admin rolünde)', 400);
      if (!isPermissionSubset(permissions, parentPermissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
      this.data.builtinPermissions = { ...(this.data.builtinPermissions ?? {}), [id]: permissions };
      return this.findRole(id);
    }
    if (BUILTIN_ROLES[id]) throw new PermissionError('BUILTIN_IMMUTABLE', 'Yerleşik roller değiştirilemez', 403);
    const existing = this.data.roles[id]; if (!existing) throw new PermissionError('NOT_FOUND', 'Rol yok', 404);
    const r = this.#verifyRole({ name: g.name ?? existing.name, description: g.description ?? existing.description, permissions: g.permissions ?? existing.permissions }, existing);
    if (!isPermissionSubset(r.permissions, parentPermissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
    this.data.roles[id] = { ...existing, ...r };
    return this.findRole(id);
    });
  }
  removeRole(id) {
    return this.#transaction(() => {
    if (BUILTIN_ROLES[id]) throw new PermissionError('BUILTIN_IMMUTABLE', 'Yerleşik roller silinemez', 403);
    if (!this.data.roles[id]) throw new PermissionError('NOT_FOUND', 'Rol yok', 404);
    if (this.data.keys.some((a) => a.role === id) || this.option.roleInUse?.(id)) throw new PermissionError('CONFLICT', 'Bu rol bir üye ya da anahtar tarafından kullanılıyor', 409);
    delete this.data.roles[id];
    });
  }

  // ---------- API anahtarlari
  #toPublic(a) { const { hash, ...g } = a; return { ...g, permissionsEffective: expandPermission(this.keyPermissions(a)), active: this.isActive(a) }; }
  keyPermissions(a) { return [...new Set([...(a.role ? this.rolePermissions(a.role) : []), ...(a.permissions ?? [])])]; }
  isActive(a, now = Date.now()) { return !a.revoked && !(a.expiresAt && Date.parse(a.expiresAt) <= now); }
  keys(owner = null) { return this.data.keys.filter((a) => !owner || a.owner === owner).map((a) => this.#toPublic(a)); }
  findKey(id) { const a = this.data.keys.find((x) => x.id === id); return a ? this.#toPublic(a) : null; }
  /** Ham kayit (karma dahil) — yalniz kimlik ara katmani icin. */
  keyRaw(id) { return this.data.keys.find((x) => x.id === id) ?? null; }
  #hash(secret) { return createHmac('sha256', this.hashKey).update(secret).digest('hex'); }
  #newSecret() { return randomBytes(32).toString('base64url'); }

  /**
   * Yeni anahtar. sahip: anahtarin sahibi (uye adi). olusturanAsal: yetki yukseltmeyi denetlemek icin (izin ve kapsam alt kume olmali).
   * Dondurur { kayit, anahtar } — anahtar (gizli) BIR KEZ doner.
   */
  createKey(g, createdBy, { parentPermissions = ['*'], parentScope = null, channelTotal = 0, deviceIdOf = null, parentIps = [], parentExpiresAt = null, parentRate = null, parentStream = null } = {}) {
    return this.#transaction(() => {
    const name = String(g.name ?? '').trim();
    if (!name || name.length > 60) throw new PermissionError('INVALID_REQUEST', 'Anahtar adı gerekli (en çok 60 karakter)', 400);
    const role = g.role ? String(g.role) : null;
    if (role && !this.roleVar(role)) throw new PermissionError('INVALID_REQUEST', `Rol bulunamadı: ${role}`, 400);
    const permissions = [...new Set(g.permissions ?? [])];
    const bad = permissions.find((i) => !permissionValid(i));
    if (bad) throw new PermissionError('INVALID_REQUEST', `Bilinmeyen izin: ${bad}`, 400);
    if (!role && !permissions.length) throw new PermissionError('INVALID_REQUEST', 'Bir rol ya da en az bir izin gerekli', 400);
    const scope = normalizeScope(g.scope);
    const effective = [...new Set([...(role ? this.rolePermissions(role) : []), ...permissions])];
    if (!isPermissionSubset(effective, parentPermissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri bir anahtara veremezsiniz', 403);
    if (parentScope && !scopeWithin(scope, parentScope, channelTotal, deviceIdOf)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Kapsamınızın dışındaki kameraları bir anahtara veremezsiniz', 403);
    if (parentScope && !scope) throw new PermissionError('PRIVILEGE_ESCALATION', 'Kapsamınız kısıtlı: anahtar da kısıtlı olmalı', 403);
    let expiresAt = normalizeExpiresAt(g.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new PermissionError('INVALID_REQUEST', 'Bitiş tarihi geçmişte', 400);
    let ips = normalizeIps(g.ips);
    const count = (v, v0, sub, top, name2) => { const n = v === undefined || v === null ? v0 : Number(v); if (!Number.isInteger(n) || n < sub || n > top) throw new PermissionError('INVALID_REQUEST', `${name2} ${sub}-${top} arasında tam sayı olmalı`, 400); return n; };
    // varsayilan, anahtar uretene anahtar ise onun sinirini asmaz
    let rateLimit = count(g.rateLimit, parentRate != null ? Math.min(120, parentRate) : 120, 1, 6000, 'Hız limiti');
    let concurrentStreams = count(g.concurrentStreams, parentStream != null ? Math.min(4, parentStream) : 4, 0, 32, 'Eşzamanlı akış');
    // Olusturanin kendi baglari (IP listesi, bitis, hiz/akis siniri) anahtara tasinir: kisitli bir olusturan kisitsiz anahtar uretemez.
    ({ ips, expiresAt } = clampLinks({ ips, expiresAt }, { ips: parentIps, expiresAt: parentExpiresAt }, true));
    if (parentRate != null && rateLimit > parentRate) blockEscalation('Hız limiti sizinkini aşamaz');
    if (parentStream != null && concurrentStreams > parentStream) blockEscalation('Akış sınırı sizinkini aşamaz');
    let id; do { id = randomBytes(4).toString('hex'); } while (this.data.keys.some((a) => a.id === id));
    const secret = this.#newSecret();
    const record = {
      id, name, prefix: `kp_${id}_${secret.slice(0, 4)}…`, hash: this.#hash(secret), role, permissions, scope, expiresAt, ips, rateLimit, concurrentStreams,
      owner: g.owner ?? createdBy, createdBy, createdAt: new Date().toISOString(), lastUsed: null, counter: 0, revoked: null, notes: String(g.notes ?? '').slice(0, 200),
    };
    this.data.keys.push(record);
    return { record: this.#toPublic(record), key: `kp_${id}_${secret}` };
    });
  }
  updateKey(id, g, { parentPermissions = ['*'], parentScope = null, channelTotal = 0, deviceIdOf = null, restricted = false, parentIps = [], parentExpiresAt = null } = {}) {
    return this.#transaction(() => {
    const a = this.data.keys.find((x) => x.id === id); if (!a) throw new PermissionError('NOT_FOUND', 'Anahtar yok', 404);
    if (a.revoked) throw new PermissionError('CONFLICT', 'İptal edilmiş anahtar değiştirilemez', 409);
    const fresh = { ...a };
    if (g.name !== undefined) { const name = String(g.name).trim(); if (!name || name.length > 60) throw new PermissionError('INVALID_REQUEST', 'Anahtar adı gerekli', 400); fresh.name = name; }
    if (g.role !== undefined) { if (g.role && !this.roleVar(g.role)) throw new PermissionError('INVALID_REQUEST', `Rol bulunamadı: ${g.role}`, 400); fresh.role = g.role || null; }
    if (g.permissions !== undefined) { const unique = [...new Set(g.permissions)]; const bad = unique.find((i) => !permissionValid(i)); if (bad) throw new PermissionError('INVALID_REQUEST', `Bilinmeyen izin: ${bad}`, 400); fresh.permissions = unique; }
    if (g.scope !== undefined) fresh.scope = normalizeScope(g.scope);
    if (g.expiresAt !== undefined) fresh.expiresAt = normalizeExpiresAt(g.expiresAt);
    if (g.ips !== undefined) fresh.ips = normalizeIps(g.ips);
    if (g.rateLimit !== undefined) { const n = Number(g.rateLimit); if (!Number.isInteger(n) || n < 1 || n > 6000) throw new PermissionError('INVALID_REQUEST', 'Hız limiti 1-6000 arasında olmalı', 400); fresh.rateLimit = n; }
    if (g.concurrentStreams !== undefined) { const n = Number(g.concurrentStreams); if (!Number.isInteger(n) || n < 0 || n > 32) throw new PermissionError('INVALID_REQUEST', 'Eşzamanlı akış 0-32 arasında olmalı', 400); fresh.concurrentStreams = n; }
    if (g.notes !== undefined) fresh.notes = String(g.notes).slice(0, 200);
    const effective = this.keyPermissions(fresh);
    if (!effective.length) throw new PermissionError('INVALID_REQUEST', 'Bir rol ya da en az bir izin gerekli', 400);
    if (!isPermissionSubset(effective, parentPermissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri bir anahtara veremezsiniz', 403);
    if (parentScope && (!fresh.scope || !scopeWithin(fresh.scope, parentScope, channelTotal, deviceIdOf))) throw new PermissionError('PRIVILEGE_ESCALATION', 'Kapsamınızın dışındaki kameraları bir anahtara veremezsiniz', 403);
    if (restricted) {
      // permission.manage'siz cagiran: DEGISEN bag hem kendi baglarini hem kaydin MEVCUT baglarini (admin koymus olabilir) gevsetemez.
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      if (!same(fresh.ips, a.ips)) for (const i of [parentIps, a.ips]) clampLinks({ ips: fresh.ips, expiresAt: null }, { ips: i, expiresAt: null }, false);
      if (!same(fresh.expiresAt, a.expiresAt)) for (const b of [parentExpiresAt, a.expiresAt]) clampLinks({ ips: [], expiresAt: fresh.expiresAt }, { ips: [], expiresAt: b }, false);
      if (fresh.rateLimit > a.rateLimit) blockEscalation('Hız limiti permission.manage olmadan artırılamaz');
      if (fresh.concurrentStreams > a.concurrentStreams) blockEscalation('Akış sınırı permission.manage olmadan artırılamaz');
    }
    Object.assign(a, fresh);
    return this.#toPublic(a);
    });
  }
  /** Gizliyi degistirir: eski gizli hemen gecersiz olur (anahtar kimligi ayni kalir). */
  rotateKey(id) {
    return this.#transaction(() => {
    const a = this.data.keys.find((x) => x.id === id); if (!a) throw new PermissionError('NOT_FOUND', 'Anahtar yok', 404);
    if (a.revoked) throw new PermissionError('CONFLICT', 'İptal edilmiş anahtar yenilenemez', 409);
    const secret = this.#newSecret();
    a.hash = this.#hash(secret); a.prefix = `kp_${id}_${secret.slice(0, 4)}…`; a.version = (a.version ?? 1) + 1;
    return { record: this.#toPublic(a), key: `kp_${id}_${secret}` };
    });
  }
  revokeKey(id, who) {
    return this.#transaction(() => {
    const a = this.data.keys.find((x) => x.id === id); if (!a) throw new PermissionError('NOT_FOUND', 'Anahtar yok', 404);
    if (!a.revoked) { a.revoked = { at: new Date().toISOString(), by: who }; }
    return this.#toPublic(a);
    });
  }
  removeKey(id) {
    return this.#transaction(() => {
    const n = this.data.keys.length;
    this.data.keys = this.data.keys.filter((a) => a.id !== id);
    if (this.data.keys.length === n) throw new PermissionError('NOT_FOUND', 'Anahtar yok', 404);
   
    });
  }

  /**
   * Bearer metnindeki API anahtarini dogrular. Basarisizlikta PermissionError (401/429). Dondurur ham kayit.
   * ip: istemci IP'si (kaba kuvvet kisiti ve IP listesi icin).
   */
  verifyKey(text, ip) {
    const wait = this.error.isLocked(ip);
    if (wait) throw new PermissionError('TOO_MANY_ATTEMPTS', `Çok fazla başarısız deneme. ${wait} sn sonra tekrar deneyin.`, 429, { retryAfterSec: wait });
    const m = KEY_FORMAT.exec(String(text ?? '').trim());
    const a = m ? this.data.keys.find((x) => x.id === m[1]) : null;
    // zamanlama farki anahtar kimliginin varligini sizdirmasin: her durumda ayni isi yap
    const expected = a?.hash ?? this.#hash('none');
    const incoming = this.#hash(m ? m[2] : 'none');
    const correct = !!a && equal(expected, incoming);
    if (!correct) { this.error.error(ip); throw new PermissionError('INVALID_KEY', 'API anahtarı geçersiz', 401); }
    this.error.success(ip);
    if (a.revoked) throw new PermissionError('KEY_REVOKED', 'API anahtarı iptal edilmiş', 401);
    if (a.expiresAt && Date.parse(a.expiresAt) <= Date.now()) throw new PermissionError('EXPIRED', 'API anahtarının süresi dolmuş', 401);
    if (!ipMatches(ip, a.ips)) throw new PermissionError('IP_BLOCKED', 'Bu IP adresinden bu anahtar kullanılamaz', 403, { ip });
    return a;
  }
  saveUsage(id, ip) {
    const a = this.data.keys.find((x) => x.id === id); if (!a) return;
    a.lastUsed = { at: new Date().toISOString(), ip }; a.counter = (a.counter ?? 0) + 1; this.#defer();
  }

  // ---------- hiz siniri ve akis siniri
  attemptRate(principal, now = Date.now()) {
    const r = this.rate.attempt(principal.identity, principal.rateLimit, 60_000, now);
    if (!r.ok) throw new PermissionError('RATE_LIMIT', `Hız sınırı aşıldı (${principal.rateLimit} istek/dk)`, 429, { retryAfterSec: r.resetSec });
    return r;
  }
  /**
   * Eszamanli akis hakki ister; dondurulen fonksiyon hakki birakir.
   * ortak: sunucuda paylasilan akisin anahtari (canli). Ayni akisi ikinci sekme/ekran izlerse yeni hak harcanmaz:
   * sunucu kameraya yine tek baglanti acar. Anahtarsiz akis (oynatma/indirme) her istekte ayri sayilir.
   */
  openStream(principal, shared = null) {
    const limit = principal.concurrentStreams;
    const m = this.streams.get(principal.identity) ?? new Map();
    const k = shared ?? Symbol('stream');
    if (!m.has(k) && limit !== undefined && limit !== null && m.size >= limit) throw new PermissionError('STREAM_LIMIT', `Eşzamanlı akış sınırı aşıldı (${limit})`, 429, { retryAfterSec: 5 });
    m.set(k, (m.get(k) ?? 0) + 1); this.streams.set(principal.identity, m);
    let released = false;
    return () => {
      if (released) return; released = true;
      const n = (m.get(k) ?? 1) - 1;
      if (n <= 0) m.delete(k); else m.set(k, n);
      if (!m.size && this.streams.get(principal.identity) === m) this.streams.delete(principal.identity);
    };
  }

}


