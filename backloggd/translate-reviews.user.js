// ==UserScript==
// @name         Backloggd - Translate Reviews
// @namespace    https://github.com/ceeprus
// @version      1.4
// @description  Adds a translate button next to the date of non-English reviews on Backloggd
// @icon         https://www.google.com/s2/favicons?sz=64&domain=backloggd.com
// @author       Cee
// @match        *://*.backloggd.com/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/backloggd/translate-reviews.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/backloggd/translate-reviews.user.js
// ==/UserScript==

(function () {
    'use strict';

    const STYLE_ID = 'bglg-translate-review-style';
    const TARGET_LANG = 'en';
    const ENGLISH_RATIO_THRESHOLD = 0.2;
    const CHUNK_SIZE = 1500;
    const DEBUG = false; // logs every review's verdict to the console

    // Material Design "translate" icon
    const ICON =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>' +
        '</svg>';

    const EN_WORDS = new Set((
        'the a an and or but if is are was were be been am it its this that these those of to in on for with as at by from ' +
        'not no have has had do does did i you he she we they me my your his her our their so very really just can will ' +
        'would could should more most much many some any all game games play played playing story good great bad best ' +
        'like love hate fun boring too also than then there here what which who when how why one about after before ' +
        'still only even into out up down over because while though although think thought feel felt time first last'
    ).split(/\s+/));

    // Common es/pt/fr/de/it/tr words that are not also English words.
    const FOREIGN_WORDS = new Set((
        'el la los las de del que y en un una es con por para muy pero como esta este todo todos se su lo al ya hay ' +
        'jugabilidad juego não é um uma você mas também são le les des du et est pas qui dans sur avec très ' +
        'der das und ist nicht ein eine ich mit sehr aber auch für von zu im den dem es il di che per molto ' +
        'ma sono più ve bir bu çok ama için değil gibi daha'
    ).split(/\s+/));

    function looksEnglish(text) {
        const letters = text.match(/\p{L}/gu) || [];
        if (letters.length < 3) return true;

        const latin = text.match(/[A-Za-z]/g) || [];
        if (latin.length / letters.length < 0.8) return false;

        const words = text.toLowerCase().match(/[\p{L}']+/gu) || [];
        const hasDiacritics = /[àáâãäåçèéêëìíîïñòóôõöùúûüßœąćęłńśźżğış]/i.test(text);
        const foreignHits = words.filter((w) => FOREIGN_WORDS.has(w)).length;
        if (words.length < 3) return !(hasDiacritics || foreignHits > 0);

        const enRatio = words.filter((w) => EN_WORDS.has(w)).length / words.length;
        const foreignRatio = foreignHits / words.length;

        // Checked before the English ratio so English loanwords in a foreign review don't hide it.
        if (foreignRatio >= 0.1 && foreignRatio > enRatio) return false;
        if (enRatio >= ENGLISH_RATIO_THRESHOLD) return true;
        if (hasDiacritics) return false;
        if (words.length >= 5 && enRatio < 0.1) return false;
        return true;
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .translate-review-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                vertical-align: middle;
                height: 1.5em;
                min-width: 1.5em;
                padding: 0 0.3em;
                margin-right: 0.3em;
                border-radius: 4px;
                cursor: pointer;
                line-height: 1;
                background-color: transparent;
                border: none;
                color: inherit;
                font: inherit;
                opacity: 0.75;
                transition: background-color 0.2s ease, opacity 0.2s ease, color 0.2s ease;
            }
            .translate-review-btn svg {
                width: 1.2em;
                height: 1.2em;
            }
            .translate-review-btn:hover,
            .translate-review-btn[aria-expanded="true"] {
                opacity: 1;
            }
            .translate-review-btn:focus-visible {
                opacity: 1;
                outline: 2px solid currentColor;
                outline-offset: 2px;
            }
            .translate-review-btn.loading {
                opacity: 0.4;
                cursor: progress;
            }
            .translate-review-btn.failed {
                opacity: 1;
                color: #e5534b;
            }
            .translate-review-btn .label {
                margin-left: 0.35em;
                font-size: 0.85em;
                white-space: nowrap;
            }
            .translate-review-box {
                margin: 0.5em 0;
                padding: 0.5em 0.75em;
                border-left: 3px solid #888;
                background-color: rgba(128, 128, 128, 0.12);
                white-space: pre-wrap;
            }
            .translate-review-box .from {
                margin-bottom: 0.25em;
                font-size: 0.8em;
                opacity: 0.75;
            }
        `;
        document.head.appendChild(style);
    }

    function gmRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timed out')),
            });
        });
    }

    // The endpoint takes the text in the query string, so long reviews go in sentence-aligned chunks.
    function chunkText(text) {
        const chunks = [];
        let current = '';
        for (const part of text.split(/(?<=[.!?\n])/)) {
            if ((current + part).length > CHUNK_SIZE && current) {
                chunks.push(current);
                current = '';
            }
            current += part;
        }
        if (current) chunks.push(current);
        return chunks;
    }

    async function translate(text) {
        let out = '';
        let from = null;
        for (const chunk of chunkText(text)) {
            const url =
                'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
                encodeURIComponent(TARGET_LANG) +
                '&dt=t&q=' +
                encodeURIComponent(chunk);
            const data = JSON.parse(await gmRequest(url));
            out += (data[0] || []).map((seg) => seg[0]).join('');
            from = from || data[2];
        }
        return { text: out, from };
    }

    function languageName(code) {
        try {
            return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
        } catch (err) {
            return code;
        }
    }

    function createTranslateButton(textEl, box) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'translate-review-btn';
        btn.title = 'Translate review';
        btn.setAttribute('aria-label', 'Translate review');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = ICON;

        let loaded = false;

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.classList.contains('loading')) return;

            if (loaded) {
                box.hidden = !box.hidden;
                btn.setAttribute('aria-expanded', String(!box.hidden));
                btn.title = box.hidden ? 'Show translation' : 'Hide translation';
                return;
            }

            btn.classList.remove('failed');
            btn.classList.add('loading');
            btn.title = 'Translating...';
            try {
                const { text, from } = await translate(textEl.innerText.trim());
                btn.classList.remove('loading');

                if (from === TARGET_LANG) {
                    btn.innerHTML = ICON + '<span class="label">Already in ' + languageName(TARGET_LANG) + '</span>';
                    setTimeout(() => {
                        btn.remove();
                        box.remove();
                    }, 1500);
                    return;
                }

                const label = document.createElement('div');
                label.className = 'from';
                label.textContent = 'Translated from ' + (from ? languageName(from) : 'unknown language');
                const body = document.createElement('div');
                body.textContent = text;
                box.replaceChildren(label, body);
                box.hidden = false;

                loaded = true;
                btn.setAttribute('aria-expanded', 'true');
                btn.title = 'Hide translation';
            } catch (err) {
                btn.classList.remove('loading');
                btn.classList.add('failed');
                btn.title = 'Translation failed, click to retry';
                console.error('[Backloggd Translate] translation failed', err);
            }
        });

        return btn;
    }

    const checked = new WeakSet();

    function addTranslateButtons() {
        document.querySelectorAll('.review-card').forEach((card) => {
            if (checked.has(card)) return;
            const textEl = card.querySelector('.card-text');
            const date = card.querySelector('time');
            if (!textEl || !date) return;
            checked.add(card);

            // Turbo restores visited pages from cloned snapshots: our old buttons come back without their listeners.
            card.querySelectorAll('.translate-review-btn, .translate-review-box').forEach((el) => el.remove());

            const original = textEl.innerText.trim();
            const english = looksEnglish(original);
            if (DEBUG) console.log('[Backloggd Translate]', english ? 'English' : 'not English', '|', original.slice(0, 80));
            if (english) return;

            const box = document.createElement('div');
            box.className = 'translate-review-box';
            box.hidden = true;
            // The box sits outside .card-text, so it has to borrow the review's text style.
            const textStyle = getComputedStyle(textEl);
            for (const prop of ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight']) box.style[prop] = textStyle[prop];
            textEl.insertAdjacentElement('afterend', box);

            // Prepending to the date's <p> keeps "Reviewed on <date>" in one piece on single-review pages.
            date.parentElement.insertAdjacentElement('afterbegin', createTranslateButton(textEl, box));
        });
    }

    function init() {
        injectStyles();
        addTranslateButtons();
    }

    init();

    // Backloggd uses Turbo (Hotwire) for navigation
    document.addEventListener('turbo:load', init);
    document.addEventListener('turbo:render', init);
    document.addEventListener('turbo:frame-load', init);

    // Catch infinite-scroll / dynamically loaded review cards. Watch <html>, not <body>:
    // Turbo swaps the whole body on navigation, which would leave the observer on a dead node.
    const observer = new MutationObserver(() => addTranslateButtons());
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
