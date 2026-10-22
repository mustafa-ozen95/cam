import { on } from '../lib/dom.js';

/**
 * Üst menüdeki hesap menüsü.
 *
 * Menü DIŞARI TIKLAYINCA ve Escape ile kapanır: açık kalan bir menü, altında
 * kalan içeriği tıklanamaz hâle getiriyor ve kullanıcı neden tepki almadığını
 * anlamıyordu.
 */
function list() {
    return document.querySelector('[data-menu-list]');
}

function button() {
    return document.querySelector('[data-menu-open]');
}

function close() {
    const box = list();

    if (box && !box.hidden) {
        box.hidden = true;
        button()?.setAttribute('aria-expanded', 'false');
    }
}

export function init() {
    on('click', '[data-menu-open]', (evt, fire) => {
        evt.preventDefault();

        const box = list();

        if (!box) {
            return;
        }

        box.hidden = !box.hidden;
        fire.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    });

    document.addEventListener('click', (evt) => {
        if (!evt.target.closest('[data-menu]')) {
            close();
        }
    });

    document.addEventListener('keydown', (evt) => {
        if (evt.key === 'Escape') {
            close();
        }
    });
}
