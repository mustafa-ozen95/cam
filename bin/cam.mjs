#!/usr/bin/env node
/** Giris noktasi: `npm start` / `node bin/cam.mjs`. */
import { yapilandirma } from '../config/app.mjs';
import { uygulamaKur } from '../src/bootstrap.mjs';

let uygulama;
try { uygulama = await uygulamaKur(yapilandirma); }
catch (e) { console.error(`Panel açılamadı: ${e.message}`); process.exit(1); }
uygulama.dinle();
console.log(`cihazlar: ${uygulama.hizmetler.cihazlar.liste().map((c) => `${c.tur}@${c.ana}`).join(', ') || 'yok'}`);
uygulama.hizmetler.cihazlar.bilgi().catch(() => {});    // acilista kanal bilgisini isit
const cik = async () => { try { await uygulama.kapat(); } catch (e) { console.error('kapanista hata:', e.message); } process.exit(0); };
process.on('SIGINT', cik); process.on('SIGTERM', cik);
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e?.message ?? e));
