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
export function bolmeyeIn(serit, derinlik) {
  if (!serit) return;
  requestAnimationFrame(() => {
    const bolmeler = [...serit.querySelectorAll(':scope > .column, :scope > .detail')].filter((b) => getComputedStyle(b).display !== 'none');
    const hedef = bolmeler[Math.max(0, Math.min(derinlik, bolmeler.length - 1))];
    if (!hedef || serit.scrollWidth <= serit.clientWidth) return;
    serit.scrollTo({ left: hedef.offsetLeft - serit.offsetLeft, behavior: 'auto' });
  });
}
