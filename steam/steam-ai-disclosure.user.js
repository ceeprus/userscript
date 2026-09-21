// ==UserScript==
// @name         Steam AI Content Disclosure Badge
// @namespace    https://github.com/ceeprus/userscript
// @version      2.14
// @description  Flags Steam games that carry an "AI Generated Content Disclosure" — a badge by the title on app pages, an overlay on capsules everywhere (store home, search, recommendations, /sale/ event pages, the personal calendar, hover popups), and a line under the description in expanded sale widgets. An eye button in Steam's header cycles what listings do with a disclosed game: nothing, badge, blur until hovered, or hide it.
// @author       ceeprus
// @homepage     https://github.com/ceeprus/userscript
// @icon         data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%3Crect%20width='64'%20height='64'%20rx='10'%20fill='%23171a21'/%3E%3Ctext%20x='32'%20y='43'%20font-family='Arial,sans-serif'%20font-size='30'%20font-weight='bold'%20fill='%23ffce5c'%20text-anchor='middle'%3EAI%3C/text%3E%3C/svg%3E
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @supportURL   https://github.com/ceeprus/userscript/issues
// @match        https://store.steampowered.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;                 // skip embedded widgets/iframes
    if (location.pathname.startsWith('/widget/')) return;

    /* ---------------- tweakables ---------------- */
    const TTL_AI       = 30 * 24 * 60 * 60 * 1000;           // cache life for "has AI" results
    const TTL_NONE     =  7 * 24 * 60 * 60 * 1000;           // cache life for "no AI" (devs can add it later)
    const MAX_CONCURRENT = 3;                                // parallel background fetches
    const ROOT_MARGIN  = '300px';                            // how early to check capsules before they scroll in
    const BYPASS_AGE_GATE = true;                            // set age cookies so mature/adult game pages can be read
    const FETCH_TIMEOUT = 15000;                             // give up on a stalled app-page read
    const MAX_BYTES    = 3e6;                                // refuse an app page bigger than this
    const MAX_TEXT     = 400;                                // cap the disclosure text we keep
    const SWEEP_EVERY  = 24 * 60 * 60 * 1000;                // prune expired cache rows once a day

    // Everything listings do with an AI-disclosed game, cycled by the eye button in Steam's header:
    //   'skip'  — don't check listings at all (no background lookups)
    //   'badge' — badge the game
    //   'blur'  — badge it, and blur the card until hovered; it keeps its space, so no layout breaks
    //   'hide'  — badge it, and remove the card from the page
    const MODES = ['skip', 'badge', 'blur', 'hide'];
    let MODE = loadMode();
    function loadMode() {
        const m = GM_getValue('sgai:mode', null);
        if (GM_getValue('sgai:scan', true) === false) return 'skip';   // pre-2.12 "capsule badges OFF"
        if (MODES.includes(m)) return m;
        if (m === 'off') return 'badge';                               // pre-2.12 name for badge-only
        return GM_getValue('sgai:hide', false) ? 'hide' : 'badge';     // pre-2.7 boolean
    }
    // Blur and hide are the modes where an unbadged game reads as "checked and cleared", so they
    // are the ones that need the in-flight and failed-lookup markers.
    const filtering = () => MODE === 'blur' || MODE === 'hide';
    const applyMode = () => { document.documentElement.dataset.sgaiMode = MODE; };
    function setMode(mode) {
        MODE = mode;
        GM_setValue('sgai:mode', MODE);
        GM_deleteValue('sgai:scan');          // folded into MODE; a stale value must not win next load
        applyMode();
        if (MODE === 'skip') dropQueued();    // stop a queued backlog draining into Steam
        else scan();                          // leaving skip: this may be the page's first scan
        heal();                               // re-assert badges and the blur positioning guard
        syncEye();
    }
    applyMode();
    // Steam's React pages navigate with pushState, so this is not fixed for the life of the tab.
    // It has to be re-read: on a game's own page hide and blur are restricted to "More Like This",
    // and carrying that restriction to the next page left the filter silently doing nothing.
    const appIdFromPath = () => (location.pathname.match(/^\/app\/(\d+)/) || [])[1] || null;
    let APP_PAGE_ID = appIdFromPath();

    // Named in every badge tooltip, so a screenshot in a bug report says which build made it.
    const INFO = (typeof GM_info !== 'undefined' && GM_info.script) || {};
    const SIGNATURE = `${INFO.name || 'Steam AI Content Disclosure Badge'}${INFO.version ? ' v' + INFO.version : ''}`;

    /* ---------------- localized disclosure titles (data, MIT from seeeeew/aiwarningforsteam) ----- */
    const TITLES = ["AI Generated Content Disclosure","AI 生成内容披露","AI 生成內容聲明","AI生成コンテンツの開示",
        "AI 생성 콘텐츠 사용 공개","การเปิดเผยข้อมูลเกี่ยวกับเนื้อหาที่สร้างด้วย AI","Pernyataan Konten Buatan AI",
        "Pendedahan Kandungan Dihasilkan AI","Оповестяване за съдържание, генерирано от ИИ","Informace o obsahu vytvářeném AI",
        "Meddelelse om AI-genereret indhold","Offenlegung von KI-generierten Inhalten","Información sobre contenido generado por IA",
        "Γνωστοποίηση περιεχομένου που δημιουργήθηκε από τεχνητή νοημοσύνη (AI)","Divulgation de contenu généré par IA",
        "Divulgazione dei contenuti generati dall'IA","Nyilatkozat MI generálta tartalomról","Informatie over door AI gegenereerde inhoud",
        "Opplysning om AI-generert innhold","Oświadczenie w sprawie treści generowanych przez SI","Divulgação de conteúdo gerado por IA",
        "Informații despre conținutul generat de IA","Информация об ИИ-контенте","Tiedote tekoälysisällöstä",
        "Upplysning om AI-genererat innehåll","Yapay Zekâ İçeriği Açıklaması","Công bố về nội dung tạo bởi AI",
        "Розкриття інформації щодо вмісту, згенерованого ШІ"];
    const TITLE_SET = new Set(TITLES);

    /* ---------------- style ---------------- */
    // The badge is shaped like Steam's own capsule flags (the discount chip, "Free To Play"):
    // flat, dark, 2px corners, small uppercase Motiva Sans — just amber instead of Steam's green.
    // Swap ACCENT to '#ff5d5d' for a warning-red look.
    const ACCENT = '#ffce5c';

    const CSS = `
        .sgai_badge{display:inline-block;font:700 11px/1 "Motiva Sans",Arial,sans-serif;
            letter-spacing:.7px;text-transform:uppercase;color:${ACCENT};background:rgba(0,0,0,.85);
            border-radius:2px;padding:4px 5px;vertical-align:middle;white-space:nowrap;}
        .sgai_title{margin-left:10px;font-size:12px;padding:5px 7px;cursor:pointer;}
        .sgai_title:hover{color:#fff;}
        .sgai_cap{position:absolute;top:4px;left:4px;z-index:50;}
        /* A corner badge sits over the capsule's link: let clicks through, or it is a dead zone
           on the very corner of every flagged game. The inline and description badges sit beside
           text rather than over it, so they keep their tooltip. */
        .sgai_cap:not(.sgai_inline):not(.sgai_desc){pointer-events:none;}
        /* Steam's IN LIBRARY / WISHLISTED ribbon owns this corner when it is there. */
        .sgai_cap.sgai_under_flag{top:28px;}
        .sgai_inline{position:static;margin-left:8px;cursor:default;}
        .sgai_desc{position:static;margin-top:8px;}
        .sgai_host{position:relative;}
        .sgai_err{color:#8f98a0;}
        /* Lookup in flight, so a game that is about to be blurred or hidden doesn't just sit
           there looking checked-and-cleared. Drawn in CSS rather than fetched: an image would be
           one more thing for a Content-Security-Policy or a blocked CDN to take away. */
        .sgai_check{width:12px;height:12px;padding:4px;background:rgba(0,0,0,.85);}
        .sgai_check::before{content:"";display:block;box-sizing:border-box;width:12px;height:12px;
            border:2px solid rgba(255,255,255,.25);border-top-color:${ACCENT};border-radius:50%;
            animation:sgai_spin .8s linear infinite;}
        @keyframes sgai_spin{to{transform:rotate(360deg);}}
        [data-sgai-mode="skip"] .sgai_cap{display:none !important;}
        [data-sgai-mode="hide"] .sgai_ai{display:none !important;}
        /* Blur mode: blur the card's contents, not the card, so nothing reflows and our own badge
           stays legible on top. Hovering reveals the game. */
        [data-sgai-mode="blur"] .sgai_ai:not(:hover) > *:not(.sgai_cap){filter:blur(10px);}
        [data-sgai-mode="blur"] .sgai_ai:not(:hover){background:rgba(0,0,0,.25);}
        [data-sgai-mode="blur"] .sgai_ai:not(:hover)::after{content:"AI disclosure — hover to reveal";
            position:absolute;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;
            text-align:center;padding:4px;pointer-events:none;
            font:700 clamp(10px,1.1vw,13px)/1.25 "Motiva Sans",Arial,sans-serif;color:${ACCENT};}
        /* Eye toggle, docked into the global header next to the notifications/account items.
           The header styles its children through #global_action_menu, and an id outranks any
           selector we can write, so the box and the state color are held with !important. */
        .sgai_eye{float:left;display:flex !important;align-items:center;justify-content:center;
            box-sizing:border-box;width:26px !important;height:26px !important;padding:0 !important;
            margin:0 10px 0 0;border-radius:2px;cursor:pointer;
            color:#b8b6b4 !important;background:rgba(0,0,0,.25);}
        .sgai_eye:hover{background:rgba(103,193,245,.25);filter:brightness(1.3);}
        .sgai_eye svg{display:block;width:17px;height:17px;}
        .sgai_eye[data-mode="skip"]{opacity:.5;}
        .sgai_eye[data-mode="blur"],.sgai_eye[data-mode="hide"]{color:${ACCENT} !important;}
        /* Pages without the header (a few /sale/ layouts): park it in the corner instead. */
        .sgai_eye_float{position:fixed;top:12px;right:14px;z-index:9999;float:none;margin:0;
            background:rgba(0,0,0,.75);}
    `;

    // A page can ship a Content-Security-Policy that refuses an injected <style> — style-src
    // without 'unsafe-inline' blocks the tag GM_addStyle appends, and the whole script goes
    // invisible. A constructed stylesheet is not inline content and applies under that same
    // policy, so try it first and fall back only if the browser (or the sandbox) won't take one.
    // Whichever route wins, we keep the sheet: alignEye() writes into it, because an inline
    // style attribute is blocked by that policy too.
    // Every route is checked by actually measuring a sentinel, never by assuming.
    function stylesLive() {
        const t = document.createElement('span');
        t.className = 'sgai_badge';
        (document.body || document.documentElement).appendChild(t);
        const ok = getComputedStyle(t).letterSpacing === '0.7px';   // set only by our own rule
        t.remove();
        return ok;
    }

    function installStyles() {
        try {                                                // 1. constructed sheet: CSP-proof
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            if (stylesLive()) return sheet;
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(x => x !== sheet);
        } catch (e) { /* no constructable stylesheets, or a sandbox realm that won't adopt */ }
        try {                                                // 2. our own <style>, so we keep .sheet
            const el = document.createElement('style');
            el.textContent = CSS;
            (document.head || document.documentElement).appendChild(el);
            if (stylesLive()) return el.sheet;
            el.remove();
        } catch (e) { /* head missing or append refused */ }
        try {                                                // 3. whatever the manager can do
            if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); if (stylesLive()) return null; }
        } catch (e) { /* GM_addStyle unavailable */ }
        return undefined;                                    // null = styled, no sheet handle
    }

    const SHEET = installStyles();
    // Distinguishes "styled, but we hold no sheet" (null) from "nothing applied" (undefined).
    const STYLES_OK = SHEET !== undefined;
    if (!STYLES_OK) console.warn('[SteamGameAI] page styles blocked — badges and the eye are stood down');

    /* ---------------- cache (GM storage) ---------------- */
    // Rows come back from a store the user (and their manager's backup/sync/editor) can write, so
    // every one is checked before it is believed. A row this script never wrote must return null,
    // never throw: cacheGet runs inside the IntersectionObserver callback, where a throw would
    // strand every other capsule in the same batch.
    const key = id => 'sgai:' + id;
    const validId = id => /^\d+$/.test(String(id));
    function cacheGet(id) {
        if (!validId(id)) return null;
        const v = GM_getValue(key(id), null);
        if (!v || typeof v !== 'object') return null;         // a string or number would throw on `in`
        if (!('name' in v)) return null;                      // pre-2.9 entry, no game name: refetch once
        if (!Number.isFinite(v.ts)) return null;              // no timestamp: would never expire
        const age = Date.now() - v.ts;
        if (age < 0 || age > (v.ai ? TTL_AI : TTL_NONE)) return null;   // future ts = a skewed clock
        return v;
    }
    const cacheSet = (id, d) => {
        if (!validId(id)) return;
        try {
            GM_setValue(key(id), { ai: !!d.ai, text: (d.text || '').slice(0, MAX_TEXT) || null,
                                   name: (d.name || '').slice(0, 120) || null, ts: Date.now() });
        } catch (e) { console.warn('[SteamGameAI] could not cache', id, e); }   // quota, serialization
    };

    // Expired rows are only ever skipped on read, so without this they accumulate for as long as
    // the script is installed. Sweep once a day, off the critical path.
    function sweepCache() {
        if (typeof GM_listValues !== 'function') return;
        if (Date.now() - (GM_getValue('sgai:swept', 0) || 0) < SWEEP_EVERY) return;
        GM_setValue('sgai:swept', Date.now());
        let gone = 0;
        for (const k of GM_listValues() || []) {
            const m = /^sgai:(\d+)$/.exec(k);
            if (!m) continue;
            if (!cacheGet(m[1])) { GM_deleteValue(k); gone++; }   // same validity rules as a read
        }
        if (gone) console.info(`[SteamGameAI] pruned ${gone} stale cache entries`);
    }

    /* ---------------- parse disclosure out of a document ---------------- */
    function getDisclosure(root) {
        // Collapse whitespace before matching: a heading Steam's template wrapped across source
        // lines, or one holding a non-breaking space, is the same heading.
        const flat = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
        const h2 = [...root.querySelectorAll('h2')].find(h => TITLE_SET.has(flat(h)));
        if (!h2) return { ai: false, text: null };
        // Steam's own disclosure sits in the content-descriptors block. The same heading outside
        // it is a developer's [h2] in their store description, where the "box" would be the whole
        // page — that scored a false positive and swept 45 KB of description into the badge
        // tooltip and the cache. Outside the block, only a box small enough to BE a disclosure counts.
        let box = h2.closest('#game_area_content_descriptors');
        if (!box) {
            box = h2.parentElement;
            if (!box || box.textContent.length > 2000) return { ai: false, text: null };
        }
        let text = '';
        box.childNodes.forEach(n => { if (n !== h2) text += (n.textContent || '') + ' '; });
        text = text.replace(/\s+/g, ' ').trim();
        const ci = text.indexOf(':');                       // drop "The developers describe ... like this:" intro
        if (ci > -1 && ci < 160) text = text.slice(ci + 1).trim();
        return { ai: true, text: text.slice(0, MAX_TEXT) || null };
    }

    // The game's own name, read off its app page. hideTarget() uses it to recognise where a
    // capsule's card ends (see there); null when the page didn't load a name (age gate, error).
    function appName(root) {
        const el = root.querySelector('#appHubAppName, .apphub_AppName');
        let n = el ? el.textContent : (root.querySelector('title')?.textContent || '').replace(/ on Steam\s*$/, '');
        n = (n || '').replace(/\s+/g, ' ').trim();
        return n || null;
    }

    /* ---------------- throttled background lookup ---------------- */
    // Three at a time, the rest queued. `epoch` exists so a queued backlog can be thrown away:
    // an infinite-scroll page can queue well over a thousand lookups, and switching listings off
    // must stop them rather than let them drain into Steam for the next two minutes.
    let active = 0, epoch = 0;
    const queue = [];
    const slot = () => new Promise((res, rej) => {
        const mine = epoch;
        // The slot is taken when it is actually handed over, never in release(), so a cancelled
        // waiter cannot leave the count above what is really running.
        const take = () => (mine === epoch ? (active++, res()) : rej(new Error('lookup cancelled')));
        if (active < MAX_CONCURRENT) take(); else queue.push(take);
    });
    const release = () => {
        active = Math.max(0, active - 1);                    // never let a stray release go negative
        const next = queue.shift();
        if (next) next();
    };
    function dropQueued() {                                  // nothing waiting held a slot
        epoch++;
        queue.splice(0).forEach(take => take());
    }

    // Mature/adult app pages serve an age-check interstitial that has no disclosure section, so they'd
    // be misread as "no AI". Setting the standard age cookies (lazily, only once we actually hit a gate)
    // lets the retry read the real page. Controlled by BYPASS_AGE_GATE.
    //
    // Deliberately narrow: host-only rather than all of .steampowered.com, a day rather than a
    // year, and never when Steam has already set its own birthtime — two cookies of the same name
    // would both be sent and which one the server honours is anyone's guess. wants_mature_content
    // is not an age gate at all, it is a preference for what the store shows, so it is not ours to
    // set. The write is read back, because a blocked or partitioned cookie jar fails silently.
    let ageCookiesSet = false;
    function setAgeCookies() {
        if (ageCookiesSet) return;
        if (/\bbirthtime=/.test(document.cookie)) { ageCookiesSet = true; return; }
        const opts = '; path=/; max-age=86400; SameSite=Lax; Secure';
        document.cookie = 'birthtime=631152001' + opts;             // 1 Jan 1990
        document.cookie = 'lastagecheckage=1-January-1990' + opts;
        ageCookiesSet = /\bbirthtime=631152001\b/.test(document.cookie);
        if (!ageCookiesSet) console.warn('[SteamGameAI] age cookies blocked; gated games stay unverified');
    }
    const isAgeGate = (url, html) => url.includes('/agecheck') || /agegate_birthday|app_agegate|agegate_text_container/.test(html);

    async function fetchAppPage(id) {
        // No ?l= or ?cc=: asking Steam for a language is how you get a Set-Cookie that changes the
        // store language the user actually browses in. The page arrives in their own language
        // instead, which is what the localized TITLES list is for.
        const url = `https://store.steampowered.com/app/${id}/`;
        let html = await read(url, {});
        if (BYPASS_AGE_GATE && html.gate) {
            setAgeCookies();
            html = await read(url, { cache: 'reload' });
            // Still gated: adult-only titles need a per-app opt-in we are not going to set, and a
            // gate page parses as "no disclosure". Fail instead, so it is never cached as clean.
            if (html.gate) throw new Error('age gate not cleared');
        }
        return html.text;
    }

    // One read, with the failure modes that actually happen on Steam handled: a stalled socket
    // (abort), an error or maintenance page (status), and a response too big to be an app page.
    async function read(url, opts) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
        try {
            const res = await fetch(url, { ...opts, signal: ac.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);   // 429/503/404 must not cache as "no AI"
            const len = +res.headers.get('content-length');
            if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('body too large: ' + len);
            const text = await res.text();
            return { text, gate: isAgeGate(res.url || url, text) };
        } finally { clearTimeout(timer); }
    }

    const inflight = new Map();
    function lookup(id) {
        const c = cacheGet(id);
        if (c) return Promise.resolve(c);
        if (inflight.has(id)) return inflight.get(id);
        const p = (async () => {
            let held = false;                                 // only release a slot we actually took
            try {
                await slot();
                held = true;
                const html = await fetchAppPage(id);
                // Most games carry no disclosure, and an app page is megabytes: test the raw text
                // for any of the localized headings first and skip building a DOM for the misses.
                // (Idea from seeeeew/aiwarningforsteam, which matches the heading in raw HTML.)
                // The descriptors block has to be there too — the bare phrase also turns up in
                // reviews, and each false positive costs a full ~20ms parse on the main thread.
                if (!html.includes('game_area_content_descriptors') || !TITLES.some(t => html.includes(t))) {
                    const d = { ai: false, text: null, name: null };
                    cacheSet(id, d);
                    return d;
                }
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const d = getDisclosure(doc);
                d.name = appName(doc);
                cacheSet(id, d);                            // only cache successful reads
                return d;
            } catch (e) {
                console.warn('[SteamGameAI] lookup failed', id, e);
                return { ai: false, text: null, name: null, error: true };
            } finally { if (held) release(); inflight.delete(id); }
        })();
        inflight.set(id, p);
        return p;
    }

    /* ---------------- badges ---------------- */
    function makeBadge(text) {
        const b = document.createElement('span');
        b.className = 'sgai_badge';
        b.textContent = 'AI';
        b.title = text ? `${text}

— ${SIGNATURE}` : SIGNATURE;
        return b;
    }

    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const capsuleAlt = el => {
        const img = el.matches('img') ? el : el.querySelector('img[alt]:not([alt=""])');
        return (img && img.getAttribute('alt')) || el.getAttribute('aria-label') || '';
    };

    // The appid an element itself stands for — exact, never a substring: "/app/700330" must not
    // read as app 70.
    function appIdOf(el) {
        if (!el || !el.getAttribute) return null;
        const d = (el.getAttribute('data-ds-appid') || '').trim();
        if (/^\d+$/.test(d)) return d;
        const m = (el.getAttribute('href') || '').match(/\/app\/(\d+)/);
        return m ? m[1] : null;
    }
    // Our badge needs a positioned host, but Steam positions its own overlays (the IN LIBRARY
    // ribbon, discount chips) against these same boxes — adding a containing block where one was
    // missing moves them, measurably by hundreds of pixels. So: only add the class when it is
    // really needed, remember that we added it, and take it away again when our badge goes.
    // A detached node reports every computed property as '' — that means "not laid out yet",
    // not "static", and placing against it would anchor the badge to some far-off ancestor.
    function ensureHost(el) {
        if (!el || !el.isConnected) return false;
        if (el.dataset.sgaiHosted) return true;
        const pos = getComputedStyle(el).position;
        if (pos === '') return false;
        if (pos === 'static') { el.classList.add('sgai_host'); el.dataset.sgaiHosted = '1'; }
        return true;
    }
    function releaseHost(el) {
        if (!el || !el.dataset || !el.dataset.sgaiHosted) return;
        if (el.querySelector(':scope > .sgai_cap')) return;   // another badge still needs it
        el.classList.remove('sgai_host');
        delete el.dataset.sgaiHosted;
    }

    // One badge per card. A hover popup holds several links to the same app (media block, header
    // capsule, title) and must be badged once; two separate cards for the same game in one row
    // must be badged twice. Both fall out of the same rule: grow to the largest ancestor that
    // still talks about nothing but this game. Another app's presence ends the card, so two cards
    // in a mixed row each claim only themselves, while everything inside one popup is one claim.
    function claimCard(el, id, attr) {
        const prior = el.closest(`[${attr}~="${id}"]`);
        if (prior) {
            // A claim whose badge did not survive a re-render is stale; honouring it would
            // suppress this card's badge for the rest of the session.
            if (prior.querySelector('.sgai_cap')) return false;
            const left = (prior.getAttribute(attr) || '').split(/\s+/).filter(x => x && x !== id);
            left.length ? prior.setAttribute(attr, left.join(' ')) : prior.removeAttribute(attr);
        }
        let root = el;
        for (let n = el.parentElement, i = 0; n && i < 8 && !n.matches(HIDE_STOP); n = n.parentElement, i++) {
            if (foreignApp(n, id)) break;
            root = n;
        }
        const claimed = (root.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
        if (!claimed.includes(id)) { claimed.push(id); root.setAttribute(attr, claimed.join(' ')); }
        return true;
    }

    // Shown while a lookup is actually on the network (a cache hit needs none), so a game that is
    // about to be blurred or hidden doesn't read as already checked and cleared. Only with a
    // filter on, where that misreading costs something.
    // (Idea from seeeeew/aiwarningforsteam, which throbbers its pending search rows.)
    function checkBadge(el, on) {
        const had = el.querySelector(':scope > .sgai_check');
        if (!on) { if (had) { had.remove(); releaseHost(el); } return; }
        if (!filtering() || had || !ensureHost(el)) return;
        const b = document.createElement('span');
        b.className = 'sgai_badge sgai_cap sgai_check';
        b.title = `Checking for an AI Generated Content Disclosure…

— ${SIGNATURE}`;
        el.appendChild(b);
    }

    // A lookup that failed leaves a game looking clean, which matters once a filter is on: the
    // game stays visible as if it had been checked and cleared. Mark those so the gap is visible
    // (idea from seeeeew/aiwarningforsteam, which flags failed search-row checks).
    function errBadge(el, id) {
        if (!filtering() || !el.isConnected) return;
        if (badgeKind(el) === 'desc') return;                    // the capsule of this card carries it
        if (!claimCard(el, id, 'data-sgai-err')) return;
        if (!ensureHost(el)) return;
        const b = makeBadge(`AI disclosure check failed for app ${id} — this game was not verified`);
        b.classList.add('sgai_cap', 'sgai_err');
        b.textContent = 'AI?';
        el.appendChild(b);
    }

    function titleBadge(text) {
        const t = document.querySelector('#appHubAppName, .apphub_AppName');
        if (!t || t.querySelector('.sgai_title')) return;
        const b = makeBadge(text || 'This game discloses AI generated content');
        b.classList.add('sgai_title');
        b.addEventListener('click', e => {
            e.preventDefault();
            document.querySelector('#game_area_content_descriptors')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        t.appendChild(b);
    }

    const managed = [];   // badges we've placed, re-asserted if a React re-render strips them

    function badgeKind(el) {
        if (el.matches('.hover_title, .tab_preview') || el.querySelector('.hover_title, .tab_title')) return 'title';
        if (el.matches('.StoreSaleWidgetShortDesc')) return 'desc';
        return 'corner';
    }

    // Where a corner badge belongs. In blur mode that is the card itself: the blur is a filter on
    // the hide target, and a CSS filter applies to the whole subtree, so a badge sitting inside
    // the target gets blurred with it no matter how the rule is written. Sitting ON the target,
    // it is a direct child and the :not(.sgai_cap) exemption can keep it sharp.
    const badgeHost = m => (MODE === 'blur' && m.target && m.target.isConnected) ? m.target : m.el;

    function placedOk(m) {
        if (!m.node || !m.node.isConnected) return false;
        if (m.kind === 'desc') return m.node.previousElementSibling === m.el;
        if (m.kind === 'title') return !!m.node.parentElement?.matches('.hover_title, .tab_title');
        return m.node.parentElement === badgeHost(m);
    }

    // Always moves the badge this entry already owns rather than building another one: the old
    // "is there one next to me?" test failed as soon as Steam re-rendered something in
    // between, and every re-render added one more badge.
    function placeBadge(m) {
        if (!m.node) m.node = makeBadge(m.text);
        if (m.kind === 'title') {
            const t = m.el.matches('.hover_title, .tab_title') ? m.el : m.el.querySelector('.hover_title, .tab_title');
            if (!t) { m.kind = 'corner'; return placeBadge(m); }   // a preview with no title node
            m.node.classList.add('sgai_cap', 'sgai_inline');
            t.appendChild(m.node);
            return;
        }
        if (m.kind === 'desc') {
            m.node.classList.add('sgai_cap', 'sgai_desc');
            m.el.after(m.node);
            return;
        }
        const host = badgeHost(m);
        if (!ensureHost(host)) return;
        m.node.classList.add('sgai_cap');
        // Steam draws its own IN LIBRARY / WISHLISTED ribbon in this corner; sit below it rather
        // than hide what the user already owns.
        m.node.classList.toggle('sgai_under_flag', !!host.querySelector('.ds_flag'));
        host.appendChild(m.node);
        if (m.host && m.host !== host) releaseHost(m.host);
        m.host = host;
    }

    /* ---------------- what blur and hide act on ---------------- */
    // The element blur and hide mode act on — the game's whole card, not just the capsule
    // anchor. In the React store layouts (home sale widgets, /sale/ pages) the /app/
    // anchor is only the capsule image; the title, tags, description and buttons are siblings,
    // so we grow outward from the capsule. Growth stops at, in order:
    //   • a container holding another game (foreignApp) — keeps carousel slides and grids safe;
    //   • a container that adds a heading of its own — a heading belongs to a page section, not
    //     to one game's card, and this is what stops "Half-Life Franchise" or "Controller-friendly
    //     picks" taking their whole section with them;
    //   • a container named for this app (appScoped) — that is exactly one game's card;
    //   • text that isn't this game's: a calendar date, a section label, curator navigation.
    // Once an ancestor has been recognised as this game's card, the rows below it (price, tags,
    // buttons) are card too and get absorbed — otherwise hiding leaves "-50% $4.99" behind.
    const HIDE_STOP = 'body, main, #StoreTemplate, #responsive_page_template_content, [data-featuretarget],' +
        '.responsive_page_frame, .responsive_page_content, #page_background_container, .page_content_ctn, .creator_grid_ctn';

    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-boundary, so the game "Control" is not found inside "Controller-friendly picks".
    const namesGame = (text, want) => new RegExp(`(^|\\W)${escapeRe(want)}(\\W|$)`).test(text);
    // The text an ancestor adds beyond what we already have; t's text is contiguous inside it.
    function addedText(n, t) {
        const full = norm(n.textContent), inner = norm(t.textContent);
        if (!inner) return full;
        const i = full.indexOf(inner);
        return (i === -1 ? full : full.slice(0, i) + ' ' + full.slice(i + inner.length)).trim();
    }
    const headingOutside = (n, t) => [...n.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(h => !t.contains(h));
    // Last-resort backstop: nothing that fills the screen is one game's card.
    function pageSized(n) {
        const r = n.getBoundingClientRect();
        return r.height > innerHeight * 0.8 && r.width > innerWidth * 0.9;
    }

    function hideTarget(el, kind, id, name) {
        if (kind === 'title') return null;
        let t = el.closest('a[href*="/app/"]') || el.closest('[data-ds-appid]') || el;
        const want = norm(name) || norm(capsuleAlt(t));
        // With no name we cannot tell this game's card from the page around it. Hiding a guess
        // would strand half a card or eat a section, so filter nothing and leave the badge.
        if (!want) return null;
        let named = namesGame(norm(t.textContent), want), scoped = false;
        for (let n = t.parentElement, i = 0; n && i < 8 && !n.matches(HIDE_STOP); n = n.parentElement, i++) {
            if (foreignApp(n, id)) break;
            if (headingOutside(n, t)) break;
            if (pageSized(n)) break;
            if (appScoped(n, id)) { t = n; scoped = true; continue; }
            if (scoped) break;                               // past that container: page furniture
            const added = addedText(n, t);
            if (!added) { t = n; continue; }                 // adds nothing: a wrapper, absorb it
            if (named) { t = n; continue; }                  // the card's own price / tags / buttons
            if (namesGame(added, want)) { t = n; named = true; continue; }
            break;                                           // somebody else's text: card ended below
        }
        return t;
    }

    // Is this container named for this app — e.g. the curator page's #app-ctn-<appid>? Such an id
    // marks exactly one game's card, so it is the hide target and growth stops there. Matched
    // strictly: a container called "sale_row_400" is a sale row, not app 400's card.
    function appScoped(n, id) {
        if ((n.getAttribute('data-ds-appid') || '').trim() === id) return true;
        if ((n.getAttribute('data-appid') || '').trim() === id) return true;
        return new RegExp(`(^|[-_])app[-_]?(ctn|card|capsule|container)?[-_]?${id}($|[-_])`, 'i').test(n.id || '');
    }

    // Does this container reference any app other than `id`?
    function foreignApp(n, id) {
        const own = (n.getAttribute('data-ds-appid') || '').trim();
        if (own && own !== id) return true;
        for (const l of n.querySelectorAll('a[href*="/app/"], [data-ds-appid]')) {
            const lid = appIdOf(l);
            if (lid && lid !== id) return true;
        }
        return false;
    }

    function markAI(m) {
        if (!filtering()) {                                  // badge-only: nothing to mark
            if (m.target) { m.target.classList.remove('sgai_ai'); releaseHost(m.target); m.target = null; }
            return;
        }
        // On a game's own app page nearly everything references that app (purchase area, queue
        // widgets, media), so hide targets grow into whole page chunks and strip the page —
        // including its screenshots. Hide only inside "More Like This" there; badges unaffected.
        if (APP_PAGE_ID && !m.el.closest('#recommended_block')) return;
        const t = hideTarget(m.el, m.kind, m.id, m.name);
        // A re-render can move the card boundary — a wrapper we absorbed may since have gained
        // another game. Drop the old tag so the previous target doesn't stay hidden with it.
        if (m.target && m.target !== t) { m.target.classList.remove('sgai_ai'); releaseHost(m.target); }
        m.target = t || null;
        if (!t) return;
        // Blur mode draws its label across the card, so the card has to be the positioning
        // context; without this the label would anchor to whatever ancestor happens to be
        // positioned. Same guard we use for badge hosts: only when nothing is set already.
        if (MODE === 'blur') ensureHost(t);
        t.classList.add('sgai_ai');
    }

    function capBadge(el, text, id, name) {
        // A sale widget carries both a capsule badge and a line under its description; those are
        // two slots on one card, not two attempts at the same one, so they claim separately.
        const kind = badgeKind(el);
        if (!claimCard(el, id, kind === 'desc' ? 'data-sgai-desc' : 'data-sgai-card')) return;
        const m = { el, kind, text, id, name, node: null, host: null, target: null };
        markAI(m);                                           // the target decides where blur puts the badge
        placeBadge(m);
        managed.push(m);
    }

    // Everything this entry put on the page, taken back off it. The scan marks go too: a card
    // React detaches and re-attaches, or recycles for another game, has to be able to come back
    // through scan() — otherwise it stays "already handled" and never gets a badge again.
    function detach(m) {
        if (m.node) m.node.remove();
        if (m.host) releaseHost(m.host);
        if (m.target) { m.target.classList.remove('sgai_ai'); releaseHost(m.target); }
        seen.delete(m.el);
        try { delete m.el.dataset.sgai; delete m.el.dataset.sgaiId; } catch (e) { /* not an element any more */ }
        for (const a of ['data-sgai-card', 'data-sgai-desc', 'data-sgai-err']) {
            const holder = m.el.closest?.(`[${a}~="${m.id}"]`);
            if (!holder) continue;
            const left = (holder.getAttribute(a) || '').split(/\s+/).filter(x => x && x !== m.id);
            left.length ? holder.setAttribute(a, left.join(' ')) : holder.removeAttribute(a);
        }
    }

    // Re-add badges that a React re-render removed while the host is still on the page (e.g. the
    // popup media slideshow drops our node every time the trailer loops). Prunes dead hosts, and
    // drops entries whose node has been recycled for a different game — a virtualized list reuses
    // the same element, and a stale mark would badge an innocent game for good.
    //
    // Runs on every mutation batch, so the steady-state path is deliberately cheap: an entry that
    // is still where we put it costs two isConnected checks and nothing else. Re-deriving the
    // hide target walks ancestors and queries their subtrees, which on a long search page is what
    // turned this into half a second of blocked main thread per batch.
    function heal(force) {
        for (let i = managed.length - 1; i >= 0; i--) {
            const m = managed[i];
            if (!m.el.isConnected) { detach(m); managed.splice(i, 1); continue; }
            const own = appIdOf(m.el);
            if (own && own !== m.id) { detach(m); managed.splice(i, 1); continue; }
            const moved = !placedOk(m);
            if (force || moved) { markAI(m); placeBadge(m); }
            else if (filtering() && (!m.target || !m.target.isConnected)) { markAI(m); placeBadge(m); }
        }
    }

    /* ---------------- listing scanner (lazy, via IntersectionObserver) ---------------- */
    // Entries are unobserved as they are handled, so anything that throws here is never
    // redelivered: one capsule's bad cache row would silently strand the rest of its batch.
    // Mark done first, then guard the work.
    const io = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target, id = el.dataset.sgaiId;
        el.dataset.sgai = 'done';
        if (!validId(id)) return;                              // not an appid we wrote
        try {
            if (!cacheGet(id)) checkBadge(el, true);           // going to the network: show it
            lookup(id).then(d => {
                checkBadge(el, false);
                if (d && d.ai) capBadge(el, d.text, id, d.name);
                else if (d && d.error) errBadge(el, id);
            }).catch(err => { checkBadge(el, false); console.warn('[SteamGameAI] lookup rejected', id, err); });
        } catch (err) { console.warn('[SteamGameAI] scan failed', id, err); }
    }), { rootMargin: ROOT_MARGIN });

    // Yields {el: badge target, id: appid} for every un-processed capsule, across layouts:
    //   • normal store / search capsules carry data-ds-appid
    //   • /sale/ & event pages, hero/spotlight widgets, and hover-preview popups use a React
    //     layout with no data-ds-appid. Every capsule there is an <a href=".../app/<id>"> that
    //     wraps an <img> — so we match that structurally instead of chasing capsule class names
    //     (CapsuleImageCtn, HeroCapsuleImageContainer, ...). Anything already covered by
    //     data-ds-appid is skipped to avoid double-badging.
    // Which nodes have already been through the scanner. Kept off the DOM on purpose: an
    // attribute is copied by cloneNode, so a page that clones a card hands us a "already done"
    // node that never gets a badge. Object identity cannot be cloned. data-sgai is still written
    // alongside, purely so the state is visible when inspecting the page.
    const seen = new WeakSet();
    const fresh = el => !seen.has(el);
    const skip = el => { seen.add(el); el.dataset.sgai = 'skip'; };

    function* candidates() {
        // Discovery Queue & similar "app video" cards: badge the prominent video/capsule area. It has
        // no /app/ link inside — resolve the appid from its capsule image / trailer URL. Yielded first
        // so it wins the per-card de-dupe over the smaller capsule link elsewhere in the card.
        for (const v of document.querySelectorAll('.AppVideoCtn')) {
            if (!fresh(v)) continue;
            const id = widgetAppId(v);
            if (id) yield { el: v, id }; else skip(v);
        }
        for (const el of document.querySelectorAll('[data-ds-appid]')) {
            if (!fresh(el)) continue;
            const id = el.dataset.dsAppid;
            if (/^\d+$/.test(id || '')) yield { el, id }; else skip(el);
        }
        for (const a of document.querySelectorAll('a[href*="/app/"]')) {
            if (!fresh(a)) continue;
            if (a.closest('[data-ds-appid]') || a.querySelector('[data-ds-appid]')) { skip(a); continue; }  // data-ds-appid path handles these
            const m = a.getAttribute('href').match(/\/app\/(\d+)/);
            if (m && a.querySelector('img')) yield { el: a, id: m[1] };                // a capsule, not a text link
            // Review links, breadcrumbs, "more like this" text links: never capsules, and there
            // are thousands of them on a search page. Unmarked, every one was re-tested on every
            // mutation batch. An empty anchor is left alone — it may still be waiting for its image.
            else if (a.textContent.trim()) skip(a);
        }
        // Legacy #global_hover tooltip: no app link or capsule <img>; appid is in the element id.
        for (const h of document.querySelectorAll('[id^="hover_app_"]')) {
            if (!fresh(h)) continue;
            const m = h.id.match(/^hover_app_(\d+)$/);
            if (m) yield { el: h, id: m[1] }; else skip(h);
        }
        // Expanded sale widget: add the marker on its own line under the short description, where
        // it's easy to spot. The description has no app link — resolve the id from the widget.
        for (const desc of document.querySelectorAll('.StoreSaleWidgetShortDesc')) {
            if (!fresh(desc)) continue;
            const id = widgetAppId(desc);
            if (id) yield { el: desc, id }; else skip(desc);
        }
        // Homepage right-column preview panel: title + trailer, but no app link/appid — the id is
        // only in the screenshot/trailer asset URLs, so resolve it the same way as sale widgets.
        for (const p of document.querySelectorAll('.tab_preview')) {
            if (!fresh(p)) continue;
            const id = widgetAppId(p);
            if (id) yield { el: p, id }; else skip(p);
        }
    }

    // Find the app id for an element that has no data-ds-appid or /app/ link (sale widgets, the
    // homepage preview panel) by climbing outward and reading the first Steam asset URL — capsule
    // <img>, CSS background-image, or trailer <source>.
    function widgetAppId(node) {
        for (let el = node, i = 0; el && i < 6; el = el.parentElement, i++) {
            const a = el.querySelector('a[href*="/app/"]');
            let m = a && a.getAttribute('href').match(/\/app\/(\d+)/);
            if (m) return m[1];
            const asset = el.querySelector('img[src*="/apps/"], [data-background-image-url*="/apps/"], [style*="/apps/"], source[src*="/store_trailers/"]');
            if (asset) {
                const s = asset.getAttribute('src') || asset.getAttribute('data-background-image-url') || asset.getAttribute('style') || '';
                m = s.match(/\/apps\/(\d+)\//) || s.match(/\/store_trailers\/(?:steam\/apps\/)?(\d+)\//);
                if (m) return m[1];
            }
        }
        return null;
    }

    function scan() {
        for (const { el, id } of candidates()) {
            seen.add(el);
            el.dataset.sgaiId = id;
            el.dataset.sgai = 'pending';
            io.observe(el);
        }
    }

    // The observer runs in every mode: even in 'skip' it keeps the eye docked, and it re-asserts
    // badges that a React re-render dropped.
    //
    // Pacing matters more than it looks. Steam's home and sale pages animate — a carousel mutates
    // about once a frame — and a rescan tied to the animation frame then sweeps the whole document
    // up to sixty times a second, measured at roughly a fifth of a CPU core with the fan to match.
    // So: ignore batches that are only our own nodes moving, run the first real change straight
    // away, coalesce the rest onto a trailing timer, and lengthen that timer while nothing comes
    // of it. A quiet page settles to nothing; a busy one costs four sweeps a second.
    const SETTLE_MS = 250, IDLE_MS = 1000, IDLE_AFTER = 10;
    let timer = 0, lastRun = 0, fruitless = 0;

    const ourNode = n => n.nodeType === 1 &&
        (n.classList.contains('sgai_badge') || n.classList.contains('sgai_eye') || n.closest('.sgai_eye'));
    function worthLooking(records) {
        if (!records) return true;
        for (const r of records) {
            if (r.target.nodeType === 1 && ourNode(r.target)) continue;
            for (const n of r.addedNodes) if (n.nodeType === 1 && !ourNode(n)) return true;
            for (const n of r.removedNodes) if (n.nodeType === 1 && !ourNode(n)) return true;
        }
        return false;                                        // text ticking over, or just us
    }

    function sweep() {
        timer = 0;
        lastRun = performance.now();
        const had = managed.length;
        if (MODE !== 'skip') scan();
        heal();
        ensureEye();
        onNavigate();        // in case the history hook never fired: some sandboxes patch a copy
        readAppPage();       // still waiting on a pushState arrival
        fruitless = managed.length === had ? fruitless + 1 : 0;
    }

    function rescan(records) {
        if (timer || !worthLooking(records)) return;
        if (document.hidden) return;                         // nothing to see; visibilitychange rearms
        const wait = fruitless > IDLE_AFTER ? IDLE_MS
                   : (performance.now() - lastRun > SETTLE_MS ? 0 : SETTLE_MS);
        timer = setTimeout(sweep, wait);
    }
    addEventListener('visibilitychange', () => { if (!document.hidden) rescan(null); });
    // documentElement, not body: a page that replaces its whole body would otherwise leave the
    // observer bound to a node nothing is attached to any more, and nothing would ever rescan.
    const pageObserver = new MutationObserver(rescan);
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    if (MODE !== 'skip') scan();
    // Prune expired rows once a day, when the page has nothing better to do.
    (window.requestIdleCallback || (fn => setTimeout(fn, 5000)))(() => {
        try { sweepCache(); } catch (e) { console.warn('[SteamGameAI] cache sweep failed', e); }
    });

    /* ---------------- current app page: badge title + seed cache ---------------- */
    // Only seed from a page that really is the game's store page. Steam serves its age check and
    // its region/unavailable notices at the same /app/<id>/ URL, and those parse as "no
    // disclosure" — seeding from one would overwrite a correct hit with a wrong miss for a week.
    // A pushState arrives before the page it navigates to has rendered, so this cannot be a
    // one-shot: it stays pending until the app page's own markup actually turns up, and the
    // sweep retries it. Gated and unavailable pages never satisfy it, which is the point.
    let appPageRead = false;
    function readAppPage() {
        if (!APP_PAGE_ID || appPageRead) return;
        try {
            const gated = document.querySelector('#app_agegate, .agegate_birthday_selector, .agegate_text_container');
            const real = document.querySelector('#appHubAppName, .apphub_AppName');
            if (!real || gated) return;
            const d = getDisclosure(document);
            d.name = appName(document);
            cacheSet(APP_PAGE_ID, d);
            if (d.ai) titleBadge(d.text);
            appPageRead = true;
        } catch (e) { console.warn('[SteamGameAI] could not read this app page', e); }
    }
    readAppPage();

    // A pushState is the only signal that the page became a different page. Re-read what depends
    // on the path, then re-assert every badge: what counts as a card, and whether hiding is
    // allowed at all, are decided differently on a game's own page.
    function onNavigate() {
        const now = appIdFromPath();
        if (now === APP_PAGE_ID) return;
        APP_PAGE_ID = now;
        appPageRead = false;
        readAppPage();
        heal(true);
    }
    // Best effort, and deliberately not the only signal — see the sweep, which also checks.
    for (const name of ['pushState', 'replaceState']) {
        const real = history[name];
        if (typeof real !== 'function') continue;
        history[name] = function (...args) {
            const out = real.apply(this, args);
            try { onNavigate(); } catch (e) { console.warn('[SteamGameAI] navigation hook failed', e); }
            return out;
        };
    }
    addEventListener('popstate', onNavigate);

    /* ---------------- eye toggle in Steam's global header ---------------- */
    // One control for every mode, on the page itself — the same eye the VRChat script uses, so
    // nothing has to be toggled from the userscript manager's menu.
    const EYE = {
        skip:  { open: false, label: 'listings not checked' },
        badge: { open: true,  label: 'badge disclosed games' },
        blur:  { open: true,  label: 'blur disclosed games until hovered' },
        hide:  { open: false, label: 'hide disclosed games' },
    };
    const EYE_SVG = {
        open: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 9C14 9 5.46 15.22 2 24c3.46 8.78 12 15 22 15 10.01 0 18.54-6.22 22-15-3.46-8.78-11.99-15-22-15zm0 25c-5.52 0-10-4.48-10-10s4.48-10 10-10 10 4.48 10 10-4.48 10-10 10zm0-16c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/></svg>',
        shut: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 14c5.52 0 10 4.48 10 10 0 1.29-.26 2.52-.71 3.65l5.85 5.85c3.02-2.52 5.4-5.78 6.87-9.5-3.47-8.78-12-15-22.01-15-2.8 0-5.48.5-7.97 1.4l4.32 4.31c1.13-.44 2.36-.71 3.65-.71zM4 8.55l4.56 4.56.91.91C6.17 16.6 3.56 20.03 2 24c3.46 8.78 12 15 22 15 3.1 0 6.06-.6 8.77-1.69l.85.85L39.45 44 42 41.46 6.55 6 4 8.55zM15.06 19.6l3.09 3.09c-.09.43-.15.86-.15 1.31 0 3.31 2.69 6 6 6 .45 0 .88-.06 1.3-.15l3.09 3.09C27.06 33.6 25.58 34 24 34c-5.52 0-10-4.48-10-10 0-1.58.4-3.06 1.06-4.4zm8.61-1.57 6.3 6.3L30 24c0-3.31-2.69-6-6-6l-.33.03z"/></svg>',
    };
    const nextMode = () => MODES[(MODES.indexOf(MODE) + 1) % MODES.length];
    let eye = null;

    function syncEye() {
        if (!eye) return;
        eye.dataset.mode = MODE;
        eye.innerHTML = EYE_SVG[EYE[MODE].open ? 'open' : 'shut'];
        eye.title = `AI disclosure: ${EYE[MODE].label}\nClick to cycle — next: ${EYE[nextMode()].label}\n\n— ${SIGNATURE}`;
    }

    // A selector list returns the first match in DOCUMENT order, and #global_header .content is an
    // ancestor of both other hosts — it would always win, so the candidates are tried in order.
    const findEyeHost = () => ['#global_action_menu', '#global_actions', '#global_header .content']
        .map(sel => document.querySelector(sel)).find(Boolean);

    // The header is server-rendered, but a React page can re-render around it; rescan() calls this
    // so a dropped button comes back.
    function ensureEye() {
        // Without our stylesheet this div is a full-width block, and prepending it to the header
        // pushes the store's own content down the page — measured at ~900px, which drops every
        // capsule out of the observer's reach. A missing button beats a broken page.
        if (!STYLES_OK) return;
        if (eye && eye.isConnected) {
            // A React layout can render its header after we gave up and floated the button in the
            // corner. Take the header now rather than sit on top of it for the rest of the session.
            if (!eye.classList.contains('sgai_eye_float')) return;
            const late = findEyeHost();
            if (!late) return;
            eye.classList.remove('sgai_eye_float');
            late.prepend(eye);
            alignEye();
            return;
        }
        eye = document.createElement('div');
        lastShift = null;                                    // fresh element, nothing applied yet
        eye.className = 'sgai_eye';
        eye.setAttribute('role', 'button');
        eye.setAttribute('tabindex', '0');
        eye.addEventListener('click', () => setMode(nextMode()));
        eye.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            setMode(nextMode());
        });
        dockEye();
    }

    // Is the button actually where a person can see and click it? Steam's header is not ours and
    // can clip, collapse or cover what we put in it, and a button that exists in the DOM but not
    // on screen is the same as no button at all.
    function eyeVisible() {
        if (!eye || !eye.isConnected) return false;
        const cs = getComputedStyle(eye);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
        const r = eye.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;                       // collapsed or clipped
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return !!hit && (hit === eye || eye.contains(hit));                  // or something covers it
    }

    // Prefer the header; fall back to the corner — but only after checking, and only after giving
    // the header a fair chance to finish laying itself out. A header that is merely late looks
    // exactly like one that swallowed the button, so the difference is decided by retrying rather
    // than by guessing from its box.
    const DOCK_TRIES = 3, DOCK_RETRY_MS = 500;
    let dockFailed = false, dockTries = 0, dockTimer = 0;
    function dockEye() {
        const host = dockFailed ? null : findEyeHost();
        if (host) {
            eye.classList.remove('sgai_eye_float');
            host.prepend(eye);
            syncEye();
            alignEye();
            if (eyeVisible()) { dockTries = 0; return; }
            if (++dockTries < DOCK_TRIES) {                  // still settling? look again shortly
                if (!dockTimer) dockTimer = setTimeout(() => { dockTimer = 0; dockEye(); }, DOCK_RETRY_MS);
                return;
            }
            dockFailed = true;                               // the header is real, and it hid us
            console.warn('[SteamGameAI] the header will not show the eye button; moving it to the corner');
        }
        eye.classList.add('sgai_eye_float');
        setEyeShift(0);
        document.body.appendChild(eye);
        syncEye();
    }

    // The header lays its items out with floats, which stack from the top edge — our button is
    // taller than a text link, so it hangs below their centre line, by a different amount in the
    // logged-in and logged-out headers. Rather than guess a margin, measure a real sibling and
    // nudge onto its centre with a transform, which moves the button without disturbing the
    // layout that was just measured. (Same measure-a-neighbour trick as the VRChat script.)
    function alignEye() {
        if (!eye || !eye.isConnected || eye.classList.contains('sgai_eye_float')) return;
        setEyeShift(0);                                      // measure untransformed
        const sib = [...eye.parentElement.children].find(n => {
            if (n === eye) return false;
            const pos = getComputedStyle(n).position;
            if (pos === 'absolute' || pos === 'fixed') return false;   // an open dropdown, not a row item
            return n.getBoundingClientRect().height > 0;
        });
        if (!sib) return;                                    // nothing to line up with
        const mine = eye.getBoundingClientRect(), theirs = sib.getBoundingClientRect();
        if (!mine.height || !theirs.height) return;          // header not laid out yet
        setEyeShift(Math.round((theirs.top + theirs.height / 2) - (mine.top + mine.height / 2)));
    }

    // An inline style is the cheap way to move one element; writing into a live stylesheet
    // invalidates style for the whole document, measured at about a hundred times the cost per
    // write. So use the element when the page allows inline styles at all, and keep the sheet for
    // the CSP case where a style attribute is refused.
    const INLINE_STYLES_OK = (() => {
        try {
            const t = document.createElement('span');
            t.style.letterSpacing = '3px';
            (document.body || document.documentElement).appendChild(t);
            const ok = getComputedStyle(t).letterSpacing === '3px';
            t.remove();
            return ok;
        } catch (e) { return false; }
    })();

    let alignRule = null, lastShift = null;
    function setEyeShift(px) {
        if (px === lastShift) return;                        // the common case: nothing moved
        lastShift = px;
        const value = px ? `translateY(${px}px)` : '';
        if (INLINE_STYLES_OK && eye) { eye.style.transform = value; return; }
        if (SHEET) {
            try {
                if (!alignRule) {
                    const i = SHEET.insertRule('.sgai_eye{}', SHEET.cssRules.length);
                    alignRule = SHEET.cssRules[i];
                }
                alignRule.style.transform = value;
                return;
            } catch (e) { alignRule = null; }                // sheet went away; fall through
        }
        if (eye) eye.style.transform = value;
    }

    ensureEye();
    // The avatar image and Motiva Sans both land after document-idle and move the header's items,
    // so re-centre once the page has settled, and again whenever the layout changes. At
    // document-idle on a cached page `load` has often already fired, so check before waiting.
    if (document.readyState === 'complete') alignEye(); else addEventListener('load', alignEye);
    // Resize fires continuously while a window edge is dragged; one alignment per frame is plenty.
    let alignFrame = 0;
    const alignSoon = () => {
        if (alignFrame) return;
        alignFrame = requestAnimationFrame(() => { alignFrame = 0; alignEye(); });
    };
    addEventListener('resize', alignSoon);
    try { document.fonts?.ready.then(alignEye); } catch (e) { /* no FontFaceSet */ }
    // The header's own items change size after we align — an avatar image arrives, a cart count
    // appears — and nothing else would tell us. Measured 11px off-centre until the next resize.
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(alignSoon);
        const watchHeader = () => { if (eye?.parentElement) { ro.disconnect(); ro.observe(eye.parentElement); } };
        watchHeader();
        addEventListener('load', watchHeader);
    }

    /* ---------------- menu ---------------- */
    // Modes live on the eye button; only the cache reset is left with nowhere better to sit.
    if (typeof GM_registerMenuCommand === 'function') {
        // The eye owns this normally, but it stands down when the page blocks our styles — and a
        // user left in hide mode with no visible control has no way back.
        GM_registerMenuCommand(`AI-disclosed games: ${EYE[MODE].label} — cycle`, () => {
            setMode(nextMode());
            alert(`AI-disclosed games: ${EYE[MODE].label}.\n(The menu label updates on the next page load.)`);
        });
        GM_registerMenuCommand('Clear AI disclosure cache', () => {
            if (typeof GM_listValues !== 'function') {        // not every manager has it
                alert('This userscript manager cannot list stored values, so the cache can only be\ncleared from its own storage editor.');
                return;
            }
            let gone = 0;
            (GM_listValues() || []).forEach(k => { if (/^sgai:\d+$/.test(k)) { GM_deleteValue(k); gone++; } });  // appid caches only
            GM_deleteValue('sgai:swept');
            alert(`Steam AI cache cleared (${gone} entries).`);
        });
    }
})();
