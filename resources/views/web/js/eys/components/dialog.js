import { $, on } from '../lib/dom.js';

/**
 * Form pencerelerini açıp kapatır.
 *
 * Açmak için: <button data-modal-open="blok-ekle">
 * Kapatmak için: data-modal-close, Escape veya zemine tıklama.
 *
 * Sunucudan doğrulama hatasıyla dönen pencere kendini açar (bkz. init).
 */

/** Pencere açıldıysa true; sayfada yoksa false. */
function open(id) {
    const box = $(`#${CSS.escape(id)}[data-modal]`);

    if (!box) {
        return false;
    }

    box.hidden = false;
    box.querySelector('input:not([type=hidden]), select, textarea')?.focus();

    return true;
}

/**
 * Pencere kapanınca İÇİ SIFIRLANIR.
 *
 * Kapatmak yalnızca gizliyordu: yarım doldurulmuş bir form, bir daha
 * açıldığında olduğu gibi karşılıyordu. Kullanıcı ya eski metni siliyor ya
 * da — daha kötüsü — fark etmeden onu gönderiyordu; düzenleme
 * pencerelerinde bu, başka bir kaydın değerlerini göndermek demekti.
 *
 * `form.reset()` boşaltmaz, SUNUCUNUN ÇİZDİĞİ hâle döndürür: düzenleme
 * penceresi kaydın kendi değerlerine geri gelir, ekleme penceresi boşalır.
 *
 * Önceki denemenin hata izleri de gider; kırmızı uyarı, sıfırlanmış bir
 * alanın yanında durunca yanlış bilgi veriyor.
 */
function close(box) {
    if (!box) {
        return;
    }

    box.hidden = true;

    box.querySelectorAll('form').forEach((form) => form.reset());

    box.querySelectorAll('.field__error').forEach((hata) => hata.remove());
    box.querySelectorAll('[aria-invalid="true"]').forEach((alan) => {
        alan.setAttribute('aria-invalid', 'false');
    });
}

export function init() {
    /*
     * Tetikleyici bir bağlantıysa adresi de vardır: pencere sayfada BASILI
     * DEĞİLSE tıklama engellenmez ve tarayıcı o adrese gider. Böylece
     * "pencere kapandı, düğme çalışmıyor" durumu oluşmaz.
     */
    on('click', '[data-modal-open]', (event, trigger) => {
        if (open(trigger.dataset.modalOpen)) {
            event.preventDefault();
        }
    });

    on('click', '[data-modal-close]', (event, trigger) => {
        event.preventDefault();
        close(trigger.closest('[data-modal]'));
    });

    // Zemine tıklamak kapatır; kutunun içine tıklamak kapatmaz.
    on('click', '[data-modal]', (event, box) => {
        if (event.target === box) {
            close(box);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            close($('[data-modal]:not([hidden])'));
        }
    });
}

/**
 * Sunucudan açık gelen ve hatalı pencereyi açar.
 *
 * HER ÇİZİMDE ÇAĞRILIR (bkz. app.js · herCizimde): sayfa geçişi gövdeyi
 * yeniden yazıyor ve DOMContentLoaded bir daha gelmiyor. Yalnız init'te
 * kalınca `?pencere=ekle` bağlantısı sayfayı çiziyor, pencere gizli
 * kalıyor, kullanıcı sayfanın başa atladığını görüyordu (ör. Gruplar ·
 * Yeni alt grup).
 */
export function acilacaklariAc() {
    // autofocus gövde yeniden yazılınca işlemiyor; odağı open() verir.
    const acik = $('[data-modal-acik]');

    if (acik) {
        open(acik.id);
    }

    /*
     * DOĞRULAMA HATASI OLAN PENCERE KENDİLİĞİNDEN AÇILIR.
     *
     * Sunucu hatayı alanın altına yazıyor (bkz. form/field.blade.php) ama
     * pencere kapalı döndüğünde kullanıcı hiçbir şey görmüyor: form
     * gönderiliyor, sayfa yenileniyor, pencere kapanıyor ve ekranda "bir şey
     * olmadı" izlenimi kalıyor — oysa hata oradaydı, yalnızca görünmüyordu.
     *
     * YUKARIDAKİ `data-modal-acik` YETMİYOR: onu her form ayrı ayrı
     * işaretlemek zorunda ve işaret genelde "adreste hangi pencere yazıyor"
     * bilgisine bağlanmış durumda, hataya değil. İşaretlemeyi unutan ya da
     * yönlendirmede adresi koruyamayan her form sessizce bu duruma düşüyordu.
     *
     * Kural GENELDİR: içinde hata olan pencere kendini açar. Yirmi forma tek
     * tek işaret koymak, birini unutmaya açık olurdu.
     */
    const hatali = $('[data-modal] .field__error')?.closest('[data-modal]');

    if (hatali) {
        hatali.hidden = false;
        hatali.querySelector('.field__error')
            ?.closest('.field')
            ?.querySelector('input, select, textarea')
            ?.focus();
    }
}
