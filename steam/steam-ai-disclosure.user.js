// ==UserScript==
// @name         Steam AI Content Disclosure Badge
// @namespace    https://github.com/ceeprus/userscript
// @version      2.10
// @description  Flags Steam games that carry an "AI Generated Content Disclosure" — a badge by the title on app pages, an overlay on capsules everywhere (store home, search, recommendations, /sale/ event pages, the personal calendar, hover popups), and a line under the description in expanded sale widgets. Disclosed games can also be blurred until hovered, or hidden outright.
// @author       ceeprus
// @homepage     https://github.com/ceeprus/userscript
// @icon         https://www.google.com/s2/favicons?sz=64&domain=store.steampowered.com
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
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
    let   SCAN_LISTINGS = GM_getValue('sgai:scan', true);    // capsule badges on/off (toggle via menu)

    // What to do with an AI-disclosed game in a listing, beyond badging it (cycle via menu):
    //   'off'  — badge only
    //   'blur' — blur the card until hovered; it keeps its space, so no layout can break
    //   'hide' — remove the card from the page
    const MODES = ['off', 'blur', 'hide'];
    let MODE = GM_getValue('sgai:mode', null) || (GM_getValue('sgai:hide', false) ? 'hide' : 'off');
    if (!MODES.includes(MODE)) MODE = 'off';
    function applyMode() {
        const r = document.documentElement;
        r.toggleAttribute('data-sgai-hide', MODE === 'hide');
        r.toggleAttribute('data-sgai-blur', MODE === 'blur');
    }
    applyMode();
    const APP_PAGE_ID = (location.pathname.match(/^\/app\/(\d+)/) || [])[1] || null;  // viewing a game's own page

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
    // Accent color of the badge (text + icon + border). Swap to the red pair for a warning look:
    //   amber (default): '#ffce5c' / 'rgba(255,206,92,.55)'
    //   warning red:     '#ff5d5d' / 'rgba(255,93,93,.55)'
    const ACCENT = '#ffce5c';
    const ACCENT_BORDER = 'rgba(255,206,92,.55)';

    // "No-AI" circle-slash icon (scales with the badge font via em units).
    const ICON = '<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';

    (GM_addStyle || (css => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }))(`
        .sgai_badge{display:inline-flex;align-items:center;gap:4px;font:700 13px/1 "Motiva Sans",Arial,sans-serif;
            color:${ACCENT};background:rgba(18,18,22,.88);border:1px solid ${ACCENT_BORDER};
            border-radius:4px;padding:3px 6px;vertical-align:middle;white-space:nowrap;}
        .sgai_title{margin-left:10px;cursor:pointer;}
        .sgai_title:hover{background:rgba(255,206,92,.18);}
        .sgai_cap{position:absolute;top:6px;left:6px;z-index:50;padding:2px 5px;font-size:12px;
            box-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:auto;}
        .sgai_inline{position:static;top:auto;left:auto;margin-left:8px;box-shadow:none;vertical-align:middle;cursor:default;}
        .sgai_desc{position:static;top:auto;left:auto;margin-top:8px;box-shadow:none;}
        .sgai_host{position:relative;}
        .sgai_err{color:#9aa4ad;border-color:rgba(154,164,173,.45);opacity:.75;font-size:11px;}
        [data-sgai-hide] .sgai_ai{display:none !important;}
        /* Blur mode: blur the card's contents, not the card, so nothing reflows and our own badge
           stays legible on top. Hovering reveals the game. */
        [data-sgai-blur] .sgai_ai:not(:hover) > *:not(.sgai_cap){filter:blur(10px);}
        [data-sgai-blur] .sgai_ai:not(:hover){background:rgba(18,18,22,.25);}
    `);

    /* ---------------- cache (GM storage) ---------------- */
    const key = id => 'sgai:' + id;
    function cacheGet(id) {
        const v = GM_getValue(key(id), null);
        if (!v) return null;
        if (!('name' in v)) return null;                      // pre-2.9 entry, no game name: refetch once
        if (Date.now() - v.ts > (v.ai ? TTL_AI : TTL_NONE)) return null;
        return v;
    }
    const cacheSet = (id, d) =>
        GM_setValue(key(id), { ai: !!d.ai, text: d.text || null, name: d.name || null, ts: Date.now() });

    /* ---------------- parse disclosure out of a document ---------------- */
    function getDisclosure(root) {
        const h2 = [...root.querySelectorAll('h2')].find(h => TITLE_SET.has(h.textContent.trim()));
        if (!h2) return { ai: false, text: null };
        const box = h2.closest('#game_area_content_descriptors') || h2.parentElement;
        let text = '';
        box.childNodes.forEach(n => { if (n !== h2) text += (n.textContent || '') + ' '; });
        text = text.replace(/\s+/g, ' ').trim();
        const ci = text.indexOf(':');                       // drop "The developers describe ... like this:" intro
        if (ci > -1 && ci < 160) text = text.slice(ci + 1).trim();
        return { ai: true, text: text || null };
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
    let active = 0; const queue = [];
    const slot = () => new Promise(r => { active < MAX_CONCURRENT ? (active++, r()) : queue.push(r); });
    const release = () => { active--; const n = queue.shift(); if (n) { active++; n(); } };

    // Mature/adult app pages serve an age-check interstitial that has no disclosure section, so they'd
    // be misread as "no AI". Setting the standard age cookies (lazily, only once we actually hit a gate)
    // lets the retry read the real page. Controlled by BYPASS_AGE_GATE.
    let ageCookiesSet = false;
    function setAgeCookies() {
        if (ageCookiesSet) return;
        ageCookiesSet = true;
        const opts = '; path=/; domain=.steampowered.com; max-age=31536000; SameSite=Lax';
        document.cookie = 'birthtime=631152001' + opts;             // 1 Jan 1990
        document.cookie = 'lastagecheckage=1-January-1990' + opts;
        document.cookie = 'wants_mature_content=1' + opts;
    }
    const isAgeGate = (url, html) => url.includes('/agecheck') || /agegate_birthday|app_agegate|agegate_text_container/.test(html);

    async function fetchAppPage(id) {
        const url = `https://store.steampowered.com/app/${id}/?l=english&cc=us`;
        let res = await fetch(url);
        let html = await res.text();
        if (BYPASS_AGE_GATE && isAgeGate(res.url, html)) {
            setAgeCookies();
            res = await fetch(url, { cache: 'reload' });
            html = await res.text();
        }
        return html;
    }

    const inflight = new Map();
    function lookup(id) {
        const c = cacheGet(id);
        if (c) return Promise.resolve(c);
        if (inflight.has(id)) return inflight.get(id);
        const p = (async () => {
            await slot();
            try {
                const html = await fetchAppPage(id);
                // Most games carry no disclosure, and an app page is megabytes: test the raw text
                // for any of the localized headings first and skip building a DOM for the misses.
                // (Idea from seeeeew/aiwarningforsteam, which matches the heading in raw HTML.)
                if (!TITLES.some(t => html.includes(t))) {
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
            } finally { release(); inflight.delete(id); }
        })();
        inflight.set(id, p);
        return p;
    }

    /* ---------------- badges ---------------- */
    function makeBadge(text) {
        const b = document.createElement('span');
        b.className = 'sgai_badge';
        b.innerHTML = ICON + 'AI';
        if (text) b.title = text;
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

    // A lookup that failed leaves a game looking clean, which matters once a filter is on: the
    // game stays visible as if it had been checked and cleared. Mark those so the gap is visible
    // (idea from seeeeew/aiwarningforsteam, which flags failed search-row checks).
    function errBadge(el, id) {
        if (MODE === 'off' || !el.isConnected) return;
        if (badgeKind(el) === 'desc') return;                    // the capsule of this card carries it
        if (!claimCard(el, id, 'data-sgai-err')) return;
        if (getComputedStyle(el).position === 'static') el.classList.add('sgai_host');
        const b = makeBadge(`AI disclosure check failed for app ${id} — this game was not verified`);
        b.classList.add('sgai_cap', 'sgai_err');
        b.innerHTML = ICON + '?';
        el.appendChild(b);
    }

    function titleBadge(text) {
        const t = document.querySelector('#appHubAppName');
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
        if (t) t.classList.add('sgai_ai');
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
    const io = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target, id = el.dataset.sgaiId;
        lookup(id).then(d => {
            if (d && d.ai) capBadge(el, d.text, id, d.name);
            else if (d && d.error) errBadge(el, id);
        });
        el.dataset.sgai = 'done';
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

    if (SCAN_LISTINGS) {
        let pending = false;
        const rescan = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; scan(); heal(); }); };
        new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
        scan();
    }

    /* ---------------- current app page: badge title + seed cache ---------------- */
    if (APP_PAGE_ID) {
        const d = getDisclosure(document);
        d.name = appName(document);
        cacheSet(APP_PAGE_ID, d);
        if (d.ai) titleBadge(d.text);
    }

    /* ---------------- menu ---------------- */
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Clear AI disclosure cache', () => {
            (GM_listValues() || []).forEach(k => { if (/^sgai:\d+$/.test(k)) GM_deleteValue(k); });  // appid caches only
            alert('Steam AI cache cleared.');
        });
        const LABEL = { off: 'badge only', blur: 'blur until hovered', hide: 'hide' };
        GM_registerMenuCommand(`AI-disclosed games: ${LABEL[MODE]} — cycle`, () => {
            MODE = MODES[(MODES.indexOf(MODE) + 1) % MODES.length];
            GM_setValue('sgai:mode', MODE);
            applyMode();                                                  // applies instantly
            alert(`AI-disclosed games: ${LABEL[MODE]}.\n(Menu label updates on next page load.)`);
        });
        GM_registerMenuCommand(`Capsule badges: ${SCAN_LISTINGS ? 'ON' : 'OFF'} — toggle & reload`, () => {
            GM_setValue('sgai:scan', !SCAN_LISTINGS);
            location.reload();
        });
    }
})();
