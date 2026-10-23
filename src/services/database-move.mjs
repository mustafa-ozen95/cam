/**
 * Panelin veritabani: nerede, uzak bir sunucuya TASINMASI ya da mevcut, dolu bir veritabanina BAGLANMASI.
 * DC panellerindeki Ayarlar -> Veritabani'nin (RemoteDatabase + ConnectionFile + <panel>-entrypoint) karsiligi; asamalar, sinamalar
 * ve iletiler ayni.
 *
 * IKI ISLEM: TASI su anki veritabanini BOS bir hedefe kopyalar. BAGLAN kopyalamaz; yeni bir kurulumu eski kurulumun DOLU
 * veritabanina gecirir. Baglanilacak hedef bu panelin olmali (goc kayitlari tutmali), bu surumden yeni olmamali ve bu kurulumun
 * gizli anahtariyla doldurulmus olmali (ayarlardaki key-fingerprint): yoksa cihaz parolalari cozulemez.
 *
 * Isin kendisi ACILISTA yapilir (bin/cam.mjs -> startupDatabase), uygulama dinlemeye baslamadan: kopya alinirken kimse yazmaz.
 * Panel istegi birakir ve sureci bitirir; konteyner (restart: unless-stopped) yeniden kalkar.
 *
 * IKI DOSYA, veri hacminde (data/database):
 *   connection.json  gizli anahtardan turetilen anahtarla SIFRELI: konak, port, veritabani, kullanici, parola
 *   state.json       duz: asama, zaman, sebep, hedef adresi; sir icermez
 *
 * ASAMALAR: tasinacak / baglanacak (istendi) -> tasiniyor -> deneniyor (uzak veritabaniyla ilk acilis) -> etkin | basarisiz.
 * "etkin"den sonra uzak veritabani acilmazsa panel BEKLER, icerdekine donmez: o, tasima anindaki haliyle donmustur.
 */
import mysql from 'mysql2/promise';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { databaseConnectionKey, keyFingerprint, seal, unseal } from '../core/crypto-labels.mjs';
import { MIGRATIONS } from '../database/migrations.mjs';

export const STAGES = ['tasinacak', 'baglanacak', 'tasiniyor', 'deneniyor', 'etkin', 'basarisiz'];
/** Yeni bir istek baslatan asamalar: onceki istegin alanlari tasinmaz. */
export const REQUESTS = ['tasinacak', 'baglanacak'];
/** Suren ya da tamamlanmis bir islem varken yenisi baslatilmaz. */
export const RUNNING = ['tasinacak', 'baglanacak', 'tasiniyor', 'deneniyor', 'etkin'];

/** Laravel'in (ve mysql2'nin) destekledigi en eski surumler; kardes panellerle ayni. */
const MINIMUM = { MariaDB: '10.3', MySQL: '5.7' };
const TEST_TABLES = ['dc_baglanti_sinamasi_b', 'dc_baglanti_sinamasi_a'];

/** Baglanti alanlari; baska alan okunmaz, yazilmaz. */
export const cleanTarget = (b = {}) => ({
  host: String(b.host ?? '').trim(),
  port: Number.parseInt(b.port, 10) || 3306,
  database: String(b.database ?? '').trim(),
  username: String(b.username ?? '').trim(),
  password: String(b.password ?? ''),
});
export const address = (b) => `${b.username}@${b.host}:${b.port}/${b.database}`;
export const isInternal = (host) => ['', '127.0.0.1', 'localhost', '::1'].includes(String(host ?? '').trim().toLowerCase());

/** Hedefteki goc kayitlari ile bu surumun gocleri (surum numaralari). */
export function compareMigrations(target, local) {
  const t = new Set(target.map(Number)), l = new Set(local.map(Number));
  return {
    common: [...t].filter((v) => l.has(v)).length,
    unknown: [...t].filter((v) => !l.has(v)).length,
    pending: [...l].filter((v) => !t.has(v)).length,
  };
}
export const localMigrations = () => MIGRATIONS.map((g) => g.version);

