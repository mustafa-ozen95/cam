import { $, $$ } from '../lib/dom.js';

/**
 * Yatay kayan şeritlerde DOĞRU YERE bakmak.
 *
 * Dar ekranda sütunlar yan yana sığmaz; şerit yatay kayar ve her bölme
 * neredeyse tam ekran kaplar (bkz. layout.css, 820px altı). Şerit kendi
 * hâline bırakılırsa her çizimde en soldan başlar: telefonda bir gruba
 * dokunan kişi hâlâ grup listesine bakar, seçtiği kaydın detayı ekranın
 * dışında kalır.
 *
 * Kural TEK ve her ekranda aynıdır: kullanıcı ADRESTE nereye kadar indiyse o
 * bölme açılır.
 *
 *   - ?kayit= → detay bölmesi
 *   - ?grup=  → liste bölmesi
 *   - hiçbiri → gruplar bölmesi
 *
 * Çizilmiş bölmelere bakmak yetmiyordu: liste bölmesi bir grup SEÇİLMEDEN de
 * doluyor (ekran ilk grubu varsayılan sayıyor), dolayısıyla "en sağdaki
 * görünür bölme" kuralı bölüme ilk girişte kullanıcıyı seçmediği bir grubun
 * içine indiriyordu.
 *
 * Yalnızca çizimde çalışır; kullanıcının kendi kaydırmasına karışılmaz.
 * Geniş ekranda şerit zaten taşmaz ve hiçbir şey yapılmaz.
 */

/**
 * Kayan şeritte SEÇİLİ öğeyi görünür kılar.
 *
 * Üst menü dar ekranda taşıyor ve en soldan başlıyordu: kullanıcı hangi
 * bölümde olduğunu görmek için kaydırmak zorunda kalıyordu.
 */
function seciliyeOdaklan(serit) {
    const secili = $('[aria-current="page"]', serit);

    if (!secili || serit.scrollWidth <= serit.clientWidth) {
        return;
    }

    /* Seçili öğe ortalanır; iki yanındaki komşular da görünür kalır. */
    serit.scrollLeft = secili.offsetLeft - (serit.clientWidth - secili.offsetWidth) / 2;
}

/**
 * Şeridin görünür bölmeleri, soldan sağa.
 *
 * Görünmeyen bölmeler atlanır: detay paneli yalnızca bir kayıt seçiliyken
 * çizilir.
 */
function gorunurBolmeler(serit) {
    return $$(':scope > .column, :scope > .detail', serit)
        .filter((bolme) => getComputedStyle(bolme).display !== 'none');
}

/**
 * Kullanıcının İNDİĞİ bölme.
 *
 * "En sağdaki görünür bölme" kuralı bir şeyi atlıyordu: liste bölmesi bir
 * grup SEÇİLMEDEN de doluyor (ekran ilk grubu varsayılan sayıyor). Telefonda
 * bölüme ilk girişte kullanıcı doğrudan o grubun kayıtlarının içinde
 * buluyordu kendini; grup listesi soluna gizlenmişti ve panelin ilk ekranı
 * "nereye geldim" sorusunu sordurtuyordu.
 *
 * Derinlik ADRESTEN okunur, çizilmiş bölmelerden değil: kullanıcı yalnızca
 * kendi gittiği yere iner.
 *
 *   - ?kayit= → en derin bölme (detay)
 *   - ?grup=  → liste bölmesi
 *   - hiçbiri → en baştaki bölme (gruplar)
 */
function hedefBolme(serit) {
    const bolmeler = gorunurBolmeler(serit);

    if (bolmeler.length === 0) {
        return null;
    }

    /*
     * ŞERİT KENDİ KURALINI SÖYLEYEBİLİR.
     *
     * Aşağıdaki adres kuralı (?kayit / ?grup) seçimi sorgu parametresinde
     * taşıyan ekranlar içindir. Seçimin adresin KENDİSİNDE durduğu
     * ekranlarda (/kayit/12 gibi) bu parametreler yoktur ve telefonda
     * açılışta görünmesi gereken bölmeyi sunucu bilir; bilmediğimiz bir şeyi
     * adresten tahmin etmektense ekran söylesin.
     *
     *     <div class="columns" data-acilis="son">  → en sağdaki bölme
     *     <div class="columns" data-acilis="ilk">  → en soldaki bölme
     *
     * Öznitelik yoksa adres kuralı geçerlidir.
     */
    const acilis = serit.dataset.acilis;

    if (acilis === 'son') {
        return bolmeler[bolmeler.length - 1];
    }

    if (acilis === 'ilk') {
        return bolmeler[0];
    }

    const adres = new URLSearchParams(window.location.search);

    if (adres.has('kayit')) {
        return bolmeler[bolmeler.length - 1];
    }

    if (adres.has('grup')) {
        return bolmeler[Math.min(1, bolmeler.length - 1)];
    }

    return bolmeler[0];
}

function bolmeyeIn(serit) {
    const hedef = hedefBolme(serit);

    /* Taşma yoksa (masaüstü) kaydırılacak bir şey de yok. */
    if (!hedef || serit.scrollWidth <= serit.clientWidth) {
        return;
    }

    serit.scrollTo({ left: hedef.offsetLeft - serit.offsetLeft, behavior: 'auto' });
}

export function init() {
    /*
     * Yatay kayan HER şerit aynı kurala tabidir. Sekme şeridi de listede:
     * "Hatalar" sekmesindeyken seçilinin nerede olduğu görünmüyordu.
     */
    $$('.topbar__nav, .tabs').forEach(seciliyeOdaklan);

    $$('.columns').forEach(bolmeyeIn);
}
