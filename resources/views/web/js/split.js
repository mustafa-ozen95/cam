/**
 * Dar ekranda sutun seridinde DOGRU BOLMEYE inmek — EYS columns.js'teki kural, kamera durumundan okunur.
 *
 * EYS derinligi adresten (?grup, ?kayit) okur; kamera panelinde secim adreste degil, sayfa durumunda:
 *   derinlik 0: hicbir sey secili degil      -> ilk bolme (liste)
 *   derinlik 1: kanal / cihaz secili         -> orta bolme
 *   derinlik 2: oge odakta (kamera, kayit)   -> detay bolmesi
 * Gorunmeyen bolmeler (gizli detay) sayilmaz. Genis ekranda serit tasmaz ve hicbir sey yapilmaz;
 * kullanicinin kendi kaydirmasina karisilmaz, yalniz secim degisince cagrilir.
 */
export function toSplitIn(bar, depth) {
  if (!bar) return;
  requestAnimationFrame(() => {
    const splits = [...bar.querySelectorAll(':scope > .column, :scope > .detail')].filter((b) => getComputedStyle(b).display !== 'none');
    const target = splits[Math.max(0, Math.min(depth, splits.length - 1))];
    if (!target || bar.scrollWidth <= bar.clientWidth) return;
    bar.scrollTo({ left: target.offsetLeft - bar.offsetLeft, behavior: 'auto' });
  });
}
