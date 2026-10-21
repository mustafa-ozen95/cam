import { $ } from '../lib/dom.js';

const DISPLAY_MS = 4000;
const DISPLAY_MS_MAX = 12000;

/**
 * Uzun metin daha uzun durur.
 *
 * Süre sabitken uzun bir bildirim okunamadan kayboluyordu: kullanıcı "bir şey
 * yazdı ama ne yazdı" diye bakakalıyordu. Karakter başına küçük bir ek süre,
 * tavanla sınırlı.
 */
function duration(message) {
    return Math.min(DISPLAY_MS + message.length * 45, DISPLAY_MS_MAX);
}

/**
 * Kısa süreli bildirim. Sunucudan gelen hazır metni gösterir, metin üretmez.
 */
export function emit(message, variant = 'info') {
    const host = $('.toast-host');

    if (!host) {
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast--${variant}`;
    toast.role = 'status';
    toast.textContent = message;

    /*
     * Tıklayınca kapanır. Bildirim üst şeritte, düğmelerin önünde duruyor;
     * okuyan biri onu beklemek zorunda kalmamalı.
     */
    toast.title = 'Kapatmak için tıklayın';
    toast.addEventListener('click', () => toast.remove());

    host.append(toast);

    setTimeout(() => toast.remove(), duration(message));
}

export function init() {
    const host = $('.toast-host');
    const flash = host?.dataset.flash;

    if (flash) {
        emit(flash, host.dataset.flashVariant || 'success');

        /*
         * Bir kez gösterilir. Panelde sayfa geçişleri tam yenileme yapmıyor;
         * işaret silinmezse aynı bildirim her geçişte yeniden çıkabilir.
         * Gövde tümüyle değiştiğinde bu tetiklenmez; yine de işaret silinir
         * ki geçiş biçimi değişirse aynı hata doğmasın.
         */
        delete host.dataset.flash;
    }
}