export class ConnectionFile {
  constructor(dir, secret) { this.dir = dir; this.key = databaseConnectionKey(secret); }

  #write(name, text) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.${name}.${randomBytes(4).toString('hex')}`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));   // yarim yazilmis bir dosya okunmasin
  }

  /** Dosya var ama cozulemiyorsa firlatir (gizli anahtar degismis olabilir). */
  connection() {
    const p = join(this.dir, 'connection.json');
    if (!existsSync(p)) return null;
    try { return cleanTarget(JSON.parse(unseal(this.key, JSON.parse(readFileSync(p, 'utf8'))))); }
    catch { throw new Error(`Bağlantı dosyası çözülemedi (gizli anahtar değişmiş olabilir): ${p}`); }
  }

  writeConnection(c) { this.#write('connection.json', JSON.stringify(seal(this.key, JSON.stringify(cleanTarget(c))))); }
  deleteConnection() { rmSync(join(this.dir, 'connection.json'), { force: true }); }

  status() {
    try {
      const v = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8'));
      return v && STAGES.includes(v.durum) ? v : null;
    } catch { return null; }
  }
  stage() { return this.status()?.durum ?? null; }

  /**
   * Asamayi ilerletir; hedef, isteyen gibi onceki alanlar korunur. Aciklama verilmezse oncekisi kalir. "basarisiz"da baglanti
   * dosyasi SILINIR: icinde parola var ve bir daha okunmayacak.
   */
  writeStage(stage, description = null, extra = {}) {
    if (!STAGES.includes(stage)) throw new Error(`Bilinmeyen aşama: ${stage}`);
    const previous = REQUESTS.includes(stage) ? {} : (this.status() ?? {});
    const v = { ...previous, ...extra, durum: stage, aciklama: description ?? previous.aciklama, zaman: new Date().toISOString() };
    for (const k of Object.keys(v)) if (v[k] === null || v[k] === undefined) delete v[k];
    this.#write('state.json', JSON.stringify(v, null, 2));
    if (stage === 'basarisiz') this.deleteConnection();
  }
}

/** Tek baglanti (havuz degil): sinama ve kopya icin. Tarihler metin, buyuk sayilar kayipsiz. */
export const openConnection = (b) => mysql.createConnection({
  host: b.host, port: b.port, database: b.database, user: b.username, password: b.password, charset: 'utf8mb4',
  connectTimeout: 5000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z', multipleStatements: false,
});

const cleanMessage = (e) => String(e?.message ?? e).replace(/^SQLSTATE\[[^\]]*\]\s*/, '').slice(0, 300);
const item = (name, ok, detail) => ({ name, ok, detail });
export const allOk = (items) => items.length > 0 && items.every((m) => m.ok);

async function scalar(c, sql, params = []) { const [[r]] = await c.query(sql, params); return Object.values(r)[0]; }
const CUSTOM_OBJECTS = `SELECT
    (SELECT COUNT(*) FROM information_schema.views WHERE table_schema = DATABASE())
  + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = DATABASE())
  + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE())
  + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = DATABASE()) AS n`;

/** Su anki veritabani (panelin acik havuzu uzerinden). */
export async function currentInfo(db, file) {
  const s = db.setting;
  const r = { source: file.stage() === 'etkin' ? 'panel' : 'ortam', host: s.host, port: String(s.port), database: s.database, username: s.username, version: null, size: null, tables: null, custom: null };
  try {
    r.version = String((await db.query('SELECT VERSION() AS v'))[0].v);
    const [t] = await db.query('SELECT COUNT(*) AS tables, COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables WHERE table_schema = DATABASE()');
    r.tables = Number(t.tables); r.size = Number(t.size);
    r.custom = Number((await db.query(CUSTOM_OBJECTS))[0].n);
  } catch { /* ekran yine acilir; degerler "bilinmiyor" */ }
  return r;
}

function versionItem(version) {
  const type = /mariadb/i.test(version) ? 'MariaDB' : 'MySQL';
  const m = version.match(/^\d+\.\d+(\.\d+)?/);
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
  const enough = !!m && cmp(m[0], MINIMUM[type]) >= 0;
  return item('Sürüm', enough, `${type} ${version}${enough ? '' : ` — en az ${type} ${MINIMUM[type]} gerekir.`}`);
}

