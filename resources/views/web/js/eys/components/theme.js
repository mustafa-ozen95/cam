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
 * Alan adı sunucudan gelir (bkz. config/theme.php). Boşsa çerez yalnızca bu
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
const LIFETIME = 60 * 60 * 24 * 365;

const light = () => window.matchMedia('(prefers-color-scheme: light)');

function fieldName() {
    return document.querySelector('meta[name="theme-domain"]')?.content?.trim() ?? '';
}

function read() {
    const matched = document.cookie.match(/(?:^|;\s*)dc-tema=(light|dark)(?:;|$)/);

    return matched ? matched[1] : null;
}

function write(theme) {
    const field = fieldName();
    const safe = window.location.protocol === 'https:' ? '; Secure' : '';

    document.cookie = `${COOKIE}=${theme}; Path=/; Max-Age=${LIFETIME}; SameSite=Lax${safe}`
        + (field === '' ? '' : `; Domain=${field}`);
}

function apply(theme) {
    document.documentElement.dataset.theme = theme;
}

/** Seçim yoksa tarayıcının tercihi. */
function browserPreference() {
    return light().matches ? 'light' : 'dark';
}

export function preferred() {
    return read() ?? browserPreference();
}

export function init() {
    apply(preferred());

    /*
     * Tarayıcı tercihi değişirse ANINDA takip edilir — ama yalnızca kullanıcı
     * kendi seçimini yapmadıysa. Yapmışsa onun seçimi geçerlidir; sistem
     * karanlık moda geçti diye kullanıcının açık tema tercihini ezmek, seçimi
     * anlamsız kılardı.
     */
    light().addEventListener('change', () => {
        if (read() === null) {
            apply(browserPreference());
        }
    });

    /*
     * Delegasyon: düğme sayfa geçişinde yenilenen düğümler arasında.
     * Doğrudan bağlansaydı ilk geçişten sonra tema düğmesi ölürdü.
     */
    on('click', '[data-theme-toggle]', () => {
        const fresh = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

        write(fresh);
        apply(fresh);
    });
}
