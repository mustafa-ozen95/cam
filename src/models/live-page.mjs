/**
 * Canli izleme sayfalari (live_pages): her kayit bir adres (/<yol>/), ad, erisim ve ortak duzendir.
 *  - access 'public': herkes izler (uyeliksiz). 'private': giris yapmis ve canView'dan gecen uye/anahtar.
 *  - roles: private sayfada izin verilen rol kimlikleri; bos = live.view izni olan herkes. Admin ('*') her zaman gorur.
 *  - layout: { column, paths, savedBy, time }; null = varsayilan duzen (CAM_LIVE_DEFAULT ya da ilk 12 kamera).
 * Ilk kayit gocle (surum 4) eski tek /live sayfasindan gelir; ozel degildir, silinebilir.
 * Kimlik (id) degismez: yol degisse de denetim gunlugu ayni kaydi gosterir.
 */
import { randomBytes } from 'node:crypto';
import { Lock, Collection, writeOrRollback } from '../core/tables.mjs';
import { LIVE_PAGES } from '../database/schema.mjs';
import { PermissionError } from './permission.mjs';

/** Tek segment, kucuk harf/rakam/tire; nokta yok (index.html, icon.svg gibi dosya adlariyla cakismaz). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Panelin kendi adresleri; acilista statik rotalarin ilk segmentleri de eklenir (bkz. bootstrap). */
export const RESERVED_SLUGS = new Set(['api', 'stream', 'login', 'logout', 'docs', 'dokuman', 'css', 'js', 'fonts', 'static', 'assets', 'rtc', 'health', 'admin', 'settings', 'index.html', 'icon.svg', 'favicon.ico']);
export const LIVE_ACCESS = ['public', 'private'];

/** Girdi -> yol: bosluk, buyuk harf ve bastaki/sondaki / temizlenir. */
export const normalizeSlug = (v) => String(v ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
export function slugValid(slug, reserved = RESERVED_SLUGS) { return SLUG_RE.test(slug) && !reserved.has(slug) && !RESERVED_SLUGS.has(slug); }

/**
 * Bu kimlik (principal; null = kimliksiz) bu sayfayi gorebilir mi?
 *
 * SAYFADA ACIKCA SECILEN ROL, O SAYFAYI IZLEMEK ICIN YETER. Once live.view de isteniyordu: Muhasebe rolu sayfaya eklenmis
 * ama izinsiz oldugu icin giremiyordu; live.view vermek ise ona ana paneldeki BUTUN kameralari acardi. Rol secimi yalniz
 * bu sayfanin kamera listesini acar (allowedPaths). Yalniz uye: API anahtarinin rolu kendi izinlerinden genis olmasin.
 * Rol listesi bossa sayfa live.view izni olan herkese acik.
 */
export function canView(page, principal) {
  if (!page) return false;
  if (page.access === 'public') return true;
  if (!principal) return false;
  if (principal.hasPermission('*')) return true;
  if (page.roles?.length) return page.roles.includes(principal.role) && (principal.type === 'member' || principal.hasPermission('live.view'));
  return principal.hasPermission('live.view');
}

/** Uye (izni olmayan) icin gorebildigi ozel sayfalar: girisin varacagi yer (bkz. views.mainPage). */
export function rolePages(pages, principal) {
  return principal?.type === 'member' ? pages.filter((p) => p.access === 'private' && p.roles?.includes(principal.role)) : [];
}

export class LivePageStore {
  /** secenek.roleValid(id) -> bool; reserved: ek rezerve yollar (Set). */
  constructor(db, { roleValid = () => true, reserved = new Set() } = {}) {
    this.coll = new Collection(db, LIVE_PAGES); this.lock = new Lock();
    this.roleValid = roleValid; this.reserved = reserved;
    this.pages = []; this.index = new Map();
  }
  async load() { this.#set(await this.coll.load()); return this; }
  #set(list) { this.pages = list; this.index = new Map(list.map((p) => [p.slug, p])); }
  #transaction(fn) {
    return this.lock.run(async () => {
      const result = fn();
      this.index = new Map(this.pages.map((p) => [p.slug, p]));
      await writeOrRollback(() => this.coll.save(this.pages), () => this.#set(this.coll.rollback()), 'live_pages');
      return result;
    });
  }

  list() { return this.pages; }
  find(id) { return this.pages.find((p) => p.id === String(id ?? '')) ?? null; }
  bySlug(slug) { return this.index.get(String(slug ?? '').toLowerCase()) ?? null; }
  roleInUse(id) { return this.pages.some((p) => p.roles?.includes(id)); }

  /** g: { name?, slug?, access?, roles? } -> temiz alanlar. Gecersizse PermissionError (400/409). */
  #verify(g, existing = null) {
    const fresh = {};
    if (g.name !== undefined || !existing) {
      const name = String(g.name ?? '').trim();
      if (!name || name.length > 100) throw new PermissionError('INVALID_REQUEST', 'Ad 1-100 karakter olmalı', 400);
      fresh.name = name;
    }
    if (g.slug !== undefined || !existing) {
      const slug = normalizeSlug(g.slug);
      if (!slugValid(slug, this.reserved)) throw new PermissionError('INVALID_REQUEST', 'Geçersiz yol: küçük harf, rakam ve tire (a-z, 0-9, -); panelin kendi adresleri kullanılamaz', 400);
      const other = this.bySlug(slug);
      if (other && other !== existing) throw new PermissionError('CONFLICT', `Bu yol kullanılıyor: /${slug}`, 409);
      fresh.slug = slug;
    }
    if (g.access !== undefined || !existing) {
      const access = g.access ?? 'public';
      if (!LIVE_ACCESS.includes(access)) throw new PermissionError('INVALID_REQUEST', 'Erişim public ya da private olmalı', 400);
      fresh.access = access;
    }
    if (g.roles !== undefined || !existing) {
      const roles = g.roles ?? [];
      if (!Array.isArray(roles) || roles.length > 50 || !roles.every((r) => typeof r === 'string' && this.roleValid(r))) throw new PermissionError('INVALID_REQUEST', 'Rol listesi geçersiz', 400);
      fresh.roles = [...new Set(roles)];
    }
    return fresh;
  }

  add(g, who) {
    const fresh = this.#verify(g ?? {});
    let id; do id = randomBytes(4).toString('hex'); while (this.find(id));
    const page = { id, ...fresh, layout: { column: 4, paths: [] }, createdBy: who, createdAt: new Date().toISOString(), updatedBy: null, updatedAt: null };
    return this.#transaction(() => { this.pages.push(page); return page; });
  }
  update(id, g, who) {
    const page = this.find(id);
    if (!page) throw new PermissionError('NOT_FOUND', 'Canlı sayfa yok', 404);
    const fresh = this.#verify(g ?? {}, page);
    return this.#transaction(() => { Object.assign(page, fresh, { updatedBy: who, updatedAt: new Date().toISOString() }); return page; });
  }
  remove(id) {
    const page = this.find(id);
    if (!page) throw new PermissionError('NOT_FOUND', 'Canlı sayfa yok', 404);
    return this.#transaction(() => { this.pages = this.pages.filter((p) => p !== page); return page; });
  }
  /** Duzeni dogrulamaz (LiveService.writeLayout dogrular). */
  writeLayout(id, layout) {
    const page = this.find(id);
    if (!page) throw new PermissionError('NOT_FOUND', 'Canlı sayfa yok', 404);
    return this.#transaction(() => { page.layout = layout; return page; });
  }
}