/**
 * Goclerin ihtiyac duydugu isler kucuk bir tabloda denenir ve tablolar HER DURUMDA kaldirilir. Yetki sorulmaz, denenir: GRANT
 * ciktisini okumak MariaDB ile MySQL arasinda ayrisiyor.
 */
async function permissionItem(c) {
  const [b, a] = TEST_TABLES;
  let step = 'tablo açma';
  try {
    await c.query(`CREATE TABLE \`${a}\` (id INT UNSIGNED NOT NULL PRIMARY KEY, ad VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    step = 'yabancı anahtar';
    await c.query(`CREATE TABLE \`${b}\` (id INT UNSIGNED NOT NULL PRIMARY KEY, a_id INT UNSIGNED NOT NULL, CONSTRAINT \`${b}_fk\` FOREIGN KEY (a_id) REFERENCES \`${a}\` (id) ON DELETE CASCADE) ENGINE=InnoDB`);
    step = 'dizin'; await c.query(`CREATE INDEX \`${a}_ad\` ON \`${a}\` (ad)`);
    step = 'tablo değiştirme'; await c.query(`ALTER TABLE \`${a}\` ADD COLUMN ek INT NULL`);
    step = 'yazma'; await c.query(`INSERT INTO \`${a}\` (id, ad) VALUES (1, 'sınama')`); await c.query(`INSERT INTO \`${b}\` (id, a_id) VALUES (1, 1)`);
    step = 'güncelleme'; await c.query(`UPDATE \`${a}\` SET ek = 1 WHERE id = 1`);
    step = 'silme'; await c.query(`DELETE FROM \`${a}\` WHERE id = 1`);
    step = 'tablo kaldırma'; await c.query(`DROP TABLE \`${b}\`, \`${a}\``);
  } catch (e) {
    for (const t of TEST_TABLES) await c.query(`DROP TABLE IF EXISTS \`${t}\``).catch(() => {});
    return item('Yetki', false, `Göçlerin ihtiyacı olan "${step}" yapılamadı: ${cleanMessage(e)}`);
  }
  return item('Yetki', true, 'Tablo, dizin, yabancı anahtar, değişiklik, yazma ve silme denendi; sınama tabloları kaldırıldı.');
}

