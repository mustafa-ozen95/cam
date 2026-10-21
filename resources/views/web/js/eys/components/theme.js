import { on } from '../lib/dom.js';

/**
 * Açık/koyu tema. Yalnızca kök öğedeki data-theme değerini değiştirir; hangi
 * rengin ne olacağı CSS token katmanının işidir.
 *
 * SEÇİM ÇEREZDE, localStorage'da DEĞİL.
 *
 * localStorage adres başınadır: merkez (merkez.ornek.test) ile paneller
 * (panel-a…, panel-b…) ayrı köklerdir ve birbirlerinin seçimini göremezler;
 * merkezde gündüz temasına geçip panele gelen kişi paneli gece temasında
 * bulurdu. Çerez ÜST ALAN ADINA yazılınca (".ornek.test") hepsi aynı
 * seçimi okur ve değişiklik hangi ekranda yapılırsa yapılsın hepsinde
 * geçerli olur.
 *
 * Alan adı sunucudan gelir (bkz. config/tema.php). Boşsa çerez yalnızca bu
 * konağa yazılır: paneller ayrı alan adlarında duruyorsa paylaşacak bir üst
 * alan yoktur ve tahmin etmeye çalışmak, tarayıcının çerezi sessizce
 * reddetmesiyle biterdi.
 *
 * VARSAYILAN "AUTO": seçim yapılmadıysa tarayıcının kendi tercihi izlenir ve
 * o tercih değişirse anında takip edilir. Sabit bir varsayılan, cihazını
 * gündüz moduna almış birine paneli gece modunda gösterirdi.
 */
const COOKIE = 'dc-tema';

/** Çerez ömrü: bir yıl. Tema tercihidir, oturumla birlikte unutulmamalı. */
const OMUR = 60 * 60 * 24 * 365;

const isik = () => window.matchMedia('(prefers-color-scheme: light)');

function alanAdi() {
    return document.querySelector('meta[name="tema-alan"]')?.content?.trim() ?? '';
}

function oku() {
    const eslesme = document.cookie.match(/(?:^|;\s*)dc-tema=(light|dark)(?:;|$)/);

    return eslesme ? eslesme[1] : null;
}

function yaz(tema) {
    const alan = alanAdi();
    const guvenli = window.location.protocol === 'https:' ? '; Secure' : '';

    document.cookie = `${COOKIE}=${tema}; Path=/; Max-Age=${OMUR}; SameSite=Lax${guvenli}`
        + (alan === '' ? '' : `; Domain=${alan}`);
}

function uygula(tema) {
    document.documentElement.dataset.theme = tema;
}

/** Seçim yoksa tarayıcının tercihi. */
function tarayicininTercihi() {
    return isik().matches ? 'light' : 'dark';
}

export function preferred() {
    return oku() ?? tarayicininTercihi();
}

export function init() {
    uygula(preferred());

    /*
     * Tarayıcı tercihi değişirse ANINDA takip edilir — ama yalnızca kullanıcı
     * kendi seçimini yapmadıysa. Yapmışsa onun seçimi geçerlidir; sistem
     * karanlık moda geçti diye kullanıcının açık tema tercihini ezmek, seçimi
     * anlamsız kılardı.
     */
    isik().addEventListener('change', () => {
        if (oku() === null) {
            uygula(tarayicininTercihi());
        }
    });

    /*
     * Delegasyon: düğme sayfa geçişinde yenilenen düğümler arasında.
     * Doğrudan bağlansaydı ilk geçişten sonra tema düğmesi ölürdü.
     */
    on('click', '[data-theme-toggle]', () => {
        const yeni = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

        yaz(yeni);
        uygula(yeni);
    });
}
