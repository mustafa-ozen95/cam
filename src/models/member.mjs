/**
 * Uyelik: kullanici adi + parola. Uyeyi yalniz yetkili olan (member.manage) olusturur.
 * Her uyenin bir ROLU (permission.mjs: yerlesik ya da ozel rol), istege bagli KAPSAMI (hangi kameralari gorebilir),
 * hesap BITIS tarihi ve IP/CIDR listesi vardir.
 * Parolalar scrypt ile tuzlanip saklanir (uyeler tablosu; bellekte onbellekli, yazma veritabanina islenince degisir); oturum, gizli
 * anahtarla imzali cerezdir (sunucuda oturum tablosu yok; cerez her istekte uyeden yeniden dogrulanir: uye silinince, parola degisince, cikis yapilinca
 * ya da ayni adla yeni hesap acilinca eski cerez islemez — cerez uyenin olusturma damgasina ve oturum surumune baglidir).
 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { LABELS, auditSignature } from '../core/crypto-labels.mjs';
import { Lock, Collection, writeOrRollback } from '../core/tables.mjs';
import { MEMBERS } from '../database/schema.mjs';
import { normalizeExpiresAt, ipMatches, normalizeIps, normalizeScope } from './permission.mjs';

const NAME_RULE = /^[a-zA-Z0-9._@-]{3,64}$/;   // @: merkezden gelen uye adi e-posta (diger paneller gibi)
const SESSION_DAYS = 30;

const hash = (password, salt) => scryptSync(password, salt, 32);
/** Giris yolunda zaman uyumsuz karma: scryptSync tek olay dongusunu onlarca ms kilitliyordu (kimliksiz istemci bunu tetikleyebilir). */
const hashAsync = (password, salt) => new Promise((resolve, red) => scrypt(password, salt, 32, (e, k) => (e ? red(e) : resolve(k))));

/** Gizli anahtarla imzalanan her seyin AMACI ayri etiketle baglanir: oturum cerezi, merkez akis cerezi, ... birbirinin yerine gecemez. */
export const SESSION_LABEL = LABELS.session;   // degisirse acik oturumlar duser
const ERROR_TTL = 15 * 60_000;   // giris hata kaydi bu kadar sure sonra silinir
const ERROR_MAX = 5000;       // kimliksiz istemci istedigi kadar yeni kullanici adiyla kayit sisirmesin
const NAME_MAX = 64;             // hata anahtarina giren ad bu kadar kirpilir

// Kayit cihazi ayni anda en cok 16 canli goruntu veriyor (17. kareden sonrasi baglanamaz); sayfa bunu asmaz.
export const ALL_COUNT = { min: 4, max: 16, fallback: 16 };
const ORDER_MAX = 1024;
/** Tercih kaydi: bilinen alanlar, sinirli degerler; disaridan gelen baska alan kayda girmez. */
export function normalizePreferences(t) {
  const g = t && typeof t === 'object' ? t : {};
  const count = Number.isInteger(g.allCount) ? Math.min(ALL_COUNT.max, Math.max(ALL_COUNT.min, g.allCount)) : ALL_COUNT.fallback;
  const order = Array.isArray(g.allOrder) ? [...new Set(g.allOrder.filter((k) => Number.isInteger(k) && k >= 0 && k < 100_000))].slice(0, ORDER_MAX) : [];
  return { allCount: count, allOrder: order, pauseInBackground: g.pauseInBackground !== false, gridStream: g.gridStream === 'main' ? 'main' : 'sub' };
}

export class Membership {
  /** vt: Veritabani; gizli: panelin gizli anahtari (Buffer). Veriyi yukle() getirir. */
  constructor(db, secret) {
    this.db = db; this.coll = new Collection(db, MEMBERS); this.lock = new Lock();
    this.list = []; this.secret = secret;
    this.errors = new Map(); // ip|ad -> { sayi, kilitli, z }
    this.cleanup = setInterval(() => this.#cleanErrors(), 60_000); this.cleanup.unref?.();
    /** Rol kimligi gecerli mi? sunucu, yetki deposunun rol listesine baglar. */
    this.roleValid = (r) => r === 'admin' || r === 'user';
  }

  /** Acilista veritabanindan belleğe. Olusturma damgasi olmayan kayda bir kez damga verilir ve yazilir: oturum ve KYM bagi bu damgaya baglanir (ad tek basina yeniden kullanilabilir). */
  async load() {
    this.list = await this.coll.load();
    if (this.list.some((u) => !u.createdAt)) await this.#transaction(() => { for (const u of this.list) u.createdAt ??= new Date().toISOString(); });
    return this;
  }
  /** Bellek degisikligi (fn, esinkron) + veritabani yazimi tek parca ve sirayla; yazim basarisizsa bellek eski haline doner, DatabaseError firlar. */
  #transaction(fn) {
    return this.lock.run(async () => {
      const result = fn();
      await writeOrRollback(() => this.coll.save(this.list), () => { this.list = this.coll.rollback(); }, 'members');
      return result;
    });
  }
  #adminCount() { return this.list.filter((x) => x.role === 'admin').length; }

