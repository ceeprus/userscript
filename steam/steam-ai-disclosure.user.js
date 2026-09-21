// ==UserScript==
// @name         Steam AI Content Disclosure Badge
// @namespace    https://github.com/ceeprus/userscript
// @version      2.12
// @description  Flags Steam games that carry an "AI Generated Content Disclosure" — a badge by the title on app pages, an overlay on capsules everywhere (store home, search, recommendations, /sale/ event pages, the personal calendar, hover popups), and a line under the description in expanded sale widgets. An eye button in Steam's header cycles what listings do with a disclosed game: nothing, badge, blur until hovered, or hide it.
// @author       ceeprus
// @homepage     https://github.com/ceeprus/userscript
// @icon         https://www.google.com/s2/favicons?sz=64&domain=store.steampowered.com
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @supportURL   https://github.com/ceeprus/userscript/issues
// @match        https://store.steampowered.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
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
    const APP_PAGE_ID = (location.pathname.match(/^\/app\/(\d+)/) || [])[1] || null;  // viewing a game's own page

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
        .sgai_cap{position:absolute;top:4px;left:4px;z-index:50;pointer-events:auto;}
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
        document.body.appendChild(t);
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

    // One badge per card: hover-preview popups (and some widgets) contain several links to the
    // same app — media block, header capsule, title. Claim the smallest ancestor that groups more
    // than one link to this app id, so only the first capsule in it gets marked. Returns false
    // when this card was already claimed under `attr`.
    function claimCard(el, id, attr) {
        if (el.closest(`[${attr}~="${id}"]`)) return false;
        let root = el;
        for (let n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
            if (n.querySelectorAll(`a[href*="/app/${id}"]`).length > 1) { root = n; break; }
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
        if (!on) { if (had) had.remove(); return; }
        if (!filtering() || had) return;
        if (getComputedStyle(el).position === 'static') el.classList.add('sgai_host');
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
        if (getComputedStyle(el).position === 'static') el.classList.add('sgai_host');
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

    function placeBadge(el, kind, text) {
        if (kind === 'title') {                                  // hover tooltip / homepage preview: next to title
            const target = el.matches('.hover_title, .tab_title') ? el : el.querySelector('.hover_title, .tab_title');
            if (!target || target.querySelector('.sgai_cap')) return;
            const b = makeBadge(text); b.classList.add('sgai_cap', 'sgai_inline'); target.appendChild(b);
        } else if (kind === 'desc') {                           // sale widget: its own line under the description
            if (el.nextElementSibling && el.nextElementSibling.classList.contains('sgai_cap')) return;
            const b = makeBadge(text); b.classList.add('sgai_cap', 'sgai_desc');
            el.after(b);
        } else {                                                 // capsule corner overlay
            if (el.querySelector(':scope > .sgai_cap')) return;
            if (getComputedStyle(el).position === 'static') el.classList.add('sgai_host');
            const b = makeBadge(text); b.classList.add('sgai_cap'); el.appendChild(b);
        }
    }

    function badgeKind(el) {
        if (el.matches('.hover_title, .tab_preview') || el.querySelector('.hover_title, .tab_title')) return 'title';
        if (el.matches('.StoreSaleWidgetShortDesc')) return 'desc';
        return 'corner';
    }

    // The element blur and hide mode act on — the game's whole card, not just the capsule
    // anchor. In the React store layouts (home sale widgets, /sale/ pages) the /app/
    // anchor is only the capsule image; the title, tags, description and buttons are siblings,
    // so we grow outward from the capsule. Three things stop that growth, in order:
    //   • a container holding another game (foreignApp) — keeps carousel slides and grids safe;
    //   • a container named for this app (appScoped) — that is exactly one game's card;
    //   • an ancestor that adds text of its own: if it adds this game's name it is the card and
    //     we take it, otherwise the text belongs to the page (a calendar date, a section
    //     heading, curator navigation) and the card ended one level below.
    // Ancestors that add no text at all are pure layout wrappers and get absorbed, so hiding a
    // game doesn't leave an empty slot behind in a grid.
    //
    // HIDE_STOP is the backstop: page shells that are never a game card, so even a layout none
    // of the rules above fit can't cost the page its own chrome. .page_content_ctn and
    // .creator_grid_ctn are the curator/creator page bodies; the rest are the store-wide frame.
    const HIDE_STOP = 'body, main, #StoreTemplate, #responsive_page_template_content, [data-featuretarget],' +
        '.responsive_page_frame, .responsive_page_content, #page_background_container, .page_content_ctn, .creator_grid_ctn';
    function hideTarget(el, kind, id, name) {
        if (kind === 'title') return null;
        let t = el.closest('a[href*="/app/"]') || el.closest('[data-ds-appid]') || el;
        let scoped = false;                                  // saw a container named for this app
        const want = norm(name) || norm(capsuleAlt(t));       // this game's name, for the card test
        let named = !!want && norm(t.textContent).includes(want);
        for (let n = t.parentElement, i = 0; n && i < 8 && !n.matches(HIDE_STOP); n = n.parentElement, i++) {
            if (foreignApp(n, id)) break;
            if (appScoped(n, id)) { t = n; scoped = true; continue; }
            if (scoped) break;                               // past that container: page furniture
            if (norm(n.textContent) !== norm(t.textContent)) {   // this ancestor adds text of its own
                if (named || !want) break;                   // not this game's: a label, heading, nav
                if (!norm(n.textContent).includes(want)) break;
                return n;                                    // the game's name: the card ends here
            }
            t = n;                                           // adds nothing: a wrapper, absorb it
        }
        return t;
    }

    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const capsuleAlt = el => {
        const img = el.matches('img') ? el : el.querySelector('img[alt]:not([alt=""])');
        return (img && img.getAttribute('alt')) || el.getAttribute('aria-label') || '';
    };

    // Is this container named for this app — e.g. the curator page's #app-ctn-<appid>? Such an id
    // marks exactly one game's card, so it is the hide target and growth stops there. Without it,
    // a page showing a single game (a curator with one recommendation, a calendar day with one
    // release) never trips foreignApp and growth runs to the level cap, taking the page with it.
    // Ids and data-* only: React's hashed class names carry digit runs that can collide with a
    // short appid.
    function appScoped(n, id) {
        const s = `${n.id} ${n.getAttribute('data-ds-appid') || ''} ${n.getAttribute('data-appid') || ''}`;
        return new RegExp(`(^|\\D)${id}(\\D|$)`).test(s);
    }

    // Does this container reference any app other than `id`?
    function foreignApp(n, id) {
        const own = n.getAttribute('data-ds-appid');
        if (own && own !== id) return true;
        for (const l of n.querySelectorAll('a[href*="/app/"], [data-ds-appid]')) {
            const lid = l.getAttribute('data-ds-appid') || ((l.getAttribute('href') || '').match(/\/app\/(\d+)/) || [])[1];
            if (lid && lid !== id) return true;
        }
        return false;
    }

    function markAI(m) {
        // On a game's own app page nearly everything references that app (purchase area, queue
        // widgets, media), so hide targets grow into whole page chunks and strip the page —
        // including its screenshots. Hide only inside "More Like This" there; badges unaffected.
        if (APP_PAGE_ID && !m.el.closest('#recommended_block')) return;
        const t = hideTarget(m.el, m.kind, m.id, m.name);
        // A re-render can move the card boundary — a wrapper we absorbed may since have gained
        // another game. Drop the old tag so the previous target doesn't stay hidden with it.
        if (m.hidden && m.hidden !== t) m.hidden.classList.remove('sgai_ai');
        m.hidden = t || null;
        if (!t) return;
        // Blur mode draws its label across the card, so the card has to be the positioning
        // context; without this the label would anchor to whatever ancestor happens to be
        // positioned. Same guard we use for badge hosts: only when nothing is set already.
        if (MODE === 'blur' && getComputedStyle(t).position === 'static') t.classList.add('sgai_host');
        t.classList.add('sgai_ai');
    }

    function capBadge(el, text, id, name) {
        if (!claimCard(el, id, 'data-sgai-card')) return;
        const kind = badgeKind(el);
        const m = { el, kind, text, id, name, hidden: null };
        placeBadge(el, kind, text);
        markAI(m);
        managed.push(m);
    }

    // Re-add badges that a React re-render removed while the host is still on the page (e.g. the
    // popup media slideshow drops our node every time the trailer loops). Prunes dead hosts.
    function heal() {
        for (let i = managed.length - 1; i >= 0; i--) {
            const m = managed[i];
            if (!m.el.isConnected) { managed.splice(i, 1); continue; }
            placeBadge(m.el, m.kind, m.text);
            markAI(m);
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
    function* candidates() {
        // Discovery Queue & similar "app video" cards: badge the prominent video/capsule area. It has
        // no /app/ link inside — resolve the appid from its capsule image / trailer URL. Yielded first
        // so it wins the per-card de-dupe over the smaller capsule link elsewhere in the card.
        for (const v of document.querySelectorAll('.AppVideoCtn:not([data-sgai])')) {
            const id = widgetAppId(v);
            if (id) yield { el: v, id }; else v.dataset.sgai = 'skip';
        }
        for (const el of document.querySelectorAll('[data-ds-appid]:not([data-sgai])')) {
            const id = el.dataset.dsAppid;
            if (/^\d+$/.test(id || '')) yield { el, id }; else el.dataset.sgai = 'skip';
        }
        for (const a of document.querySelectorAll('a[href*="/app/"]:not([data-sgai])')) {
            if (a.closest('[data-ds-appid]') || a.querySelector('[data-ds-appid]')) { a.dataset.sgai = 'skip'; continue; }  // data-ds-appid path handles these
            const m = a.getAttribute('href').match(/\/app\/(\d+)/);
            if (m && a.querySelector('img')) yield { el: a, id: m[1] };                // a capsule, not a text link
        }
        // Legacy #global_hover tooltip: no app link or capsule <img>; appid is in the element id.
        for (const h of document.querySelectorAll('[id^="hover_app_"]:not([data-sgai])')) {
            const m = h.id.match(/^hover_app_(\d+)$/);
            if (m) yield { el: h, id: m[1] }; else h.dataset.sgai = 'skip';
        }
        // Expanded sale widget: add the marker on its own line under the short description, where
        // it's easy to spot. The description has no app link — resolve the id from the widget.
        for (const desc of document.querySelectorAll('.StoreSaleWidgetShortDesc:not([data-sgai])')) {
            const id = widgetAppId(desc);
            if (id) yield { el: desc, id }; else desc.dataset.sgai = 'skip';
        }
        // Homepage right-column preview panel: title + trailer, but no app link/appid — the id is
        // only in the screenshot/trailer asset URLs, so resolve it the same way as sale widgets.
        for (const p of document.querySelectorAll('.tab_preview:not([data-sgai])')) {
            const id = widgetAppId(p);
            if (id) yield { el: p, id }; else p.dataset.sgai = 'skip';
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
            el.dataset.sgaiId = id;
            el.dataset.sgai = 'pending';
            io.observe(el);
        }
    }

    // The observer runs in every mode: even in 'skip' it keeps the eye docked, and it re-asserts
    // badges that a React re-render dropped.
    let pending = false;
    const rescan = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (MODE !== 'skip') scan();
            heal();
            ensureEye();
        });
    };
    if (document.body) new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
    if (MODE !== 'skip') scan();
    // Prune expired rows once a day, when the page has nothing better to do.
    (window.requestIdleCallback || (fn => setTimeout(fn, 5000)))(() => {
        try { sweepCache(); } catch (e) { console.warn('[SteamGameAI] cache sweep failed', e); }
    });

    /* ---------------- current app page: badge title + seed cache ---------------- */
    // Only seed from a page that really is the game's store page. Steam serves its age check and
    // its region/unavailable notices at the same /app/<id>/ URL, and those parse as "no
    // disclosure" — seeding from one would overwrite a correct hit with a wrong miss for a week.
    if (APP_PAGE_ID) {
        try {
            const gated = document.querySelector('#app_agegate, .agegate_birthday_selector, .agegate_text_container');
            const real = document.querySelector('#appHubAppName, .apphub_AppName');
            if (real && !gated) {
                const d = getDisclosure(document);
                d.name = appName(document);
                cacheSet(APP_PAGE_ID, d);
                if (d.ai) titleBadge(d.text);
            }
        } catch (e) { console.warn('[SteamGameAI] could not read this app page', e); }
    }

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

    // The header is server-rendered, but a React page can re-render around it; rescan() calls this
    // so a dropped button comes back.
    function ensureEye() {
        // Without our stylesheet this div is a full-width block, and prepending it to the header
        // pushes the store's own content down the page — measured at ~900px, which drops every
        // capsule out of the observer's reach. A missing button beats a broken page.
        if (!STYLES_OK) return;
        if (eye && eye.isConnected) return;
        eye = document.createElement('div');
        eye.className = 'sgai_eye';
        eye.setAttribute('role', 'button');
        eye.setAttribute('tabindex', '0');
        eye.addEventListener('click', () => setMode(nextMode()));
        eye.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            setMode(nextMode());
        });
        const host = ['#global_action_menu', '#global_actions', '#global_header .content']
            .map(sel => document.querySelector(sel)).find(Boolean);
        if (host) host.prepend(eye);
        else { eye.classList.add('sgai_eye_float'); document.body.appendChild(eye); }
        syncEye();
        alignEye();
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

    // Written as a rule in our own sheet rather than onto the element: a page whose CSP forbids
    // inline styles blocks a style attribute but not a stylesheet we own.
    let alignRule = null;
    function setEyeShift(px) {
        const value = px ? `translateY(${px}px)` : '';
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
    addEventListener('resize', alignEye);
    try { document.fonts?.ready.then(alignEye); } catch (e) { /* no FontFaceSet */ }

    /* ---------------- menu ---------------- */
    // Modes live on the eye button; only the cache reset is left with nowhere better to sit.
    if (typeof GM_registerMenuCommand === 'function') {
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
