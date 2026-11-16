/**
 * Onyukleme (Laravel bootstrap/app.php karsiligi): hizmetleri kurar, denetleyicileri baglar, rotalari yukler, uygulamayi dondurur.
 * Giris noktasi bin/cam.mjs; testler de buradan uygulama kurar (gercek cihaz yerine sahte surucuyle).
 */
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { App } from './core/app.mjs';
import { Database } from './core/database.mjs';
import { Settings } from './core/tables.mjs';
import { keyFingerprint, resolveSecretKey } from './core/secret-key.mjs';
import { headers, csrf } from './middleware/security.mjs';
import { setupIdentity } from './middleware/identity.mjs';
import { Membership } from './models/member.mjs';
import { PermissionStore } from './models/permission.mjs';
import { DeviceService } from './services/devices.mjs';
import { LiveService } from './services/live.mjs';
import { LivePageStore } from './models/live-page.mjs';
import { AuditLog } from './services/audit-log.mjs';
import { UpdateService } from './services/updates.mjs';
import { AlertService } from './services/alerts.mjs';
import { ConnectionFile } from './services/database-move.mjs';
import { HubLinks, HubClient } from './services/hub.mjs';
import { hubController } from './controllers/hub.mjs';
import { loginController } from './controllers/login.mjs';
import { membersController } from './controllers/members.mjs';
import { devicesController } from './controllers/devices.mjs';
import { streamController } from './controllers/streams.mjs';
import { permissionController } from './controllers/permissions.mjs';
import { auditLogController } from './controllers/audit-log.mjs';
import { updateController } from './controllers/updates.mjs';
import { alertsController } from './controllers/alerts.mjs';
import { databaseController } from './controllers/database.mjs';
import { viewController } from './controllers/views.mjs';
import { liveController } from './controllers/live.mjs';
import { livePagesController } from './controllers/live-pages.mjs';
import { webRoutes, liveRoutes } from '../routes/web.mjs';
import { apiRoutes } from '../routes/api.mjs';
import { apiV1Routes } from '../routes/api-v1.mjs';

/** Panelin gizli anahtari (data/secret.key ya da CAM_SECRET_KEY); acilis veritabani adimi da ister (bkz. bin/cam.mjs). */
export function panelSecret(config) {
  mkdirSync(config.dataDir, { recursive: true });
  return resolveSecretKey({ env: config.secretKey, file: join(config.dataDir, 'secret.key') });
}

/** Veritabani sekmesinin dosyalari (data/database): uzak baglanti ve tasima/baglanma asamasi. */
export const databaseFile = (config, secret) => new ConnectionFile(join(config.dataDir, 'database'), secret);

/**
 * extra.databaseMove: { restart, connect } — testler sureci kapatmayan restart ve sahte baglanti verir. Varsayilan restart sureci
 * SIGTERM ile bitirir; konteyner (restart: unless-stopped) yeniden kalkar, acilis istenen islemi yapar.
 */
export async function createApp(config, extra = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  // veritabani: gelene kadar bekler (gocleri createAppWithDb kosturur)
  const db = await new Database(config.database).connect({ waitingSec: config.database.waitingSec });
  try { return await createAppWithDb(config, db, extra); } catch (e) { await db.close(); throw e; }
}

/**
 * cam-ai ortak sirri: CAM_AI_SECRET verilmediyse ve paylasilan dosya yolu (CAM_AI_SECRET_FILE) tanimliysa oradan okunur,
 * yoksa uretilip yazilir (cam-ai ayni dosyayi salt okur). Kurulumda elle ayar gerekmez; algilama yine varsayilan KAPALI.
 */
export function withAiSecret(config) {
  const { secret, secretFile } = config.ai ?? {};
  if (secret || !secretFile) return config;
  try {
    let s = existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : '';
    if (!/^[0-9a-f]{64}$/.test(s)) {
      s = randomBytes(32).toString('hex');
      mkdirSync(dirname(secretFile), { recursive: true });
      writeFileSync(secretFile, s + '\n', { mode: 0o644 });   // yalniz bu iki konteynerin gordugu hacim; cam-ai baska kullanici
    }
    return { ...config, ai: { ...config.ai, secret: s } };
  } catch (e) {
    console.error(`Görüntü analizi ortak sırrı yazılamadı (${secretFile}): ${e.message}`);
    return config;
  }
}

