/**
 * Panelin gizli anahtari (32 bayt): oturum cerezlerini, gunluk zincirini ve cihaz parolalarinin sifrelemesini besler.
 * VERITABANINA GIRMEZ (dokum, sifreli cihaz parolalariyla ayni yerde olmasin).
 *  1) CAM_SECRET_KEY ortam degiskeni (base64, 32 bayt)
 *  2) bos ise data/secret.key dosyasi (yoksa uretilir, 0600)
 * Ortamdan gelen anahtar dosyadakinden FARKLIYSA acilis durur: yanlis anahtarla kayitli cihaz parolalari cozulemez.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function resolveSecretKey({ env = '', file }) {
  // Eski ad (gizli.anahtar): yeni ad yoksa dosya yerinde yeniden adlandirilir (icerik ayni, anahtar degismez).
  const legacyName = join(dirname(file), 'gizli.anahtar');
  if (basename(file) === 'secret.key' && !existsSync(file) && existsSync(legacyName)) renameSync(legacyName, file);
  const text = String(env ?? '').trim();
  const fromFile = existsSync(file) ? readFileSync(file) : null;
  if (!text) {
    if (fromFile) return fromFile;
    const fresh = randomBytes(32); writeFileSync(file, fresh, { mode: 0o600 }); return fresh;
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new Error('CAM_SECRET_KEY geçersiz: base64 kodlu 32 bayt olmalı (üretmek için: openssl rand -base64 32)');
  }
  if (fromFile && (fromFile.length !== 32 || !timingSafeEqual(fromFile, key))) {
    throw new Error('CAM_SECRET_KEY data/secret.key dosyasındakinden farklı: yanlış anahtarla kayıtlı cihaz parolaları çözülemez ve oturumlar düşer. Doğru anahtarı verin ya da (yeni kurulumsa) dosyayı kaldırın.');
  }
  return key;
}

/** Anahtarin parmak izi (anahtari ele vermez): veritabaninda saklanir, sonraki acilista ayni anahtar mi diye bakilir. */
export const keyFingerprint = (key) => createHmac('sha256', key).update('cam/anahtar-izi').digest('hex');
