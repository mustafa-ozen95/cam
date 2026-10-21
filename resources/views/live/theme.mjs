// Gece/gunduz YALNIZ admin icin: herkese acik /live hep gece (index.html data-theme="dark"). Panelin tema betigi.
// Admin dogrulaninca (live.js: html[data-admin] + 'live-admin' olayi) panelin tema betigi devreye girer; secim panelle ortak
// (dc-tema cerezi). Modul ile klasik betigin sirasi belirsiz: ikisi de yoklanir.
import * as tema from '/js/eys/components/theme.js';
let acik = false;
const ac = () => { if (!acik) { acik = true; tema.init(); } };
if (document.documentElement.dataset.admin === '1') ac();
else document.addEventListener('live-admin', ac, { once: true });
