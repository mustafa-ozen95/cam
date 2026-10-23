#!/usr/bin/env node
/** Giris noktasi: `npm start` / `node bin/cam.mjs`. */
import { config } from '../config/app.mjs';
import { createApp, databaseFile, panelSecret } from '../src/bootstrap.mjs';
import { failed, opened, startupDatabase } from '../src/services/database-move.mjs';

// Veritabani sekmesinden istenen tasima/baglanma uygulama kurulmadan ONCE yapilir (kopya alinirken kimse yazmasin); panel uzak
// veritabanindaysa baglanti oradan gelir ve ortamin DB_* ayarlarini ezer (bkz. services/database-move.mjs).
let app, file, stage, settings = config;   // config donmus (Object.freeze); veritabani ayari kopyada degisir
try {
  file = databaseFile(config, panelSecret(config));
  const r = await startupDatabase({ setting: config.database, file });
  settings = { ...config, database: r.setting }; stage = r.stage;
} catch (e) { console.error(`Panel açılamadı: ${e.message}`); process.exit(1); }

try { app = await createApp(settings); }
catch (e) {
  console.error(`Panel açılamadı: ${e.message}`);
  // Uzak veritabaniyla ilk acilis olmadiysa ortamin veritabanina donulur (ona yazilmamisti); cikis kodu yeniden baslatmayi tetikler.
  if (failed(file, stage, e)) console.error('Uzak veritabanıyla ilk açılış başarısız; panel ortamın veritabanıyla yeniden açılacak.');
  process.exit(1);
}
opened(file, stage);
app.listen();
console.log(`devices: ${app.services.devices.list().map((c) => `${c.type}@${c.host}`).join(', ') || 'none'}`);
app.services.devices.info().catch(() => {});    // acilista kanal bilgisini isit
const exit = async () => { try { await app.close(); } catch (e) { console.error('kapanista hata:', e.message); } process.exit(0); };
process.on('SIGINT', exit); process.on('SIGTERM', exit);
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e?.message ?? e));
