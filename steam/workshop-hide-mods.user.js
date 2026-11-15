// ==UserScript==
// @name         Steam Workshop: Hide Mods
// @namespace    https://github.com/ceeprus/userscript
// @version      2.8.1
// @description  Hide Workshop mods one by one with an eye on each card, or hide every mod you're subscribed to. Two buttons at the top of the filter sidebar show or hide them again.
// @author       ceeprus
// @icon         https://steamcommunity.com/favicon.ico
// @match        https://steamcommunity.com/workshop/browse/*
// @match        https://steamcommunity.com/app/*/workshop/*
// @match        https://steamcommunity.com/sharedfiles/filedetails/*
// @match        https://steamcommunity.com/workshop/filedetails/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @homepageURL  https://github.com/ceeprus/userscript
// @supportURL   https://github.com/ceeprus/userscript/issues
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/workshop-hide-mods.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/workshop-hide-mods.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Steam's React browse page uses hashed class names that change per build,
    // so items are found through their stable filedetails links instead.
    const ITEM_LINK = 'a[href*="/sharedfiles/filedetails/?id="]';
    const SUBS_TTL = 60 * 60 * 1000;

    let hidden = new Set(load());
    let showingHidden = GM_getValue('showingHidden', false);
    let hideSubbed = GM_getValue('hideSubscribed', false);
    let subbed = new Set();
    let subsState = 'idle';   // idle | loading | ready | error
    let subsError = '';
    let subsLoaded = 0;

    function load() {
        try { return JSON.parse(GM_getValue('hiddenMods', '[]')); }
        catch { return []; }
    }
    function save() {
        GM_setValue('hiddenMods', JSON.stringify([...hidden]));
    }

    // Mod page: (un)subscribing resets the subscription cache; unsubscribing also drops ids older versions put in the own list.
    if (location.pathname.includes('/filedetails/')) {
        const id = new URLSearchParams(location.search).get('id');
        const btn = document.getElementById('SubscribeItemBtn');
        if (!id || !btn) return;
        const isSubscribed = () => btn.classList.contains('toggled')
            || !!document.querySelector('#SubscribeItemOptionSubscribed.selected');
        let was = isSubscribed();
        new MutationObserver(() => {
            const now = isSubscribed();
            if (now === was) return;
            was = now;
            if (!now) {
                hidden = new Set(load());
                if (hidden.delete(id)) save();
            }
            GM_setValue('subsCache', '{}');   // the browse page refetches with this change in it
        }).observe(btn, { attributes: true, attributeFilter: ['class'], subtree: true });
        return;
    }

    function idFromLink(a) {
        return new URL(a.href).searchParams.get('id');
    }

    // Title link = item link without an image; the card is the nearest ancestor that also holds the thumbnail.
    function findCards() {
        const cards = [];
        for (const a of document.querySelectorAll(ITEM_LINK)) {
            if (a.querySelector('img')) continue;
            let card = a.parentElement;
            while (card && card !== document.body && !card.querySelector('img')) card = card.parentElement;
            if (card && card !== document.body) cards.push({ card, id: idFromLink(a) });
        }
        return cards;
    }

    function applyVisibility(card, id) {
        if ('wshideLeaving' in card.dataset) return;
        const isHidden = hidden.has(id);
        if (hideSubbed && subbed.has(id)) card.dataset.wshide = 'hidden';
        else card.dataset.wshide = !isHidden ? '' : showingHidden ? 'dimmed' : 'hidden';
        const btn = card.querySelector('.wshide-btn');
        if (btn) {
            // Same as the AI Disclosure card eye: shut = click to hide; open and red = hidden, click to show.
            setIcon(btn, isHidden ? 'open' : 'shut');
            btn.classList.toggle('wshide-btn--on', isHidden);
            btn.title = isHidden ? 'Unhide this mod' : 'Hide this mod';
            btn.setAttribute('aria-label', btn.title);
        }
        // Row-style cards (hub lists) put the stars in the top-right corner, under the eye; tiles put them below the image.
        const stars = card.querySelector('svg[class*="SVGIcon_Star"]');
        const tip = stars && (stars.closest('.tool-tip-source') || stars.parentElement);
        if (tip && !tip.dataset.wshideStars && card.offsetWidth) tip.dataset.wshideStars = card.offsetWidth > card.offsetHeight * 1.5 ? 'row' : 'tile';
    }

    function addHideButton(card, id) {
        let btn = card.querySelector('.wshide-btn');
        if (btn && btn.dataset.id === id) return;
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wshide-btn';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const modId = btn.dataset.id;
                hidden = new Set(load());   // another tab may have changed the list since this page loaded
                const hiding = !hidden.has(modId);
                if (hiding) hidden.add(modId); else hidden.delete(modId);
                save();
                // A card about to disappear fades out first, so the click visibly lands before the grid closes up.
                if (hiding && !showingHidden && !REDUCED.matches) {
                    card.dataset.wshideLeaving = '';   // page redraws during the fade leave this card alone
                    const done = () => {
                        if (!('wshideLeaving' in card.dataset)) return;
                        delete card.dataset.wshideLeaving;
                        refreshAll();
                    };
                    card.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.97)' }],
                        { duration: 180, easing: EASE_OUT }).finished.then(done, done);
                    setTimeout(done, 300);   // the browser pauses animations in an off-screen window; never leave the card stuck
                } else refreshAll();
            });
            card.appendChild(btn);
        }
        // React can reuse a card node for a different item when paging.
        btn.dataset.id = id;
    }

    function refreshAll() {
        for (const { card, id } of findCards()) {
            addHideButton(card, id);
            applyVisibility(card, id);
        }
        ensureEyes();
        syncEyes();
    }

    // Subscriptions are read from the user's own list, since browse cards no longer show subscribed state.
    // No appid: subscriptions across every game.
    async function fetchSubscribedIds(appid, onProgress) {
        const ids = new Set();
        for (let p = 1; p <= 50; p++) {
            const url = `https://steamcommunity.com/my/myworkshopfiles/?${appid ? `appid=${appid}&` : ''}browsefilter=mysubscriptions&numperpage=30&p=${p}`;
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (res.url.includes('/login')) throw new Error('not signed in');
            const html = await res.text();
            const before = ids.size;
            for (const m of html.matchAll(/href="https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=(\d+)/g)) ids.add(m[1]);
            if (ids.size === before) break;
            onProgress?.(ids.size);
        }
        return ids;
    }

    function currentAppId() {
        return new URLSearchParams(location.search).get('appid') || (location.pathname.match(/\/app\/(\d+)/) || [])[1];
    }

    async function loadSubscribed() {
        const appid = currentAppId();
        if (!appid || subsState === 'loading') return;
        let cache = {};
        try { cache = JSON.parse(GM_getValue('subsCache', '{}')); } catch { /* rebuilt below */ }
        const hit = cache[appid];
        if (hit && Date.now() - hit.at < SUBS_TTL) {
            subbed = new Set(hit.ids);
            subsState = 'ready';
            refreshAll();
            return;
        }
        subsState = 'loading';
        subsLoaded = 0;
        syncEyes();
        try {
            // A big list takes several page loads; a running count shows it is moving.
            subbed = await fetchSubscribedIds(appid, n => { subsLoaded = n; syncEyes(); });
            cache[appid] = { at: Date.now(), ids: [...subbed] };
            GM_setValue('subsCache', JSON.stringify(cache));
            subsState = 'ready';
        } catch (err) {
            subsState = 'error';
            subsError = err.message;
            refreshAll();
            if (!REDUCED.matches) subEye?.animate(   // one short shake so the failure registers
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
                { duration: 280, easing: 'ease-out' });
            return;
        }
        refreshAll();
    }

    // Eye toggles, styled like the Steam AI Disclosure script's header eyes.
    const EYE_SVG = {
        open: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M24 9C14 9 5.46 15.22 2 24c3.46 8.78 12 15 22 15 10.01 0 18.54-6.22 22-15-3.46-8.78-11.99-15-22-15zm0 25c-5.52 0-10-4.48-10-10s4.48-10 10-10 10 4.48 10 10-4.48 10-10 10zm0-16c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/></svg>',
        shut: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M24 14c5.52 0 10 4.48 10 10 0 1.29-.26 2.52-.71 3.65l5.85 5.85c3.02-2.52 5.4-5.78 6.87-9.5-3.47-8.78-12-15-22.01-15-2.8 0-5.48.5-7.97 1.4l4.32 4.31c1.13-.44 2.36-.71 3.65-.71zM4 8.55l4.56 4.56.91.91C6.17 16.6 3.56 20.03 2 24c3.46 8.78 12 15 22 15 3.1 0 6.06-.6 8.77-1.69l.85.85L39.45 44 42 41.46 6.55 6 4 8.55zM15.06 19.6l3.09 3.09c-.09.43-.15.86-.15 1.31 0 3.31 2.69 6 6 6 .45 0 .88-.06 1.3-.15l3.09 3.09C27.06 33.6 25.58 34 24 34c-5.52 0-10-4.48-10-10 0-1.58.4-3.06 1.06-4.4zm8.61-1.57 6.3 6.3L30 24c0-3.31-2.69-6-6-6l-.33.03z"/></svg>',
    };

    let eyes = null, subEye = null, ownEye = null;

    const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
    const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

    // Redrawn only on change: rewriting it every pass would retrigger the page observer forever.
    function setIcon(b, icon, target = b) {
        if (b.dataset.icon === icon) return;
        const swap = !!b.dataset.icon;   // first draw appears as is; later changes crossfade in
        b.dataset.icon = icon;
        target.innerHTML = EYE_SVG[icon];
        if (swap) target.firstChild.animate(REDUCED.matches
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 0, transform: 'scale(0.8)', filter: 'blur(2px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }],
        { duration: 150, easing: EASE_OUT });
    }
    function setFace(b, icon, text) {
        setIcon(b, icon, b.firstChild);
        if (b.lastChild.textContent !== text) b.lastChild.textContent = text;
    }

    function makeEye(className, act) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `wshide-eye ${className}`;
        b.append(document.createElement('span'), document.createElement('span'));
        b.lastChild.className = 'wshide-eye-text';
        b.addEventListener('click', act);
        return b;
    }

    // Sidebar = the panel right under the search box with its left edge and width; classes are hashed and labels localized.
    function findEyeHost() {
        const search = [...document.querySelectorAll('form')].find(f => f.querySelector('input[type="text"]'));
        if (search) {
            const row = search.parentElement.getBoundingClientRect();
            let best = null, bestRect = null;
            for (const el of document.querySelectorAll('div')) {
                const r = el.getBoundingClientRect();
                if (Math.abs(r.left - row.left) > 1 || Math.abs(r.width - row.width) > 2) continue;
                if (r.top < row.bottom - 1 || r.top > row.bottom + 40 || r.height < 60) continue;
                if (!bestRect || r.top < bestRect.top || (r.top === bestRect.top && r.height > bestRect.height)) { best = el; bestRect = r; }
            }
            if (best) return { sidebar: best };
            if (!row.width) return null;   // not laid out yet: the next mutation pass retries
        }
        const first = findCards()[0];
        return first ? { grid: first.card.parentElement } : null;
    }

    function ensureEyes() {
        if (eyes && eyes.isConnected) return;
        const host = findEyeHost();
        if (!host) return;
        if (!eyes) {
            eyes = document.createElement('div');
            eyes.className = 'wshide-eyes';
            subEye = makeEye('wshide-sub-eye', () => {
                if (subsState === 'error') { subsState = 'idle'; hideSubbed = false; }   // a click after a failure retries
                hideSubbed = !hideSubbed;
                GM_setValue('hideSubscribed', hideSubbed);
                if (hideSubbed && subsState === 'idle') loadSubscribed();
                refreshAll();
            });
            ownEye = makeEye('wshide-own-eye', () => {
                showingHidden = !showingHidden;
                GM_setValue('showingHidden', showingHidden);
                refreshAll();
                // Revealed cards fade in, 30ms apart and capped at 10 steps, instead of all popping in at once.
                if (showingHidden) [...document.querySelectorAll('[data-wshide="dimmed"]')].forEach((c, i) =>
                    c.animate([{ opacity: 0 }, { opacity: 1 }],
                        { duration: 200, delay: REDUCED.matches ? 0 : Math.min(i, 10) * 30, easing: EASE_OUT, fill: 'backwards' }));
            });
            eyes.append(subEye, ownEye);
        }
        if (host.sidebar) {
            eyes.classList.remove('wshide-eyes-float');
            host.sidebar.prepend(eyes);
        } else {
            eyes.classList.add('wshide-eyes-float');
            host.grid.before(eyes);
        }
    }

    function syncEyes() {
        if (!eyes) return;
        const subsHidden = hideSubbed && subsState === 'ready';
        // Text names what a click does; the eye shows the current state (shut = mods are being hidden).
        subEye.dataset.on = String(hideSubbed);
        subEye.setAttribute('aria-busy', String(subsState === 'loading'));
        subEye.dataset.error = String(subsState === 'error');
        setFace(subEye, hideSubbed ? 'shut' : 'open',
            subsState === 'loading' ? (subsLoaded ? `Loading… ${subsLoaded}` : 'Loading…') : subsState === 'error' ? 'Retry subscribed' : hideSubbed ? 'Show subscribed' : 'Hide subscribed');
        subEye.title = subsState === 'loading' ? 'Loading your subscriptions…'
            : subsState === 'error' ? `Couldn't load your subscriptions (${subsError}).`
            : subsHidden ? `${subbed.size} subscribed mods hidden.`
            : 'Hide every mod you are subscribed to in this game.';

        const n = hidden.size;
        ownEye.dataset.on = String(!showingHidden && n > 0);   // lit only when it is holding mods back
        ownEye.disabled = !n && !showingHidden;   // empty list: nothing to show, so say how to fill it
        setFace(ownEye, showingHidden ? 'open' : 'shut', `${showingHidden ? 'Hide' : 'Show'} hidden (${n})`);
        ownEye.title = ownEye.disabled ? 'No mods hidden yet. Use the eye on a mod to hide it.'
            : showingHidden ? 'Mods you hid are shown faded. Click to hide them again.' : 'Show the mods you hid, faded.';
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            [data-wshide="hidden"] { display: none !important; }
            /* The content fades, not the card, so the red eye stays readable. */
            [data-wshide="dimmed"] > :not(.wshide-btn) { opacity: 0.35; filter: grayscale(80%); }
            [data-wshide] > :not(.wshide-btn) { transition: opacity 200ms ease-out, filter 200ms ease-out; }
            [data-wshide] { position: relative; }

            /* Card eye, sized and colored like the AI Disclosure script's: 22px chip, hit area 4px past it. */
            .wshide-btn {
                position: absolute;
                top: 6px;
                right: 6px;
                z-index: 2;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                width: 22px;
                height: 22px;
                padding: 0;
                border: 0;
                border-radius: 2px;
                cursor: pointer;
                background: rgba(0, 0, 0, 0.85);
                color: #fff;
            }
            .wshide-btn::after { content: ""; position: absolute; inset: -4px; }
            .wshide-btn svg { display: block; width: 64%; height: 64%; pointer-events: none; }
            .wshide-btn:hover { background: rgba(0, 0, 0, 0.97); }
            .wshide-btn, .wshide-eye { transition: background-color 150ms ease-out, color 150ms ease-out, transform 100ms ease-out; }
            .wshide-btn:active { transform: scale(0.97); }
            .wshide-btn:focus-visible { outline: 2px solid #67c1f5; outline-offset: 2px; }
            .wshide-btn--on { color: #ff5d5d; }
            [data-wshide-stars="row"] { margin-right: 22px; }

            .wshide-eyes { display: flex; gap: 6px; margin: 0 0 12px; }
            .wshide-eyes-float { max-width: 300px; }
            .wshide-eye {
                display: flex;
                flex: 1 1 0;
                min-width: 0;
                align-items: center;
                justify-content: center;
                gap: 6px;
                box-sizing: border-box;
                height: 30px;
                padding: 0 8px;
                border: 0;
                border-radius: 2px;
                cursor: pointer;
                font: inherit;
                font-size: 12px;
                color: #b8b6b4;
                background: rgba(0, 0, 0, 0.25);
            }
            .wshide-eye > span:first-child { display: flex; flex: none; }
            .wshide-eye-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
            .wshide-eye:hover { background: rgba(103, 193, 245, 0.25); color: #fff; }
            .wshide-eye:focus-visible { outline: 2px solid #67c1f5; outline-offset: 2px; }
            .wshide-eye svg { display: block; width: 16px; height: 16px; pointer-events: none; }
            .wshide-sub-eye[data-on="true"] { color: #67c1f5; }
            .wshide-own-eye[data-on="true"] { color: #ff5d5d; }
            .wshide-eye[aria-busy="true"] { cursor: progress; }
            .wshide-eye[data-error="true"] { color: #ff5d5d; }
            .wshide-eye:active:not(:disabled) { transform: scale(0.97); }
            .wshide-eye:disabled { cursor: not-allowed; color: #8f98a0; background: rgba(0, 0, 0, 0.15); }
            .wshide-eye:disabled:hover { background: rgba(0, 0, 0, 0.15); color: #8f98a0; }
            /* Touch screens: 44px targets. */
            @media (pointer: coarse) {
                .wshide-eye { height: 44px; }
                .wshide-btn::after { inset: -11px; }
            }
            @media (prefers-reduced-motion: reduce) { .wshide-btn:active, .wshide-eye:active:not(:disabled) { transform: none; } }
        `;
        document.head.appendChild(style);
    }

    // The React app swaps items in place on paging/filtering, so re-scan on DOM changes (once per frame).
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; refreshAll(); });
    }).observe(document.documentElement, { childList: true, subtree: true });

    // One-time: v2.1 copied subscriptions into the own hidden list; take them back out (retried next visit on failure).
    async function migrateSubscribedOutOfOwnList() {
        if (GM_getValue('subsMigrated', false)) return;
        if (!hidden.size) { GM_setValue('subsMigrated', true); return; }   // empty list: nothing from v2.1 to undo
        try {
            const all = await fetchSubscribedIds(null);
            if (!all.size) return;   // an error page parses as zero subscriptions; try again next visit
            hidden = new Set(load());
            for (const id of all) hidden.delete(id);
            save();
            GM_setValue('subsMigrated', true);
            refreshAll();
        } catch { /* not signed in or offline */ }
    }

    injectStyles();
    refreshAll();
    if (hideSubbed) loadSubscribed();
    migrateSubscribedOutOfOwnList();
})();