  #cleanErrors(now = Date.now()) { for (const [k, h] of this.errors) if (now - h.z > ERROR_TTL && !(h.locked > now)) this.errors.delete(k); }

  empty() { return this.list.length === 0; }
  everyone() { return this.list.map(({ name, role, createdAt, scope, expiresAt, ips }) => ({ name, role, createdAt, scope: scope ?? null, expiresAt: expiresAt ?? null, ips: ips ?? [] })); }
  find(name) { return this.list.find((u) => u.name.toLowerCase() === String(name).toLowerCase()) ?? null; }
  /** Bu rolu kullanan uye var mi? (rol silmeden once) */
  roleInUse(id) { return this.list.some((u) => u.role === id); }

  /** Uyenin kendi gorunum tercihleri (canli "Hepsi" sirasi ve sayisi, arka planda durdurma). Yetki tasimaz; yalniz sahibi okur/yazar. */
  preferences(name) { return normalizePreferences(this.find(name)?.preferences); }
  /** Verilen alanlar degisir, verilmeyen kalir. Gecersiz deger hata degil, sinira cekilir ya da yok sayilir. */
  savePreferences(name, g) {
    return this.#transaction(() => {
      const u = this.find(name);
      if (!u) throw new Error('Kullanıcı yok');
      u.preferences = normalizePreferences({ ...u.preferences, ...(g && typeof g === 'object' ? g : {}) });
      return u.preferences;
    });
  }

  add(name, password, role, extra = {}) {
    return this.#transaction(() => {
    if (!NAME_RULE.test(name ?? '')) throw new Error('Kullanıcı adı 3-64 karakter olmalı (harf, rakam, . _ - @)');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('Parola en az 8 karakter olmalı');
    if (!this.roleValid(role)) throw new Error('Rol geçersiz');
    if (this.find(name)) throw new Error('Bu kullanıcı adı kullanılıyor');
    const salt = randomBytes(16);
    this.list.push({
      name, role, salt: salt.toString('hex'), hash: hash(password, salt).toString('hex'), createdAt: new Date().toISOString(), sessionVersion: 0,
      scope: normalizeScope(extra.scope), expiresAt: normalizeExpiresAt(extra.expiresAt), ips: normalizeIps(extra.ips),
    });
    });
  }

  /** g: { parola, rol, kapsam, bitis, ipler } (verilmeyen alan degismez). actorIp: islemi yapanin IP'si (kendini kilitlemeyi onler). */
  update(name, g, actor, actorIp = null) {
    return this.#transaction(() => {
    const { password, role } = g;
    const u = this.find(name);
    if (!u) throw new Error('Kullanıcı yok');
    const isLastAdmin = u.role === 'admin' && this.#adminCount() < 2;
    const fresh = {};
    if (role !== undefined) {
      if (!this.roleValid(role)) throw new Error('Rol geçersiz');
      if (isLastAdmin && role !== 'admin') throw new Error('Son admin kullanıcıya çevrilemez');
      if (u.name === actor && role !== u.role) throw new Error('Kendi rolünüzü değiştiremezsiniz');
      fresh.role = role;
    }
    if (g.scope !== undefined) {
      if (isLastAdmin) throw new Error('Son admin hesabına kapsam kısıtı konamaz');
      fresh.scope = normalizeScope(g.scope);
    }
    if (g.expiresAt !== undefined) {
      const expiresAt = normalizeExpiresAt(g.expiresAt);
      if (expiresAt && (isLastAdmin || (u.name === actor && u.role === 'admin' && this.#adminCount() < 2))) throw new Error('Son admin hesabına bitiş tarihi konamaz');
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error('Bitiş tarihi geçmişte');
      fresh.expiresAt = expiresAt;
    }
    if (g.ips !== undefined) {
      const ips = normalizeIps(g.ips);
      if (ips.length && u.name === actor && actorIp && !ipMatches(actorIp, ips)) throw new Error('Şu anki IP adresiniz listede yok; kendinizi kilitlerdiniz');
      fresh.ips = ips;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('Parola en az 8 karakter olmalı');
      const salt = randomBytes(16); fresh.salt = salt.toString('hex'); fresh.hash = hash(password, salt).toString('hex');
      fresh.sessionVersion = (u.sessionVersion ?? 0) + 1;      // parola degisince eldeki butun cerezler gecersiz
    }
    Object.assign(u, fresh);
    });
  }

  remove(name, actor) {
    return this.#transaction(() => {
    const u = this.find(name);
    if (!u) throw new Error('Kullanıcı yok');
    if (u.name === actor) throw new Error('Kendinizi silemezsiniz');
    if (u.role === 'admin' && this.#adminCount() < 2) throw new Error('Son admin silinemez');
    this.list = this.list.filter((x) => x !== u);
    });
  }

  /** Cikis / "her yerden cik": uyenin eldeki butun oturum cerezleri gecersiz olur (sunucuda oturum tablosu yok, surum sayaci var). */
  endSession(name) { return this.#transaction(() => { const u = this.find(name); if (!u) return; u.sessionVersion = (u.sessionVersion ?? 0) + 1; }); }

  /** Giris denemesi: yanlis parolada artan bekleme (5 hatadan sonra 60 sn kilit). Dondurur kullanici ya da firlatir. */
  async verify(name, password, ip) {
    const key = `${ip}|${String(name ?? '').slice(0, NAME_MAX).toLowerCase()}`;
    const h = this.errors.get(key);
    if (h?.locked > Date.now()) throw new Error(`Çok fazla deneme. ${Math.ceil((h.locked - Date.now()) / 1000)} sn sonra tekrar deneyin.`);
    const u = this.find(name);
    // kullanici yoksa da ayni isi yap (zamanlama farki kullanici adini sizdirmasin)
    const salt = u ? Buffer.from(u.salt, 'hex') : Buffer.alloc(16);
    const k = await hashAsync(String(password ?? '').slice(0, 128), salt);
    const correct = u && timingSafeEqual(k, Buffer.from(u.hash, 'hex'));
    if (!correct) {
      const count = (h?.count ?? 0) + 1;
      if (!h && this.errors.size >= ERROR_MAX) { this.#cleanErrors(); if (this.errors.size >= ERROR_MAX) this.errors.delete(this.errors.keys().next().value); }   // dolunca en eski kayit gider
      this.errors.set(key, { count, locked: count >= 5 ? Date.now() + 60_000 : 0, z: Date.now() });
      throw new Error('Kullanıcı adı ya da parola yanlış');
    }
    this.errors.delete(key);
    if (u.expiresAt && Date.parse(u.expiresAt) <= Date.now()) throw new Error('Hesabın süresi dolmuş');
    if (u.ips?.length && !ipMatches(ip, u.ips)) throw new Error('Bu IP adresinden giriş yapılamaz');
    return u;
  }

  /** Gunluk zinciri icin HMAC imzasi (etiket: cam/audit-log; degisirse zincir goc ile yeniden imzalanir). */
  signature(text) { return auditSignature(this.secret, text); }
  /** Amaca bagli imza: etiket MAC girdisine eklenir, baska amacla uretilmis imza burada tutmaz. */
  labeledSignature(label, payload) { return createHmac('sha256', this.secret).update(`${label}|${payload}`).digest('base64url'); }

  /** Uye kimligi: ad + olusturma damgasi. Ayni adla yeniden acilan hesap eskisinin cerezini/bagini devralamaz. */
  static stamp(u) { return u.createdAt ?? ''; }

  sessionCookie(u) {
    // g: acilis ani (ms) — merkezdeki son cikistan once acilan oturum islemez (ortak cikis, bkz. HubLinks.isLogoutAfter).
    const payload = Buffer.from(JSON.stringify({ t: 'session', a: u.name, k: Membership.stamp(u), s: u.sessionVersion ?? 0, g: Date.now(), e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return `${payload}.${this.labeledSignature(SESSION_LABEL, payload)}`;
  }

  /** Cerezi cozer; gecerliyse GUNCEL kullaniciyi ({ad, rol, kapsam, bitis, ipler}) dondurur (suresi dolmus hesap = null). */
  resolveSession(cookie) {
    if (!cookie) return null;
    const [payload, signature, extra] = cookie.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = this.labeledSignature(SESSION_LABEL, payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const { t, a, k, s, g, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (t !== 'session' || typeof a !== 'string' || typeof e !== 'number' || e < Date.now()) return null;
      const u = this.find(a);
      if (!u || u.name !== a || Membership.stamp(u) !== k || (u.sessionVersion ?? 0) !== s) return null;
      if (u.expiresAt && Date.parse(u.expiresAt) <= Date.now()) return null;
      return { name: u.name, role: u.role, scope: u.scope ?? null, expiresAt: u.expiresAt ?? null, ips: u.ips ?? [], openedAt: typeof g === 'number' ? g : 0 };
    } catch { return null; }
  }
}

export const readCookie = (header, name) => {
  for (const p of (header ?? '').split(';')) { const [k, ...v] = p.trim().split('='); if (k === name) return v.join('='); }
  return null;
};
