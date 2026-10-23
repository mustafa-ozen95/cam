/**
 * Onyukleme (Laravel bootstrap/app.php karsiligi): hizmetleri kurar, denetleyicileri baglar, rotalari yukler, uygulamayi dondurur.
 * Giris noktasi bin/cam.mjs; testler de buradan uygulama kurar (gercek cihaz yerine sahte surucuyle).
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { AuditLog } from './services/audit-log.mjs';
import { UpdateService } from './services/updates.mjs';
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
import { databaseController } from './controllers/database.mjs';
import { viewController } from './controllers/views.mjs';
import { liveController } from './controllers/live.mjs';
import { webRoutes } from '../routes/web.mjs';
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

async function createAppWithDb(config, db, extra) {
  const secret = panelSecret(config);
  await db.runMigrations({ secret });   // gizli anahtara bagli kayitli veriyi tasiyan gocler (surum 3) anahtari ister
  const settings = new Settings(db);
  // Bu veritabani baska bir anahtarla dolduysa acilis durur: yanlis anahtarla cihaz parolalari cozulemez, oturumlar ve gunluk imzalari tutmaz.
  const fingerprint = keyFingerprint(secret), savedFingerprint = await settings.read('key-fingerprint');
  if (savedFingerprint !== undefined && savedFingerprint !== fingerprint) throw new Error('Gizli anahtar bu veritabanını dolduran anahtarla aynı değil (CAM_SECRET_KEY ya da data/secret.key). Doğru anahtarı verin; anahtar kaybolduysa kayıtlı cihaz parolaları yeniden girilmelidir.');
  if (savedFingerprint === undefined) await settings.write('key-fingerprint', fingerprint);
  // modeller (veritabanindan bellege)
  const members = await new Membership(db, secret).load();
  const permissions = await new PermissionStore(db, members.secret, { roleInUse: (id) => members.roleInUse(id) }).load();
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
  const live = await new LiveService({ config, devices, settings }).load();
  const updates = await new UpdateService({ settings, setting: config.updates }).load();
  const databaseMove = { file: databaseFile(config, secret), secret, restart: () => process.kill(process.pid, 'SIGTERM'), ...extra.databaseMove };
  const services = { db, members, permissions, devices, auditLog, config, hub, links, live, updates, databaseMove };

  // denetleyiciler + ara katmanlar
  const d = {
    login: loginController(services), members: membersController(services), devices: devicesController(services),
    stream: streamController(services), permissions: permissionController(services), auditLog: auditLogController(services), view: viewController(services),
    hub: hubController(services), live: liveController(services), updates: updateController(services),
    database: databaseController(services),
  };
  const middleware = setupIdentity(services);

  const app = new App({ config, services });
  app.use(headers).use(csrf);
  webRoutes(app.router, d, middleware);
  apiRoutes(app.router, d, middleware);
  apiV1Routes(app.router, d, middleware, services);
  live.start();
  updates.start();
  // Kapanis: bekleyen gunluk yazimlari ve ertelenmis yetki yazimi veritabanina islenir, sonra havuz kapanir.
  app.close = async () => { updates.close(); live.close(); devices.close(); await permissions.close(); await auditLog.wait(); await db.close(); };
  return app;
}
