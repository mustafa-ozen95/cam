/**
 * Parcali MP4 (fMP4) okuma: ffmpeg'in "-c:v copy -movflags empty_moov+frag_keyframe" ciktisini kutulara ayirir.
 * Baslangic (ftyp+moov) bir kez gelir; sonra her parca moof+mdat. Canli yayin bunu izleyicilere dagitir (mp4-stream.mjs).
 * Kodek adi (RFC 6381) tarayicinin MediaSource.isTypeSupported sorusu icin baslangictan cikarilir.
 */

/** Kutu basliklari: [{ tur, bas, ic, son }] (ic: icerigin basladigi yer). Yarim kutu listeye girmez. */
export function boxes(b, from = 0, last = b.length) {
  const list = [];
  for (let i = from; i + 8 <= last;) {
    let n = b.readUInt32BE(i), inner = i + 8;
    if (n === 1) { if (i + 16 > last) break; n = Number(b.readBigUInt64BE(i + 8)); inner = i + 16; }
    if (n < inner - i || i + n > last) break;
    list.push({ type: b.toString('latin1', i + 4, i + 8), from: i, inner, last: i + n });
    i += n;
  }
  return list;
}

/** Yol boyunca ilk eslesen kutu (ornek: ['moov','trak','mdia']); stsd'nin icinde 8 baytlik sayac atlanir. */
export function findBox(b, path, from = 0, last = b.length) {
  for (const k of boxes(b, from, last)) {
    if (k.type !== path[0]) continue;
    if (path.length === 1) return k;
    const r = findBox(b, path.slice(1), k.inner + (k.type === 'stsd' ? 8 : 0), k.last);
    if (r) return r;
  }
  return null;
}

const EXAMPLE = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'];
const VIDEO_EXAMPLE_FIELD = 78;   // VisualSampleEntry alanlari (kutu basligindan sonra); ardindan avcC/hvcC

/**
 * Baslangictan kodek adi: avc1.4d0029, hvc1.1.6.L120 gibi. Bilinmeyen kodekte null.
 * H.265 adi ISO/IEC 14496-15 Ek E: profil alani + profil, uyum bayraklari (bit sirasi ters), katman+seviye, kisit baytlari
 * (sondaki sifirlar yazilmaz; ffmpeg hlsenc ile ayni).
 */
export function codecName(init) {
  const stsd = findBox(init, EXAMPLE);
  if (!stsd) return null;
  const example = boxes(init, stsd.inner + 8, stsd.last)[0];
  if (!example) return null;
  const extra = boxes(init, example.inner + VIDEO_EXAMPLE_FIELD, example.last);
  const avcC = extra.find((k) => k.type === 'avcC'), hvcC = extra.find((k) => k.type === 'hvcC');
  if (avcC) return `avc1.${init.subarray(avcC.inner + 1, avcC.inner + 4).toString('hex')}`;
  if (!hvcC) return null;
  const c = init.subarray(hvcC.inner, hvcC.last);
  const field = ['', 'A', 'B', 'C'][c[1] >> 6], layer = c[1] & 0x20 ? 'H' : 'L', profile = c[1] & 0x1f;
  let compat = c.readUInt32BE(2), reverse = 0;
  for (let i = 0; i < 32; i++) { reverse = (reverse << 1) | (compat & 1); compat >>>= 1; }
  const limit = [...c.subarray(6, 12)];
  while (limit.length && !limit.at(-1)) limit.pop();
  return [`hvc1.${field}${profile}`, (reverse >>> 0).toString(16), `${layer}${c[12]}`, ...limit.map((x) => x.toString(16).padStart(2, '0'))].join('.');
}

/**
 * hev1 -> hvc1 (yerinde). ffmpeg H.265'i hev1 diye yaziyor; Safari MP4'te yalniz hvc1 oynatir. Parametre kumeleri (VPS/SPS/PPS)
 * hvcC'de de var (olculdu: Uniview, 3 dizi), yani hvc1 kosulu saglaniyor.
 */
export function makeHvc1(init) {
  const stsd = findBox(init, EXAMPLE);
  const example = stsd && boxes(init, stsd.inner + 8, stsd.last)[0];
  if (example?.type === 'hev1') init.write('hvc1', example.from + 4, 'latin1');
  return init;
}

/** Parcanin (moof) ilk ornegi anahtar kare mi: trun ilk ornek bayragi, yoksa tfhd varsayilani; "senkron degil" biti 0x10000. */
export function isKey(moof) {
  const traf = findBox(moof, ['moof', 'traf']);
  if (!traf) return false;
  let defaultValue = null, first = null;
  for (const k of boxes(moof, traf.inner, traf.last)) {
    const flag = moof.readUIntBE(k.inner + 1, 3);
    if (k.type === 'tfhd' && flag & 0x20) {
      let p = k.inner + 8;
      for (const [to, uz] of [[1, 8], [2, 4], [8, 4], [0x10, 4]]) if (flag & to) p += uz;
      defaultValue = moof.readUInt32BE(p);
    }
    if (k.type === 'trun') {
      let p = k.inner + 8 + (flag & 1 ? 4 : 0);
      if (flag & 4) first = moof.readUInt32BE(p);
      else if (flag & 0x400) first = moof.readUInt32BE(p + (flag & 0x100 ? 4 : 0) + (flag & 0x200 ? 4 : 0));
    }
  }
  const b = first ?? defaultValue;
  return b !== null && !(b & 0x10000);
}

/**
 * Akis ayirici: ekle(veri) tamamlanan parcalari dondurur: { type: 'init', data } (ftyp+moov) ya da { type: 'chunk', data, key } (moof+mdat).
 * Baska kutular (free, styp, sidx) atlanir.
 */
export class Fmp4Splitter {
  constructor() { this.buffer = Buffer.alloc(0); this.ftyp = null; this.moof = null; this.initGiven = false; }

  add(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const output = [];
    let i = 0;
    for (const k of boxes(this.buffer)) {
      const box = Buffer.from(this.buffer.subarray(k.from, k.last));
      i = k.last;
      if (k.type === 'ftyp') this.ftyp = box;
      else if (k.type === 'moov' && !this.initGiven) { this.initGiven = true; output.push({ type: 'init', data: Buffer.concat([this.ftyp ?? Buffer.alloc(0), box]) }); }
      else if (k.type === 'moof') this.moof = box;
      else if (k.type === 'mdat' && this.moof) { output.push({ type: 'chunk', data: Buffer.concat([this.moof, box]), key: isKey(this.moof) }); this.moof = null; }
    }
    this.buffer = this.buffer.subarray(i);
    return output;
  }
}