/** Baglanilacak hedef: dolu, bu panelin, bu surumden yeni degil, bu anahtarla doldurulmus. Yetki de sinanir. */
async function connectItems(c, tables, secret, local) {
  const hasMigrations = tables > 0 && Number(await scalar(c, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'migrations'")) > 0;
  const target = hasMigrations ? (await c.query('SELECT version FROM migrations'))[0].map((r) => Number(r.version)) : [];
  const diff = compareMigrations(target, local);
  const result = [item('Hedef bu panelin dolu veritabanı', diff.common > 0,
    tables === 0 ? 'Hedef boş: bağlanacak veri yok. Boş bir hedefe "Taşı" ile kopyalayın.'
      : !hasMigrations ? `${tables} tablo var ama göç kaydı (migrations) yok; bu panelin veritabanı değil.`
        : diff.common === 0 ? 'Göç kayıtları bu panele ait değil; başka bir uygulamanın veritabanı olabilir.'
          : `${tables} tablo; bu panelin ${diff.common} göçü kayıtlı.`)];
  if (diff.common === 0) return result;

  result.push(item('Hedef bu sürümden yeni değil', diff.unknown === 0, diff.unknown === 0
    ? (diff.pending > 0 ? `${diff.pending} göç açılışta hedefte uygulanacak.` : 'Şema bu sürümle aynı.')
    : `Hedefte bu sürümün bilmediği ${diff.unknown} göç var: daha yeni bir panel sürümüne ait. Önce bu paneli güncelleyin.`));

  // Anahtar: hedefi dolduran kurulumun gizli anahtari bu kurulumunkiyle ayni mi (ayarlardaki parmak izi). Ayni degilse cihaz
  // parolalari cozulemez ve panel acilista durur; sinamada soylemek, yeniden baslatip orada ogrenmekten iyidir.
  let saved;
  try { const [r] = await c.query("SELECT value FROM settings WHERE name = 'key-fingerprint'"); saved = r.length ? JSON.parse(r[0].value) : undefined; } catch { saved = undefined; }
  const same = saved === undefined || saved === keyFingerprint(secret);
  result.push(item('Gizli anahtar aynı', same, saved === undefined
    ? 'Hedefte anahtar parmak izi yok; açılışta bu kurulumun anahtarı yazılır.'
    : same ? 'Hedef bu kurulumun gizli anahtarıyla doldurulmuş.'
      : 'Hedef başka bir gizli anahtarla doldurulmuş: eski kurulumun CAM_SECRET_KEY değerini (ya da data/secret.key dosyasını) bu kuruluma verin.'));
  result.push(await permissionItem(c));
  return result;
}

/**
 * Tasimadan (ya da baglanmadan) onceki sinamalar. Sira onemli: baglanamayan hedefte sonrakiler denenmez.
 * current: currentInfo() sonucu; secret: panelin gizli anahtari; connect: testler sahtesini verir.
 */
export async function testTarget({ target, operation = 'tasi', current, secret, connect = openConnection, local = localMigrations() }) {
  const linking = operation === 'baglan';
  const result = [];
  const where = `${current.host}:${current.port}/${current.database}`;
  result.push(item('Panel kurulumun veritabanında', current.source === 'ortam', current.source === 'ortam'
    ? (linking ? `Şu anki veritabanı (${where}) bırakılacak; kopyalanmaz.` : `Kopya şu anki veritabanından (${where}) alınacak.`)
    : `Panel zaten bu sekmeden taşınmış bir veritabanında (${where}); ikinci kez taşınmaz.`));
  const same = target.host.toLowerCase() === String(current.host).toLowerCase() && String(target.port) === String(current.port) && target.database === current.database;
  result.push(item('Hedef başka bir veritabanı', !same, same ? 'Hedef, panelin şu anki veritabanının kendisi.' : 'Şu anki veritabanından farklı.'));
  if (!linking) {
    result.push(item('Şu anki veritabanında yalnızca tablo var', current.custom === 0,
      current.custom === 0 ? 'Görünüm, yordam, tetikleyici ya da zamanlanmış olay yok.'
        : current.custom === null ? 'Şu anki veritabanı okunamadı.'
          : `${current.custom} görünüm/yordam/tetikleyici/olay var; taşıma bunları kopyalamaz.`));
  }
  if (same) return result;

  let c;
  try { c = await connect(target); } catch (e) { result.push(item('Bağlantı', false, cleanMessage(e))); return result; }
  try {
    result.push(item('Bağlantı', true, address(target)));
    result.push(versionItem(String(await scalar(c, 'SELECT VERSION()'))));
    const tables = Number(await scalar(c, 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()'));
    if (linking) return [...result, ...await connectItems(c, tables, secret, local)];
    result.push(item('Hedef veritabanı boş', tables === 0, tables === 0 ? 'Tablo yok.' : `${tables} tablo var; dolu bir veritabanının üzerine yazılmaz.`));
    if (tables === 0) result.push(await permissionItem(c));
    return result;
  } finally { await c.end().catch(() => {}); }
}

/** Tablo basina kesin satir sayisi, ada gore sirali ("tablo sayi" satirlari); kopyadan sonra iki tarafin ciktisi BIREBIR ayni olmali. */
async function counts(c) {
  const [t] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  const names = t.map((r) => r.t ?? r.TABLE_NAME).sort();
  const out = [];
  for (const n of names) out.push(`${n} ${await scalar(c, 'SELECT COUNT(*) FROM ??', [n])}`);
  return out;
}

const BATCH = 200;

/**
 * Su anki veritabanini (source) bos hedefe (target) kopyalar: tablo tanimlari ve satirlar, sonra iki tarafta tablo/satir sayilari
 * karsilastirilir. Kaynaga yazilmaz. Dondurur: ozet; bir adim tutmazsa sebeple firlatir.
 */
export async function copyDatabase(source, target, { connect = openConnection, log = console.log } = {}) {
  const s = await connect(source), d = await connect(target);
  try {
    const custom = Number((await s.query(CUSTOM_OBJECTS))[0][0].n);
    if (custom !== 0) throw new Error(`Mevcut veritabanında görünüm, yordam, tetikleyici ya da zamanlanmış olay var (${custom}); bu taşıma onları kopyalamaz.`);
    const full = Number(await scalar(d, 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()'));
    if (full !== 0) throw new Error(`Uzak veritabanı boş değil (${full} tablo); üzerine yazılmaz.`);

    log('Taşıma: kopyalanıyor...');
    await d.query('SET FOREIGN_KEY_CHECKS = 0');
    const [t] = await s.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    for (const name of t.map((r) => r.t ?? r.TABLE_NAME)) {
      const [[def]] = await s.query('SHOW CREATE TABLE ??', [name]);
      await d.query(def['Create Table']);
      for (let offset = 0; ; offset += BATCH) {
        const [rows] = await s.query('SELECT * FROM ?? LIMIT ? OFFSET ?', [name, BATCH, offset]);
        if (!rows.length) break;
        const cols = Object.keys(rows[0]);
        await d.query('INSERT INTO ?? (??) VALUES ?', [name, cols, rows.map((r) => cols.map((k) => r[k]))]);
        if (rows.length < BATCH) break;
      }
    }
    await d.query('SET FOREIGN_KEY_CHECKS = 1');

    log('Taşıma: iki tarafta tablo ve satırlar sayılıyor...');
    const a = await counts(s), b = await counts(d);
    if (!a.length || a.join('\n') !== b.join('\n')) throw new Error('Kopya tutmadı: iki taraftaki tablo ya da satır sayıları farklı. Uzak veritabanını boşaltıp yeniden deneyin.');
    const rows = a.reduce((n, x) => n + Number(x.split(' ')[1]), 0);
    return `${a.length} tablo, ${rows} satır kopyalandı; iki tarafta sayılar aynı.`;
  } catch (e) {
    throw new Error(e.message.startsWith('Kopya tutmadı') || e.message.includes('üzerine yazılmaz') || e.message.includes('kopyalamaz') ? e.message : `Kopya yarıda kaldı: ${cleanMessage(e)} Uzak veritabanını boşaltıp yeniden deneyin.`);
  } finally { await s.end().catch(() => {}); await d.end().catch(() => {}); }
}

/** Baglanma: hedef acilis aninda hala dolu ve goc kaydi tasiyor mu (panel sinamisti; arada degismis olabilir). */
export async function checkConnect(target, { connect = openConnection } = {}) {
  let c;
  try { c = await connect(target); } catch (e) { throw new Error(`Hedef veritabanına (${target.host}:${target.port}) bağlanılamadı: ${cleanMessage(e)}`); }
  try {
    const n = Number(await scalar(c, 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()'));
    if (n === 0) throw new Error('Hedef veritabanı boş; bağlanacak veri yok. Boş hedefe Taşı ile kopyalayın.');
    let m;
    try { m = Number(await scalar(c, 'SELECT COUNT(*) FROM migrations')); } catch (e) { throw new Error(`Hedefte göç kaydı (migrations) okunamadı; bu panelin veritabanı değil: ${cleanMessage(e)}`); }
    return `Mevcut veritabanına bağlanıldı (${n} tablo, ${m} göç kaydı); kopya yapılmadı.`;
  } finally { await c.end().catch(() => {}); }
}

/**
 * ACILIS: istenen tasimayi/baglanmayi yapar ve panelin kullanacagi veritabani ayarini dondurur. Uygulamadan ONCE cagrilir.
 * Dondurur: { setting, stage } — stage "deneniyor" ise cagiran, uygulama acildiktan sonra "etkin" yazar (opened()), acilmazsa
 * "basarisiz" yazip cikar (failed()); bir sonraki acilis ortamin veritabaniyla gelir.
 */
export async function startupDatabase({ setting, file, log = console.log, warn = console.error, connect = openConnection }) {
  let stage = file.stage();
  if (stage === 'tasiniyor' || stage === 'deneniyor') {
    // Onceki acilis islemin ortasinda kapandi (elle durdurma, elektrik). Uzak veritabanina henuz yazilmadi; ortamin veritabaniyla
    // devam etmek veri kaybettirmez.
    warn('Önceki açılış veritabanı taşımasının ortasında kapanmış; ortamın veritabanıyla devam ediliyor.');
    file.writeStage('basarisiz', 'Önceki açılış taşımanın ortasında kapandı; panel ortamın veritabanıyla açıldı. Taşımada uzak veritabanını boşaltıp yeniden deneyin; bağlanmada hedefteki veriye dokunmadan yeniden deneyin.');
    stage = 'basarisiz';
  }

  const fail = (reason, what) => { warn(`${what}: ${reason}`); file.writeStage('basarisiz', reason); return 'basarisiz'; };
  const same = (t) => t.host === setting.host && String(t.port) === String(setting.port) && t.database === setting.database;

  if (stage === 'tasinacak' || stage === 'baglanacak') {
    const linking = stage === 'baglanacak';
    log(linking ? 'Mevcut veritabanına bağlanılıyor...' : 'Veritabanı uzak sunucuya taşınıyor...');
    let target = null;
    try { target = file.connection(); } catch { /* asagida */ }
    if (!target) stage = fail('Bağlantı dosyası okunamadı.', linking ? 'Bağlanılmadı' : 'Taşıma yapılmadı');
    else if (same(target)) stage = fail(`Hedef, panelin şu anki veritabanının kendisi (${setting.host}:${setting.port}/${setting.database}).`, linking ? 'Bağlanılmadı' : 'Taşıma yapılmadı');
    else {
      if (!linking) file.writeStage('tasiniyor');
      try {
        const summary = linking ? await checkConnect(target, { connect }) : await copyDatabase(setting, target, { connect, log });
        file.writeStage('deneniyor', summary);
        stage = 'deneniyor';
        log(`${linking ? 'Bağlanma' : 'Taşıma'}: ${summary}`);
      } catch (e) { stage = fail(e.message, linking ? 'Bağlanılmadı' : 'Taşıma yapılmadı'); }
    }
  }

  if (stage === 'deneniyor' || stage === 'etkin') {
    let c = null;
    try { c = file.connection(); } catch { /* asagida */ }
    if (!c) {
      // "etkin"de ortamin veritabanina DONULMEZ: tasima aninda donmustu.
      if (stage === 'etkin') throw new Error('Panel uzak veritabanında ama bağlantı dosyası okunamıyor (gizli anahtar değişmiş ya da dosya silinmiş olabilir). Ortamın veritabanı taşıma anındaki hâliyle duruyor; kendiliğinden ona dönülmez.');
      stage = fail('Bağlantı dosyası okunamadı.', 'Uzak veritabanı');
    } else {
      log(`Veritabanı: paneldeki ayar (${c.host}:${c.port}/${c.database}).`);
      return { setting: { ...setting, ...c }, stage };
    }
  }
  return { setting, stage };
}

/** Uygulama uzak veritabaniyla ilk kez acildi: islem tamam. */
export function opened(file, stage, log = console.log) {
  if (stage !== 'deneniyor') return;
  file.writeStage('etkin');
  log('Veritabanı geçişi tamamlandı: panel artık uzak veritabanında.');
}

/** Uzak veritabaniyla ilk acilis olmadi (gocler, anahtar...): ortamin veritabanina donulur; ona yazilmamisti. */
export function failed(file, stage, error) {
  if (stage !== 'deneniyor') return false;
  file.writeStage('basarisiz', `Uzak veritabanıyla ilk açılış başarısız (${cleanMessage(error)}); panel ortamın veritabanıyla açılacak. Taşımada uzak veritabanını boşaltıp yeniden deneyin; bağlanmada hedefteki veriye dokunmayın.`);
  return true;
}
