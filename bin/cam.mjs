#!/usr/bin/env node
/** Giris noktasi: `npm start` / `node bin/cam.mjs`. */
import { config } from '../config/app.mjs';
import { createApp } from '../src/bootstrap.mjs';

let app;
try { app = await createApp(config); }
catch (e) { console.error(`Panel açılamadı: ${e.message}`); process.exit(1); }
app.listen();
console.log(`devices: ${app.services.devices.list().map((c) => `${c.type}@${c.host}`).join(', ') || 'none'}`);
app.services.devices.info().catch(() => {});    // acilista kanal bilgisini isit
const exit = async () => { try { await app.close(); } catch (e) { console.error('kapanista hata:', e.message); } process.exit(0); };
process.on('SIGINT', exit); process.on('SIGTERM', exit);
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e?.message ?? e));