async function createAppWithDb(config, db, extra) {
  config = withAiSecret(config);
  const secret = panelSecret(config);
  await db.runMigrations({ secret });   // gizli anahtara bagli kayitli veriyi tasiyan gocler (surum 3) anahtari ister
  const settings = new Settings(db);
  // Bu veritabani baska bir anahtarla dolduysa acilis durur: yanlis anahtarla cihaz parolalari cozulemez, oturumlar ve gunluk imzalari tutmaz.
  const fingerprint = keyFingerprint(secret), savedFingerprint = await settings.read('key-fingerprint');
  if (savedFingerprint !== undefined && savedFingerprint !== fingerprint) throw new Error('Gizli anahtar bu veritabanını dolduran anahtarla aynı değil (CAM_SECRET_KEY ya da data/secret.key). Doğru anahtarı verin; anahtar kaybolduysa kayıtlı cihaz parolaları yeniden girilmelidir.');
  if (savedFingerprint === undefined) await settings.write('key-fingerprint', fingerprint);
  // modeller (veritabanindan bellege)
  const members = await new Membership(db, secret).load();
  let livePages = null;   // rol silme denetimi icin (asagida yuklenir)
  const permissions = await new PermissionStore(db, members.secret, { roleInUse: (id) => members.roleInUse(id) || !!livePages?.roleInUse(id) }).load();
  members.roleValid = (r) => permissions.roleVar(r);
  if (members.empty()) {
    const password = config.permissions.initialAdminPassword || randomBytes(9).toString('base64url');
    await members.add('admin', password, 'admin');
    if (!config.permissions.initialAdminPassword) { writeFileSync(join(config.dataDir, 'initial-admin.txt'), `Kullanıcı adı: admin\nParola: ${password}\n\nGiriş yaptıktan sonra Üyeler sekmesinden parolayı değiştirin ve bu dosyayı silin.\n`, { mode: 0o600 }); console.log('İlk admin hesabı oluşturuldu: data/initial-admin.txt'); }
  }
  // hizmetler
  const devices = new DeviceService({ config, secret: members.secret, db, settings });
  await devices.saveMock();
  await devices.start();
  const auditLog = await new AuditLog(db, (m) => members.signature(m), config.server.trustedIpHeader).load();
  devices.group.event = (event, detail) => auditLog.write(event, 'system', null, detail);
  // Kimlik Yonetim Merkezi: istemci (OAuth akisi) ve baglar (merkezdeki kimlik -> buradaki uye). Yapilandirilmamissa akis kapali, baglar bos.
  const hub = new HubClient(config.identity);
  const links = await new HubLinks(db, { hub, members, auditLog, config }).load();
  livePages = await new LivePageStore(db, { roleValid: (r) => permissions.roleVar(r) }).load();
  const live = new LiveService({ config, devices, livePages });
  const updates = await new UpdateService({ settings, setting: config.updates }).load();
  const alerts = await new AlertService({ db, settings, secret, devices, config }).load();
  const databaseMove = { file: databaseFile(config, secret), secret, restart: () => process.kill(process.pid, 'SIGTERM'), ...extra.databaseMove };
  const services = { db, members, permissions, devices, auditLog, config, hub, links, live, livePages, updates, alerts, databaseMove };

  // denetleyiciler + ara katmanlar
  const view = viewController(services);
  const d = {
    login: loginController(services), members: membersController(services), devices: devicesController(services),
    stream: streamController(services), permissions: permissionController(services), auditLog: auditLogController(services), view,
    hub: hubController(services), live: liveController({ ...services, view }), livePages: livePagesController(services), updates: updateController(services),
    database: databaseController(services), alerts: alertsController(services),
  };
  const middleware = setupIdentity(services);

  const app = new App({ config, services });
  app.use(headers).use(csrf);
  webRoutes(app.router, d, middleware);
  apiRoutes(app.router, d, middleware);
  apiV1Routes(app.router, d, middleware, services);
  // Canli sayfalar EN SON: statik rotalarin ilk segmentleri yol olarak kullanilamaz (ileride eklenen rota da kendiliginden rezerve).
  for (const r of app.router.list()) { const first = r.pattern.split('/')[1]; if (first && !first.startsWith(':')) livePages.reserved.add(first); }
  liveRoutes(app.router, d, middleware, services);
  live.start();
  updates.start();
  // Kapanis: bekleyen gunluk yazimlari ve ertelenmis yetki yazimi veritabanina islenir, sonra havuz kapanir.
  app.close = async () => { updates.close(); alerts.close(); live.close(); devices.close(); await permissions.close(); await auditLog.wait(); await db.close(); };
  return app;
}
