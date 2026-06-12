// ==UserScript==
// @name         Backloggd - Copy Review Link
// @namespace    https://github.com/ceeprus
// @version      1.0
// @description  Adds an icon-only "copy link" button next to the "Open review" button on Backloggd review cards
// @author       Cee
// @match        *://*.backloggd.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STYLE_ID = 'bglg-copy-review-link-style';

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .copy-review-link-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 1.5em;
                min-width: 1.5em;
                padding: 0 0.45em;
                border-radius: 4px;
                cursor: pointer;
                text-decoration: none;
                line-height: 1;
                background-color: transparent;
                border: none;
                color: inherit;
                opacity: 0.75;
                transition: background-color 0.2s ease, opacity 0.2s ease, color 0.2s ease;
            }
            .copy-review-link-btn:hover {
                opacity: 1;
            }
            .copy-review-link-btn.copied {
                background-color: rgba(40, 200, 90, 0.5);
                opacity: 1;
                color: #fff;
            }
            .copy-review-link-btn .label {
                margin-left: 0.35em;
                font-size: 0.85em;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
        } catch (err) {
            console.error('[Backloggd Copy Link] fallback copy failed', err);
        }
        document.body.removeChild(ta);
    }

    function createCopyButton(href) {
        const btn = document.createElement('a');
        btn.className = 'copy-review-link-btn';
        btn.title = 'Copy review link';
        btn.setAttribute('role', 'button');
        btn.innerHTML = '<i class="fa-solid fa-link"></i>';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const fullUrl = new URL(href, location.origin).href;

            const showCopied = () => {
                btn.classList.add('copied');
                btn.innerHTML = '<i class="fa-solid fa-check"></i><span class="label">Link copied</span>';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = '<i class="fa-solid fa-link"></i>';
                }, 1500);
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(fullUrl).then(showCopied).catch(() => {
                    fallbackCopy(fullUrl);
                    showCopied();
                });
            } else {
                fallbackCopy(fullUrl);
                showCopied();
            }
        });

        return btn;
    }

    function addCopyButtons() {
        document.querySelectorAll('a.open-review-link').forEach((link) => {
            const parentCol = link.closest('.col-auto');
            if (!parentCol || parentCol.dataset.copyBtnAdded) return;

            const href = link.getAttribute('href');
            if (!href) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'col-auto my-auto pr-1';
            wrapper.appendChild(createCopyButton(href));

            parentCol.insertAdjacentElement('afterend', wrapper);
            parentCol.dataset.copyBtnAdded = 'true';
        });
    }

    function init() {
        injectStyles();
        addCopyButtons();
    }

    init();

    // Backloggd uses Turbo (Hotwire) for navigation
    document.addEventListener('turbo:load', init);
    document.addEventListener('turbo:render', init);
    document.addEventListener('turbo:frame-load', init);

    // Catch infinite-scroll / dynamically loaded review cards
    const observer = new MutationObserver(() => addCopyButtons());
    observer.observe(document.body, { childList: true, subtree: true });
})();
