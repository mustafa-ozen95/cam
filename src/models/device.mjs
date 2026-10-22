/**
 * Cihaz deposu (cihazlar tablosu): panele eklenen NVR'lar. Parolalar AES-256-GCM ile sifreli saklanir (anahtar: panelin gizli anahtarindan
 * turetilir; veritabani dokumu tek basina parola vermez). Her cihaza KALICI bir kanal blogu (baslangic) verilir: cihaz silinse de digerlerinin kanal
 * numaralari (ad/gizleme ayarlari) kaymaz. Tablo bossa CAM_DEVICES ortam degiskeni (JSON) ile tohumlanir.
 */
import { randomUUID } from 'node:crypto';
import { devicePasswordKey, seal, unseal } from '../core/crypto-labels.mjs';
import { Settings, Lock, Collection, writeOrRollback } from '../core/tables.mjs';
import { DEVICES } from '../database/schema.mjs';

export const TYPES = {
  uniview: { name: 'Uniview NVR', channel: 32, label: 'D' },
  hikvision: { name: 'Hikvision NVR', channel: 16, label: 'H', addCamera: true },
  xiongmai: { name: 'Xiongmai DVR', channel: 4, label: 'C' },
  camera: { name: 'IP Kamera (tek kamera)', channel: 1, label: 'K' },
};
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export class DeviceStore {
  /** vt: Veritabani; gizli: panelin gizli anahtari (Buffer); tohum: tablo bossa eklenecek ilk cihazlar. Veriyi yukle() getirir. */
  constructor(db, secret, seed = []) {
    this.db = db; this.coll = new Collection(db, DEVICES); this.settings_ = new Settings(db); this.lock = new Lock(); this.seed = seed;
    // Etiket (cam/device-password) degisirse kayitli cihaz parolalari cozulemez: veri goc ile tasinir (migrations.mjs, surum 3).
    this.key = devicePasswordKey(secret);
    this.list_ = []; this.blockLimit = 0;
  }

  /** Acilista veritabanindan bellege; tablo bossa CAM_DEVICES tohumu yazilir. */
  async load() {
    this.list_ = await this.coll.load();
    this.blockLimit = Number(await this.settings_.read('device-block-limit')) || 0;
    if (!this.list_.length && this.seed.length) await this.#transaction(() => { for (const t of this.seed) this.list_.push(this.#setup(t, null, true)); });
    // Ust sinir kayitli degilse mevcut bloklarin sonundan baslar (ilk yazimda kaydolur; silme de yazimdir, yani silmeden once kayda gecer).
    this.blockLimit = Math.max(this.blockLimit, this.#blockEnd());
    return this;
  }

  #blockEnd() { return this.list_.reduce((m, c) => Math.max(m, c.startIndex + c.channelCount), 0); }
  /** Kanal numaralari KALICIDIR: silinen/kuculen cihazin blogu hic yeniden verilmez (kapsamlardaki kanal numaralari yeni cihaza kaymasin). */
  /** Bellek degisikligi (fn, esinkron) + veritabani yazimi (ust sinir ayni islemde) tek parca ve sirayla; yazim basarisizsa bellek eski haline doner. */
  #transaction(fn) {
    return this.lock.run(async () => {
      const previousLimit = this.blockLimit;
      const result = fn();
      this.blockLimit = Math.max(this.blockLimit ?? 0, this.#blockEnd());
      await writeOrRollback(() => this.coll.save(this.list_, (c) => this.settings_.write('device-block-limit', this.blockLimit, c)), () => { this.list_ = this.coll.rollback(); this.blockLimit = previousLimit; }, 'devices');
      return result;
    });
  }

  encrypt(text) { return seal(this.key, text); }
  resolve(o) { return unseal(this.key, o); }

  /** Giris dogrulama + kayit nesnesi (kaydetmez). mevcut varsa guncelleme: bos alanlar eskisini korur. */
  #setup(g, existing, seed = false) {
    const type = g.type ?? existing?.type;
    if (!TYPES[type]) throw new Error('Cihaz türü geçersiz');
    const host = String(g.host ?? existing?.host ?? '').trim();
    if (!HOST.test(host)) throw new Error('Adres geçersiz (IP ya da alan adı)');
    const username = String(g.username ?? existing?.username ?? '').trim();
    if (!username || username.length > 64) throw new Error('Kullanıcı adı gerekli');
    const passwordGiven = g.password !== undefined && g.password !== '';
    // Kayitli parola yalniz girildigi HEDEFE gider: adres ya da port degisiyorsa parola yeniden girilmeli. Aksi halde device.manage sahibi
    // adresi kendi dinleyicisine cevirip kayitli parolayi (baglanti denemesiyle) ele gecirebilirdi. Hicbir yere baglanmadan reddedilir.
    const portValue = (name) => { const v = g[name] ?? existing?.[name]; return v === undefined || v === '' || v === null ? undefined : Number(v); };
    if (existing && !passwordGiven && (host !== existing.host || ['httpPort', 'rtspPort', 'port'].some((name) => portValue(name) !== existing[name])))
      throw new Error('Adres ya da port değiştiğinde cihaz parolası yeniden girilmeli');
    const password = passwordGiven ? String(g.password) : (existing ? this.resolve(existing.password) : '');
    if (!password || password.length > 128) throw new Error('Parola gerekli');
    const label = String(g.label ?? existing?.label ?? TYPES[type].label).trim();
    if (!/^[A-Za-z]{1,3}$/.test(label)) throw new Error('Kanal öneki 1-3 harf olmalı (ör. D, H)');
    const channelCount = type === 'camera' ? 1 : Number(g.channelCount ?? existing?.channelCount ?? TYPES[type].channel);
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 128) throw new Error('Kanal sayısı 1-128 olmalı');
    const port = (name) => { const v = g[name] ?? existing?.[name]; if (v === undefined || v === '' || v === null) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} geçersiz`); return n; };
    const name = String(g.name ?? existing?.name ?? '').trim().slice(0, 40);
    const template = type === 'camera' ? String(g.template ?? existing?.template ?? 'hikvision') : undefined;
    if (type === 'camera' && !['hikvision', 'dahua', 'uniview', 'custom'].includes(template)) throw new Error('Kamera markası geçersiz');
    const path = type === 'camera' ? String(g.path ?? existing?.path ?? '').trim().slice(0, 200) : undefined;
    if (type === 'camera' && template === 'custom' && !path) throw new Error('Özel seçildiğinde RTSP yolu gerekli');
    return {
      id: existing?.id ?? randomUUID().slice(0, 8), name, type, host, username, password: passwordGiven || !existing ? this.encrypt(password) : existing.password,
      label, channelCount, httpPort: port('httpPort'), rtspPort: port('rtspPort'), port: port('port'), template, path,
      startIndex: existing?.startIndex ?? this.#emptyStartIndex(), createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  }
  #emptyStartIndex() { return Math.max(this.blockLimit ?? 0, this.#blockEnd()); }

  /** Arayuze giden liste (parola YOK). */
  list() { return this.list_.map(({ password, ...c }) => c); }
  /** Surucu olusturmak icin ayarlar (parola cozulmus). */
  settings() { return this.list_.map((c) => ({ ...c, password: this.resolve(c.password) })); }
  setting(id) { const c = this.list_.find((x) => x.id === id); return c ? { ...c, password: this.resolve(c.password) } : null; }

  /** Yeni cihaz kaydi hazirlar (henuz kaydetmez: once baglanti denenir). */
  prepare(g) {
    const k = this.#setup(g, null);
    if (this.list_.some((c) => c.host === k.host && c.type === k.type)) throw new Error('Bu cihaz zaten ekli');
    return { ...k, password: this.resolve(k.password) };
  }
  add(record) {
    const { password, ...rest } = record;
    return this.#transaction(() => { this.list_.push({ ...rest, password: this.encrypt(password) }); return this.setting(record.id); });
  }
  /** Guncelleme kaydi hazirlar; kanal blogu komsu cihazla cakisiyorsa hata. */
  updatePrepare(id, g) {
    const existing = this.list_.find((c) => c.id === id);
    if (!existing) throw new Error('Cihaz yok');
    const k = this.#setup({ ...g, type: existing.type }, existing);
    const next = this.list_.filter((c) => c.id !== id && c.startIndex >= k.startIndex).sort((a, b) => a.startIndex - b.startIndex)[0];
    if (next && k.startIndex + k.channelCount > next.startIndex) throw new Error(`Kanal sayısı en çok ${next.startIndex - k.startIndex} olabilir (sonraki cihazın kanalları başlıyor)`);
    return { ...k, password: this.resolve(k.password) };
  }
  update(record) {
    const { password, ...rest } = record;
    return this.#transaction(() => {
      const i = this.list_.findIndex((c) => c.id === record.id);
      this.list_[i] = { ...rest, password: this.encrypt(password) };
      return this.setting(record.id);
    });
  }
  remove(id) {
    return this.#transaction(() => {
      if (this.list_.length < 2) throw new Error('Son cihaz silinemez');
      if (!this.list_.some((c) => c.id === id)) throw new Error('Cihaz yok');
      this.list_ = this.list_.filter((c) => c.id !== id);
    });
  }
}
