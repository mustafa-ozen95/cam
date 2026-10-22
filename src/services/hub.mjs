/**
 * Kimlik Yonetim Merkezi (KYM) ile konusan istemci ve merkez baglari.
 *
 * AKIS: Authorization Code + PKCE. Kullanici merkezin kendi sayfasinda giris yapar, buraya tek kullanimlik bir
 * kod doner; kod sunucu tarafinda jetona cevrilir ve /oauth/kullanici ile kimlik okunur. Parola bu panele ugramaz.
 * EYS/NYS panellerindeki HubClient ile ayni protokol (bkz. KYM Uygulamalar ekrani).
 *
 * BAGLAR (merkez_baglari tablosu): merkezdeki kimlik (sub) -> buradaki uye adi. Merkezde erisimi kalkan ya da
 * rolu degisen kisi burada da ayni anda degismeli; durum, giriste ve her N dakikada bir arka kanaldan
 * (/api/kimlik-durumu) sorulur, merkez bildirim gonderirse (/api/kimlik/tazele) hemen sorulur.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Lock, Collection, writeOrRollback } from '../core/tables.mjs';
import { HUB_LINKS } from '../database/schema.mjs';

/** Merkezin Turkce rol adlari -> panelin Ingilizce yerel rolleri (CAM_HUB_ROLE_MAP once bakilir). */
const HUB_ROLE_MAPPING = { 'teknik': 'technical', 'muhasebe': 'accounting', 'kamera': 'camera' };

export class HubUnauthorizedError extends Error {}

export class HubClient {
  constructor(identity) { this.k = identity; }

  /** Dort alan da doluysa acik. Yarim yapilandirma dugmeyi bile cizdirmez. */
  isEnabled() { return !!(this.k.address && this.k.client && this.k.secret && this.k.redirectUri); }

  codeVerifier() { return randomBytes(48).toString('base64url'); }                         // RFC 7636: 43-128 karakter
  codeChallenge(codeVerifier) { return createHash('sha256').update(codeVerifier).digest('base64url'); }

  authorizeUrl(status, codeChallenge) {
    const u = new URL(this.k.address + '/oauth/authorize');
    for (const [a, d] of Object.entries({ client_id: this.k.client, redirect_uri: this.k.redirectUri, response_type: 'code', scope: '', state: status, code_challenge: codeChallenge, code_challenge_method: 'S256' })) u.searchParams.set(a, d);
    return u.href;
  }

