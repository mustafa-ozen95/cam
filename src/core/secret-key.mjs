/**
 * Panelin gizli anahtari (32 bayt): oturum cerezlerini, gunluk zincirini ve cihaz parolalarinin sifrelemesini besler.
 * VERITABANINA GIRMEZ (dokum, sifreli cihaz parolalariyla ayni yerde olmasin).
 *  1) KAMERA_GIZLI_ANAHTAR ortam degiskeni (base64, 32 bayt)
 *  2) bos ise data/secret.key dosyasi (yoksa uretilir, 0600)
 * Ortamdan gelen anahtar dosyadakinden FARKLIYSA acilis durur: yanlis anahtarla kayitli cihaz parolalari cozulemez.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function gizliAnahtarCoz({ ortam = '', dosya }) {
  // Eski ad (gizli.anahtar): yeni ad yoksa dosya yerinde yeniden adlandirilir (icerik ayni, anahtar degismez).
  const eskiAd = join(dirname(dosya), 'gizli.anahtar');
  if (basename(dosya) === 'secret.key' && !existsSync(dosya) && existsSync(eskiAd)) renameSync(eskiAd, dosya);
  const metin = String(ortam ?? '').trim();
  const dosyadaki = existsSync(dosya) ? readFileSync(dosya) : null;
  if (!metin) {
    if (dosyadaki) return dosyadaki;
    const yeni = randomBytes(32); writeFileSync(dosya, yeni, { mode: 0o600 }); return yeni;
  }
  const anahtar = Buffer.from(metin, 'base64');
  if (anahtar.length !== 32 || anahtar.toString('base64').replace(/=+$/, '') !== metin.replace(/=+$/, '')) {
    throw new Error('KAMERA_GIZLI_ANAHTAR geçersiz: base64 kodlu 32 bayt olmalı (üretmek için: openssl rand -base64 32)');
  }
  if (dosyadaki && (dosyadaki.length !== 32 || !timingSafeEqual(dosyadaki, anahtar))) {
    throw new Error('KAMERA_GIZLI_ANAHTAR data/secret.key dosyasındakinden farklı: yanlış anahtarla kayıtlı cihaz parolaları çözülemez ve oturumlar düşer. Doğru anahtarı verin ya da (yeni kurulumsa) dosyayı kaldırın.');
  }
  return anahtar;
}

/** Anahtarin parmak izi (anahtari ele vermez): veritabaninda saklanir, sonraki acilista ayni anahtar mi diye bakilir. */
export const anahtarIzi = (anahtar) => createHmac('sha256', anahtar).update('cam/anahtar-izi').digest('hex');
