/**
 * Parcali MP4 (fMP4) okuma: ffmpeg'in "-c:v copy -movflags empty_moov+frag_keyframe" ciktisini kutulara ayirir.
 * Baslangic (ftyp+moov) bir kez gelir; sonra her parca moof+mdat. Canli yayin bunu izleyicilere dagitir (mp4-stream.mjs).
 * Kodek adi (RFC 6381) tarayicinin MediaSource.isTypeSupported sorusu icin baslangictan cikarilir.
 */

/** Kutu basliklari: [{ tur, bas, ic, son }] (ic: icerigin basladigi yer). Yarim kutu listeye girmez. */
export function kutular(b, bas = 0, son = b.length) {
  const liste = [];
  for (let i = bas; i + 8 <= son;) {
    let n = b.readUInt32BE(i), ic = i + 8;
    if (n === 1) { if (i + 16 > son) break; n = Number(b.readBigUInt64BE(i + 8)); ic = i + 16; }
    if (n < ic - i || i + n > son) break;
    liste.push({ tur: b.toString('latin1', i + 4, i + 8), bas: i, ic, son: i + n });
    i += n;
  }
  return liste;
}

/** Yol boyunca ilk eslesen kutu (ornek: ['moov','trak','mdia']); stsd'nin icinde 8 baytlik sayac atlanir. */
export function kutuBul(b, yol, bas = 0, son = b.length) {
  for (const k of kutular(b, bas, son)) {
    if (k.tur !== yol[0]) continue;
    if (yol.length === 1) return k;
    const r = kutuBul(b, yol.slice(1), k.ic + (k.tur === 'stsd' ? 8 : 0), k.son);
    if (r) return r;
  }
  return null;
}

const ORNEK = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'];
const VIDEO_ORNEK_ALAN = 78;   // VisualSampleEntry alanlari (kutu basligindan sonra); ardindan avcC/hvcC

/**
 * Baslangictan kodek adi: avc1.4d0029, hvc1.1.6.L120 gibi. Bilinmeyen kodekte null.
 * H.265 adi ISO/IEC 14496-15 Ek E: profil alani + profil, uyum bayraklari (bit sirasi ters), katman+seviye, kisit baytlari
 * (sondaki sifirlar yazilmaz; ffmpeg hlsenc ile ayni).
 */
export function kodekAdi(init) {
  const stsd = kutuBul(init, ORNEK);
  if (!stsd) return null;
  const ornek = kutular(init, stsd.ic + 8, stsd.son)[0];
  if (!ornek) return null;
  const ek = kutular(init, ornek.ic + VIDEO_ORNEK_ALAN, ornek.son);
  const avcC = ek.find((k) => k.tur === 'avcC'), hvcC = ek.find((k) => k.tur === 'hvcC');
  if (avcC) return `avc1.${init.subarray(avcC.ic + 1, avcC.ic + 4).toString('hex')}`;
  if (!hvcC) return null;
  const c = init.subarray(hvcC.ic, hvcC.son);
  const alan = ['', 'A', 'B', 'C'][c[1] >> 6], katman = c[1] & 0x20 ? 'H' : 'L', profil = c[1] & 0x1f;
  let uyum = c.readUInt32BE(2), ters = 0;
  for (let i = 0; i < 32; i++) { ters = (ters << 1) | (uyum & 1); uyum >>>= 1; }
  const kisit = [...c.subarray(6, 12)];
  while (kisit.length && !kisit.at(-1)) kisit.pop();
  return [`hvc1.${alan}${profil}`, (ters >>> 0).toString(16), `${katman}${c[12]}`, ...kisit.map((x) => x.toString(16).padStart(2, '0'))].join('.');
}

/**
 * hev1 -> hvc1 (yerinde). ffmpeg H.265'i hev1 diye yaziyor; Safari MP4'te yalniz hvc1 oynatir. Parametre kumeleri (VPS/SPS/PPS)
 * hvcC'de de var (olculdu: Uniview, 3 dizi), yani hvc1 kosulu saglaniyor.
 */
export function hvc1Yap(init) {
  const stsd = kutuBul(init, ORNEK);
  const ornek = stsd && kutular(init, stsd.ic + 8, stsd.son)[0];
  if (ornek?.tur === 'hev1') init.write('hvc1', ornek.bas + 4, 'latin1');
  return init;
}

/** Parcanin (moof) ilk ornegi anahtar kare mi: trun ilk ornek bayragi, yoksa tfhd varsayilani; "senkron degil" biti 0x10000. */
export function anahtarMi(moof) {
  const traf = kutuBul(moof, ['moof', 'traf']);
  if (!traf) return false;
  let varsayilan = null, ilk = null;
  for (const k of kutular(moof, traf.ic, traf.son)) {
    const bayrak = moof.readUIntBE(k.ic + 1, 3);
    if (k.tur === 'tfhd' && bayrak & 0x20) {
      let p = k.ic + 8;
      for (const [bit, uz] of [[1, 8], [2, 4], [8, 4], [0x10, 4]]) if (bayrak & bit) p += uz;
      varsayilan = moof.readUInt32BE(p);
    }
    if (k.tur === 'trun') {
      let p = k.ic + 8 + (bayrak & 1 ? 4 : 0);
      if (bayrak & 4) ilk = moof.readUInt32BE(p);
      else if (bayrak & 0x400) ilk = moof.readUInt32BE(p + (bayrak & 0x100 ? 4 : 0) + (bayrak & 0x200 ? 4 : 0));
    }
  }
  const b = ilk ?? varsayilan;
  return b !== null && !(b & 0x10000);
}

/**
 * Akis ayirici: ekle(veri) tamamlanan parcalari dondurur: { tur: 'init', veri } (ftyp+moov) ya da { tur: 'parca', veri, anahtar } (moof+mdat).
 * Baska kutular (free, styp, sidx) atlanir.
 */
export class Fmp4Ayirici {
  constructor() { this.tampon = Buffer.alloc(0); this.ftyp = null; this.moof = null; this.initVerildi = false; }

  ekle(veri) {
    this.tampon = this.tampon.length ? Buffer.concat([this.tampon, veri]) : veri;
    const cikti = [];
    let i = 0;
    for (const k of kutular(this.tampon)) {
      const kutu = Buffer.from(this.tampon.subarray(k.bas, k.son));
      i = k.son;
      if (k.tur === 'ftyp') this.ftyp = kutu;
      else if (k.tur === 'moov' && !this.initVerildi) { this.initVerildi = true; cikti.push({ tur: 'init', veri: Buffer.concat([this.ftyp ?? Buffer.alloc(0), kutu]) }); }
      else if (k.tur === 'moof') this.moof = kutu;
      else if (k.tur === 'mdat' && this.moof) { cikti.push({ tur: 'parca', veri: Buffer.concat([this.moof, kutu]), anahtar: anahtarMi(this.moof) }); this.moof = null; }
    }
    this.tampon = this.tampon.subarray(i);
    return cikti;
  }
}