  async #req(path, option) {
    const ctrl = new AbortController(); const z = setTimeout(() => ctrl.abort(), 15_000);
    try { return await fetch(this.k.address + path, { ...option, signal: ctrl.signal }); } finally { clearTimeout(z); }
  }

  /** Kodu jetona cevirir. */
  async token(code, codeVerifier) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: this.k.client, client_secret: this.k.secret, redirect_uri: this.k.redirectUri, code_verifier: codeVerifier, code: code });
    const y = await this.#req('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body });
    if (!y.ok) throw new Error(`Merkez jetonu vermedi (${y.status})`);
    const j = await y.json();
    if (!j.access_token) throw new Error('Merkezden jeton gelmedi');
    return j;
  }

  /** Jetonun kime ait oldugu. 403: merkez bu uygulamaya kapiyi kapatmis (rol izinli degil) — ayri hata. */
  async username(token) {
    const y = await this.#req('/oauth/kullanici', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (y.status === 403) { const j = await y.json().catch(() => ({})); throw new HubUnauthorizedError(j['hata'] ?? 'Bu panele erişim yetkiniz yok.'); }
    if (!y.ok) throw new Error(`Merkez kimliği vermedi (${y.status})`);
    const v = await y.json();
    if (!v.sub || !v.email) throw new Error('Merkezden gelen kimlik eksik');
    return { sub: String(v.sub), name: String(v.name ?? ''), email: String(v.email), emailVerified: !!v.email_verified, role: v['rol'] ? String(v['rol']) : null, canCreateAccount: !!v['hesap_acilabilir'] };
  }

  /** Merkezdeki kimliklerin SU ANKI durumu (arka kanal; istemci kimligi ve sirriyla). Yalnizca sorulanlar doner. */
  async identityStatuses(identities) {
    if (!identities.length) return {};
    const y = await this.#req('/api/kimlik-durumu', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: this.k.client, client_secret: this.k.secret, 'kimlikler': identities }) });
    if (!y.ok) throw new Error(`Merkez kimlik durumlarını vermedi (${y.status})`);
    return (await y.json())['kimlikler'] ?? {};
  }

  /** Ortak cikis: "bu kisi bende cikti" (merkez: /api/oturum-kapandi). Merkez ani yazar, kendi oturumunu ve diger panelleri kapatir. */
  async sessionClosed(subject) {
    const y = await this.#req('/api/oturum-kapandi', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: this.k.client, client_secret: this.k.secret, subject }) });
    if (!y.ok) throw new Error(`Merkez çıkışı almadı (${y.status})`);
  }

  /** Merkezin cikis bildirimi: imza ANI da kapsar (`cikis|<subject>|<an>`), boylece an merkeze yeniden sorulmadan uygulanir. */
  isLogoutSigned(subject, moment, signature) {
    if (!this.k.notifySecret || !subject || !Number.isSafeInteger(moment) || moment <= 0 || !signature) return false;
    const expected = createHmac('sha256', this.k.notifySecret).update(`cikis|${subject}|${moment}`).digest('hex');
    return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  /** Merkezden gelen bildirimin imzasi dogru mu? (HMAC-SHA256, bildirim sirriyla; sir bossa hicbir bildirim kabul edilmez) */
  isNotificationSigned(subject, signature) {
    if (!this.k.notifySecret || !subject || !signature) return false;
    const expected = createHmac('sha256', this.k.notifySecret).update(subject).digest('hex');
    return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}

/**
 * Merkez baglari: sub -> { ad, eposta, rol (merkezdeki), girebilir, kontrol (son sorgu), lastLogin }.
 * Erisim karari burada degil merkezde: `girebilir` merkezin son soyledigidir; false ise oturum cerezi islemez.
 *
 * BAG UYENIN ADINA DEGIL, UYENIN KENDISINE baglidir: `userStamp` = uyenin olusturma damgasi. Ad silinip yeniden kullanilabilir; damga
 * tutmayan (ayni adli ama baska) bir uye bagi devralamaz, merkezdeki rolu ona uygulanmaz. Uye silinince bag da silinir (releaseMember).
 * Eski kayitlarda (damgasiz) bag, yuklenirken ADIN GUNCEL uyesinin damgasini alir; uyesi olmayan eski bag atilir.
 */
export class HubLinks {
  constructor(db, { hub, members, auditLog, config }) {
    this.db = db; this.coll = new Collection(db, HUB_LINKS); this.lock = new Lock();
    this.hub = hub; this.members = members; this.auditLog = auditLog; this.k = config.identity;
    this.data = {};
    this.lastAttempt = new Map();   // sub -> ms (merkeze ulasilamayinca bir dakika beklenir; her istekte denenmez)
    this.running = new Map();    // sub -> Promise (ayni kimlik icin es zamanli ikinci sorgu acilmaz)
  }

  /** Acilista veritabanindan bellege (uyeler once yuklenmis olmali). */
  async load() {
    this.data = this.#dict(await this.coll.load());
    await this.#stamp();
    return this;
  }
  #dict(list) { return Object.fromEntries(list.map(({ sub, ...b }) => [sub, b])); }
  /** Bellek degisikligi (fn, esinkron) + veritabani yazimi tek parca ve sirayla; yazim basarisizsa bellek son basarili haline doner. */
  #transaction(fn) {
    return this.lock.run(async () => {
      const result = fn();
      await writeOrRollback(() => this.coll.save(Object.entries(this.data).map(([sub, b]) => ({ sub, ...b }))), () => { this.data = this.#dict(this.coll.rollback()); }, 'hub_links');
      return result;
    });
  }

  /** Damgasiz (eski bicim) baglari mevcut uyeye damgalar; uyesi olmayanlari atar. Degisiklik varsa yazilir. */
  async #stamp() {
    if (!Object.values(this.data).some((b) => !b.userStamp)) return;
    await this.#transaction(() => {
      for (const [sub, b] of Object.entries(this.data)) {
        if (b.userStamp) continue;
        const u = this.members.find(b.name);
        if (u) b.userStamp = u.createdAt; else delete this.data[sub];
      }
    });
  }
  /** Bagin gercekten bagli oldugu uye (ad VE damga tutuyorsa), yoksa null. */
  #member(link) { const u = link && this.members.find(link.name); return u && link.userStamp && link.userStamp === u.createdAt ? u : null; }
  /** Uye silinince: o uyeye bagli (ya da ayni adi tutan) butun baglar dusurulur. */
  releaseMember(name) {
    const k = String(name).toLowerCase();
    return this.#transaction(() => { for (const [sub, b] of Object.entries(this.data)) if (b.name.toLowerCase() === k) delete this.data[sub]; });
  }
  find(sub) { return this.data[sub] ?? null; }
  /** Bu adli UYEYE bagli bag (damga tutmayan eski/yabanci bag sayilmaz). */
  byName(name) { const k = String(name).toLowerCase(); for (const [sub, b] of Object.entries(this.data)) if (b.name.toLowerCase() === k && this.#member(b)) return { sub, ...b }; return null; }
  everyone() { return Object.entries(this.data).map(([sub, b]) => ({ sub, ...b })); }

  /**
   * Merkezdeki rolun buradaki karsiligi. Roller DC panelleriyle ayni kimliklerde (admin, network, teknik, muhasebe):
   * eslemede yazmiyorsa ayni ad denenir, o da yoksa varsayilan rol. Hicbiri gecerli degilse null: hesap ACILMAZ —
   * eksik bilgi yetki uretmemeli.
   */
  localRole(hubRole) {
    for (const r of [hubRole && this.k.roleMap[hubRole], hubRole && HUB_ROLE_MAPPING[hubRole], hubRole, this.k.defaultRole]) if (r && this.members.roleValid(r)) return r;
    return null;
  }

  /**
   * Giriste: bagli uyeyi dondurur; bag yoksa ve merkez "hesap acilabilir" diyorsa uye acar.
   * Uye adi e-postanin kendisidir (diger paneller gibi; member.mjs kurali: 3-64, harf/rakam/._-@); catisirsa @ oncesine sayi eklenir.
   */
  async login(identity, req) {
    let link = this.find(identity.sub);
    if (link && !this.#member(link)) { await this.#transaction(() => { delete this.data[identity.sub]; }); link = null; }   // uye silinmis (ya da ayni adla baska uye): bag olu
    if (!link) {
      if (!identity.canCreateAccount || !identity.emailVerified) throw new HubUnauthorizedError('Bu panelde hesabınız yok; yöneticiye başvurun.');
      const name = this.#freeName(identity.email);
      const role = this.localRole(identity.role);
      if (!role) throw new HubUnauthorizedError('Merkezdeki rolünüzün bu panelde karşılığı yok; yöneticiye başvurun.');
      await this.members.add(name, randomBytes(24).toString('base64url'), role);          // parola rastgele: giris yalniz merkezden
      this.auditLog.write('hub-account-created', name, req, { email: identity.email, hubRole: identity.role, role });
      link = { name, userStamp: this.members.find(name).createdAt, email: identity.email, role: identity.role, canLogin: true, check: null, lastLogin: null };
    }
    await this.#applyRole(link, identity.role, req);
    await this.#transaction(() => {
      link.email = identity.email; link.canLogin = true; link.check = new Date().toISOString(); link.lastLogin = link.check; link.role = identity.role;
      this.data[identity.sub] = link;
    });
    return this.members.find(link.name);
  }

  #freeName(email) {
    const clean = String(email).toLowerCase().replace(/[^a-z0-9._@-]/g, '');
    const [local, field] = clean.split('@');
    const extra = field ? `@${field}` : '';
    const base = (local || 'hub').slice(0, 58 - extra.length);
    const make = (i = '') => `${base.length < 3 ? `${base}-kym` : base}${i}${extra}`;
    let name = make();
    const linkedName = (x) => Object.values(this.data).some((b) => b.name.toLowerCase() === x);
    for (let i = 2; this.members.find(name) || linkedName(name); i++) name = make(i);   // baglarin tuttugu adlar da dolu sayilir
    return name;
  }

  /** Merkezdeki rolun buradaki uyeye yansimasi (uyenin rolu); bagin kendi rol alani cagiranin islemiyle yazilir. */
  async #applyRole(link, hubRole, req = null) {
    const u = this.#member(link); if (!u) return;
    const fresh = this.localRole(hubRole);
    if (!fresh || u.role === fresh) return;
    try { await this.members.update(link.name, { role: fresh }, null); this.auditLog.write('hub-role-changed', link.name, req, { old: u.role, fresh, hubRole }); }
    catch (e) { this.auditLog.write('hub-role-error', link.name, req, { reason: e.message, hubRole }); }
  }

  /** Merkezin verdigi durumu uygular: girebilir / rol. Merkezin (KYM) Turkce alan adlari sozlesmedir; tirnakli okunur, degismez. */
  async applyStatus(sub, status) {
    const link = this.find(sub); if (!link) return;
    const canLogin = !!status['girebilir'];
    if (link.canLogin && !canLogin) this.auditLog.write('hub-access-revoked', link.name, null, { hubStatus: status['durum'] ?? 'unknown' });
    if (!link.canLogin && canLogin) this.auditLog.write('hub-access-granted', link.name, null, {});
    if (canLogin && status['rol'] !== undefined) await this.#applyRole(link, status['rol'] ?? null);
    await this.#transaction(() => {
      link.canLogin = canLogin; link.check = new Date().toISOString();
      if (canLogin && status['rol'] !== undefined) link.role = status['rol'] ?? null;
      // Ortak cikis: bildirim kaybolduysa an buradan gelir (bkz. processLogout).
      if (Number.isSafeInteger(status['son_cikis']) && status['son_cikis'] > (link.lastLogout ?? 0)) link.lastLogout = status['son_cikis'];
    });
  }

  /**
   * ORTAK CIKIS (bir panelden cikis merkezden ve oteki panellerden de cikistir): merkezdeki son cikis ani (ms).
   * Bu andan ONCE acilmis oturum cerezi islemez. An yalniz ILERI gider: gec gelen eski bildirim yeni girisi kapatmaz.
   */
  async processLogout(sub, moment) {
    const link = this.find(sub);
    if (!link || !Number.isSafeInteger(moment) || moment <= (link.lastLogout ?? 0)) return false;
    await this.#transaction(() => { link.lastLogout = moment; });
    return true;
  }

  /** Bu oturum (acilis ani ms) bagli uyenin merkezdeki son cikisindan once mi acildi? Bagsiz uye: hayir. */
  isLogoutAfter(name, openedAt) {
    const link = this.byName(name);
    return !!link && (link.lastLogout ?? 0) > 0 && (openedAt ?? 0) < link.lastLogout;
  }

  /** Oturum cerezi islemeli mi? Bagsiz uye: evet. Bagli uye: merkezin son dedigi; sure dolduysa arka planda yeniden sorulur. */
  isAccessible(name) {
    const link = this.byName(name);
    if (!link) return true;
    if (this.hub.isEnabled()) this.#refreshIfNeeded(link.sub, link);
    return link.canLogin !== false;
  }

  #refreshIfNeeded(sub, link) {
    const now = Date.now();
    const stale = !link.check || now - Date.parse(link.check) > this.k.checkMinutes * 60_000;
    if (!stale || this.running.has(sub) || (this.lastAttempt.get(sub) ?? 0) > now - 60_000) return;
    this.refresh(sub).catch(() => {});
  }

  /** Merkeze sorup uygular; cagiran beklemek zorunda degil. Hata: bir dakika yeniden denenmez (merkez yoksa panel durmaz). */
  refresh(sub) {
    if (this.running.has(sub)) return this.running.get(sub);
    const is = (async () => {
      try { const d = await this.hub.identityStatuses([sub]); if (d[sub]) await this.applyStatus(sub, d[sub]); }
      catch (e) { this.lastAttempt.set(sub, Date.now()); console.error('merkez durumu sorulamadı:', e.message); }
      finally { this.running.delete(sub); }
    })();
    this.running.set(sub, is);
    return is;
  }
}
