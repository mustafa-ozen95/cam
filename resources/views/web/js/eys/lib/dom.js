/**
 * Küçük DOM yardımcıları. İş mantığı içermez.
 */

export const $ = (selector, scope = document) => scope.querySelector(selector);

export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

/**
 * Olay delegasyonu: sonradan eklenen düğümler için de çalışır.
 */
export function on(eventName, selector, handler, scope = document) {
    scope.addEventListener(eventName, (event) => {
        const target = event.target.closest(selector);

        if (target && scope.contains(target)) {
            handler(event, target);
        }
    });
}

export function escapeHtml(value) {
    const element = document.createElement('span');
    element.textContent = value ?? '';

    return element.innerHTML;
}
