// ==UserScript==
// @name         Steam AI Content Disclosure Badge
// @namespace    https://github.com/ceeprus/userscript
// @version      2.41
// @description  Flags Steam games that carry an "AI Generated Content Disclosure": a badge by the title on app pages (click it to jump to the disclosure), an overlay on capsules everywhere, and a line under the description in expanded sale widgets. An eye button in Steam's header cycles what listings do with a disclosed game: nothing, badge, blur until hovered, or hide it. A second eye hides games you pick yourself: point at a game and click the crossed-out eye beside its name. Both eyes follow you down the page.
// @author       ceeprus
// @homepage     https://github.com/ceeprus/userscript
// @icon         data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%3Crect%20width='64'%20height='64'%20rx='10'%20fill='%23171a21'/%3E%3Ctext%20x='32'%20y='43'%20font-family='Arial,sans-serif'%20font-size='30'%20font-weight='bold'%20fill='%23ffce5c'%20text-anchor='middle'%3EAI%3C/text%3E%3C/svg%3E
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-ai-disclosure.user.js
// @supportURL   https://github.com/ceeprus/userscript/issues
// @match        https://store.steampowered.com/*
// @exclude      https://store.steampowered.com/checkout/*
// @exclude      https://store.steampowered.com/login/*
// @exclude      https://store.steampowered.com/join/*
// @exclude      https://store.steampowered.com/account/*
// @run-at       document-start
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

    // Tweakables
    const TTL_AI       = 30 * 24 * 60 * 60 * 1000;           // cache life for "has AI" results
    const TTL_NONE     =  7 * 24 * 60 * 60 * 1000;           // cache life for "no AI" (devs can add it later)
    const MAX_CONCURRENT = 3;                                // parallel background fetches
    const ROOT_MARGIN  = '300px';                            // how early to check capsules before they scroll in
    const BYPASS_AGE_GATE = true;                            // set age cookies so mature/adult game pages can be read
    const FETCH_TIMEOUT = 15000;                             // give up on a stalled app-page read
    const MAX_BYTES    = 8e6;                                // refuse an app page bigger than this
    const MAX_TEXT     = 400;                                // cap the disclosure text we keep
    const SWEEP_EVERY  = 24 * 60 * 60 * 1000;                // prune expired cache rows once a day

    // Declared up here because the stored lists are read before anything else, and a `const` used
    // above its own line is a dead script, not a warning.
    const validId = id => /^\d+$/.test(String(id));

    // What listings do with an AI-disclosed game, cycled by the header eye: skip (no lookups at all),
    // badge, blur (badge and blur until hovered; keeps its space) or hide (badge and remove).
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
    const applyMode = () => { if (document.documentElement) document.documentElement.dataset.sgaiMode = MODE; };
    function setMode(mode) {
        MODE = mode;
        GM_setValue('sgai:mode', MODE);
        GM_deleteValue('sgai:scan');          // folded into MODE; a stale value must not win next load
        applyMode();
        if (MODE === 'skip') dropQueued();    // stop a queued backlog draining into Steam
        else {
            // Leaving skip: capsules that went past while it was on were seen but never looked up.
            for (const el of document.querySelectorAll('[data-sgai="idle"]')) { el.dataset.sgai = 'pending'; io.observe(el); }
            scan();
        }
        heal();                               // re-assert badges and the blur positioning guard
        syncEye();
    }
    applyMode();

    // Games hidden by hand, unrelated to AI: appids in the manager's storage, a button on the capsule
    // under the pointer, and a second header eye. 'hide' takes them off; 'show' keeps them dimmed.
    const OWN_KEY = 'sgai:hidden';
    let hidden = loadHidden();
    function loadHidden() {
        const v = GM_getValue(OWN_KEY, null);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};   // never trust the store
        const out = {};
        for (const [k, name] of Object.entries(v)) if (validId(k)) out[k] = typeof name === 'string' ? name.slice(0, 120) : '';
        return out;
    }
    function saveHidden() {
        try { GM_setValue(OWN_KEY, hidden); }
        catch (e) { console.warn('[SteamGameAI] could not save the hidden list', e); }
    }
    const hiddenCount = () => Object.keys(hidden).length;
    let OWN = GM_getValue('sgai:own', 'hide') === 'show' ? 'show' : 'hide';
    const applyOwn = () => { if (document.documentElement) document.documentElement.dataset.sgaiOwn = OWN; };
    function setOwn(mode) {
        OWN = mode;
        GM_setValue('sgai:own', OWN);
        applyOwn();
        syncOwnButtons();
        packSoon();
    }
    applyOwn();
    // Re-read on pushState navigation: on a game's own page hide and blur are limited to its carousels,
    // and carrying that limit to the next page left the filter doing nothing.
    const appIdFromPath = () => (location.pathname.match(/^\/app\/(\d+)/) || [])[1] || null;
    let APP_PAGE_ID = appIdFromPath();
    // A game's DLC list (/dlc/<id>/) shows that game's art and name in its header: the page's own.
    const dlcPageGame = () => (location.pathname.match(/^\/dlc\/(\d+)/) || [])[1] || null;

    // Named in every badge tooltip, so a screenshot in a bug report says which build made it.
    const INFO = (typeof GM_info !== 'undefined' && GM_info.script) || {};
    const SIGNATURE = `${INFO.name || 'Steam AI Content Disclosure Badge'}${INFO.version ? ' v' + INFO.version : ''}`;

    // The disclosure heading, in every store language
    // Steam's own heading strings, read off app pages one ?l= language at a time. Pages arrive in the
    // user's language, hence the full list; re-read the same way if Steam adds a language.
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
    // The same headings as they can stand in raw page source, where a space may be a line break
    // or an &nbsp; and an apostrophe may be written as an entity ("dall&#39;IA").
    const TITLE_RE = new RegExp(TITLES.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/ /g, '(?:\\s|&nbsp;|&#160;)+').replace(/'/g, "(?:'|&#0*39;|&apos;|&#x0*27;)")).join('|'));

    // Style
    // The badge is shaped like Steam's own capsule flags (the discount chip, "Free To Play"):
    // flat, dark, 2px corners, small uppercase Motiva Sans, just amber instead of Steam's green.
    const ACCENT = '#ffce5c';   // AI disclosure: Steam's own flag shape, amber
    const RED    = '#ff5d5d';   // games you hid yourself, so the two are never confused

    const CSS = `
        .sgai_badge{display:inline-block;font:700 11px/1 "Motiva Sans",Arial,sans-serif;
            letter-spacing:.7px;text-transform:uppercase;color:${ACCENT};background:rgba(0,0,0,.85);
            border-radius:2px;padding:4px 5px;vertical-align:middle;white-space:nowrap;}
        /* Centred on the name's capitals, not x-height: 26px Motiva caps are 18px tall and this
           chip's caps sit 4.5px above its baseline, so lift 9 - 4.5, plus .5 measured in Chrome. */
        .sgai_title{margin-left:10px;font-size:12px;padding:5px 7px;cursor:pointer;vertical-align:5px;}
        .sgai_title:hover{color:#fff;}
        .sgai_title:focus-visible,.sgai_eye:focus-visible,.sgai_hide:focus-visible,.sgai_title_hide:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px;}
        .sgai_cap{position:absolute;top:4px;left:4px;z-index:50;}
        /* A corner badge over the capsule link lets clicks through, or every flagged game gets a dead
           corner. Inline and description badges sit beside text and keep their tooltip. */
        .sgai_cap:not(.sgai_inline):not(.sgai_desc){pointer-events:none;}
        /* Steam's IN LIBRARY / WISHLISTED ribbon owns this corner when it is there. */
        .sgai_cap.sgai_under_flag{top:28px;}
        .sgai_inline{position:static;margin-left:8px;cursor:default;}
        .sgai_desc{position:static;margin-top:8px;}
        .sgai_host{position:relative;}
        /* An inline link around a capsule picture (an event card's game) is one line tall, the
           picture spilling out of it: as the badge's host it wraps the picture instead. */
        .sgai_host.sgai_host_box{display:inline-block;}
        .sgai_err{color:#8f98a0;}
        /* "Not verified" only means something while a filter is on. */
        [data-sgai-mode="badge"] .sgai_err{display:none !important;}
        /* Lookup in flight, so a game about to be blurred or hidden doesn't look checked. Pure CSS:
           an image could be blocked by a CSP or a CDN. */
        .sgai_check{width:12px;height:12px;padding:4px;background:rgba(0,0,0,.85);}
        .sgai_check::before{content:"";display:block;box-sizing:border-box;width:12px;height:12px;
            border:2px solid rgba(255,255,255,.25);border-top-color:${ACCENT};border-radius:50%;
            animation:sgai_spin .8s linear infinite;}
        @keyframes sgai_spin{to{transform:rotate(360deg);}}
        /* Steam's own disclosure box on a game's page: an amber bar and tint, and the same AI chip
           after its heading, drawn here so the heading's text is left untouched. */
        .sgai_disclosure{border-left:3px solid ${ACCENT};padding-left:12px;
            background:rgba(255,206,92,.05);border-radius:0 2px 2px 0;}
        .sgai_dh::after{content:"AI";display:inline-block;margin-left:10px;padding:3px 5px;
            font:700 11px/1 "Motiva Sans",Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase;
            color:${ACCENT};background:rgba(0,0,0,.85);border-radius:2px;vertical-align:1px;}  /* caps 10px: 5 - 4 */
        /* Title badge clicked: pulse the box twice, starting once the scroll has mostly landed. */
        .sgai_flash{animation:sgai_flash .9s ease-in-out .35s 2;}
        @keyframes sgai_flash{50%{background:rgba(255,206,92,.22);box-shadow:0 0 0 3px rgba(255,206,92,.55);}}
        [data-sgai-mode="skip"] .sgai_cap{display:none !important;}
        /* Hiding a game by hand: one button that follows the pointer to the capsule under it, so
           no capsule has to become a positioning context. Lit while that game is on the list. */
        .sgai_hide{position:fixed;z-index:9998;inset:auto;margin:0;border:0;padding:0;overflow:visible;display:flex;align-items:center;justify-content:center;
            box-sizing:border-box;width:22px;height:22px;border-radius:2px;cursor:pointer;
            background:rgba(0,0,0,.85);color:#fff;opacity:0;visibility:hidden;transition:opacity .12s;}
        .sgai_hide.sgai_on{opacity:1;visibility:visible;}
        .sgai_hide:hover{background:rgba(0,0,0,.97);}
        .sgai_hide svg{display:block;width:64%;height:64%;}   /* it takes the wishlist star size beside one */
        .sgai_hide_on{color:${RED};}
        /* A game's own page: the same button after its title (see syncTitleHide), up while the
           pointer is on the title row, kept lit while the game is on the list. */
        .sgai_title_hide{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;
            width:22px;height:22px;margin:0 0 0 10px;padding:0;vertical-align:middle;position:relative;top:-2px;   /* level with the AI chip */
            border-radius:2px;cursor:pointer;background:rgba(0,0,0,.85);color:#fff;opacity:0;transition:opacity .12s;}
        .sgai_title_hide svg{display:block;width:64%;height:64%;pointer-events:none;}
        :hover > .apphub_AppName > .sgai_title_hide,:hover > #appHubAppName > .sgai_title_hide,
        .sgai_title_hide:focus-visible,.sgai_title_hide.sgai_hide_on{opacity:1;}
        .sgai_title_hide:hover{background:rgba(0,0,0,.97);}
        .sgai_title_hide.sgai_hide_on{color:${RED};}   /* on the list: red, like the header's eye */
        @media (hover: none){.sgai_title_hide{opacity:1;}}
        [data-sgai-own="hide"] .sgai_own{display:none !important;}
        /* The list turned off: the games on it stay, faded, so they can be taken back off it. */
        [data-sgai-own="show"] .sgai_own{opacity:.5;filter:grayscale(.8);outline:2px solid rgba(255,93,93,.55);
            outline-offset:-2px;background-color:rgba(255,93,93,.10);}
        [data-sgai-own="show"] .sgai_own:hover{opacity:.9;filter:none;}
        /* The hidden-list eye, red while it is holding games back. */
        .sgai_eye.sgai_own_eye[data-mode="hide"]{color:${RED} !important;}
        [data-sgai-mode="hide"] .sgai_ai{display:none !important;}
        /* The front page's takeover banner is a spacer link laid over art drawn behind it. When its
           game goes, the art goes too, or the page slides up under it; blurred, so is the art. */
        [data-sgai-own="hide"] .home_page_body_ctn:has(> .home_page_takeover_link.sgai_own) > :is(.fullscreen-bg,.store_bg_overlay,.static_takeover_ctn,.page_background_holder),
        [data-sgai-mode="hide"] .home_page_body_ctn:has(> .home_page_takeover_link.sgai_ai) > :is(.fullscreen-bg,.store_bg_overlay,.static_takeover_ctn,.page_background_holder){display:none !important;}
        [data-sgai-mode="blur"] .home_page_body_ctn:has(> .home_page_takeover_link.sgai_ai:not(:hover)) > :is(.fullscreen-bg,.page_background_holder){filter:blur(12px);}
        /* Blur mode: blur the card's contents, not the card, so nothing reflows and our own badge
           stays legible on top. Hovering reveals the game. */
        [data-sgai-mode="blur"] .sgai_ai:not(:hover) > *:not(.sgai_cap){filter:blur(10px);}
        [data-sgai-mode="blur"] .sgai_ai:not(:hover){background:rgba(0,0,0,.25);}
        [data-sgai-mode="blur"] .sgai_ai:not(:hover)::after{content:"AI disclosure: hover to reveal";
            position:absolute;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;
            text-align:center;padding:4px;pointer-events:none;
            font:700 clamp(10px,1.1vw,13px)/1.25 "Motiva Sans",Arial,sans-serif;color:${ACCENT};}
        /* Eye toggle docked in the global header. The header styles children through
           #global_action_menu, an id we can't outrank, hence the !important box and color. */
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
        .sgai_eye_float2{top:44px;}                    /* the pair, stacked in the corner */
        /* Past the header: a second eye pinned to the top, same size and control. placeFollow() sets
           where; it fades in once the header's eye is gone. */
        .sgai_eye_follow{position:fixed;top:12px;left:0;z-index:9999;display:flex;flex-direction:column;
            gap:6px;transition:opacity .15s,visibility .15s;}
        .sgai_eye_follow > .sgai_eye{float:none;margin:0;background:rgba(0,0,0,.75);
            box-shadow:0 2px 8px rgba(0,0,0,.5);}
        .sgai_eye_follow:not(.sgai_on){opacity:0 !important;visibility:hidden;pointer-events:none;}
        /* A carousel laid out over its remaining slides (see packCarousel): --sgai-m slides left,
           --sgai-v on screen, --sgai-t the thumb's share, --sgai-i the first one showing. */
        .sgai_slide_gone,.sgai_card_gone,.sgai_row_gone,.sgai_row_packed > .sgai_spacer{display:none !important;}
        /* Holds a hidden game's place in a short row, so Steam does not stretch the rest (see reflow). */
        .sgai_pad{visibility:hidden !important;pointer-events:none !important;}
        /* /explore/new/'s two big capsules share the row; with one gone the other keeps its size. */
        .newonsteam_headercaps{justify-content:center;}
        .newonsteam_headercaps > .newonsteam_headercap{flex-grow:0 !important;}
        /* A sale row (2 games over 3) with some hidden: the rest centred, at the width they had. */
        .sgai_row_packed{grid-template-columns:var(--sgai-cols) !important;justify-content:center !important;}
        .sgai_packed .carousel__slider-tray{width:calc(var(--sgai-m) / var(--sgai-v) * 100%) !important;
            transform:translateX(calc(var(--sgai-i) / var(--sgai-m) * -100%)) !important;}
        .sgai_packed .carousel__slider-tray > .carousel__slide{width:calc(100% / var(--sgai-m)) !important;}
        .sgai_packed [data-sgai-thumb]{left:calc(var(--sgai-i) / var(--sgai-m) * 100%) !important;
            right:calc((1 - (var(--sgai-i) + var(--sgai-t)) / var(--sgai-m)) * 100%) !important;}
        .sgai_packed [data-sgai-zone="prev"]{width:calc((var(--sgai-i) + var(--sgai-t) / 2) / var(--sgai-m) * 100%) !important;}
        .sgai_packed [data-sgai-zone="next"]{width:calc((1 - (var(--sgai-i) + var(--sgai-t) / 2) / var(--sgai-m)) * 100%) !important;}
        .sgai_pack_none .carousel__back-button,.sgai_pack_none .carousel__next-button{visibility:hidden !important;pointer-events:none !important;}
        /* Steam's older carousels (see packLegacy): one game or none left, nothing to page through. */
        .sgai_legacy_one .carousel_thumbs,.sgai_legacy_one .arrow{visibility:hidden !important;pointer-events:none !important;}
        .sgai_section_gone{display:none !important;}
        /* Export / import of the hidden list: a small dialog in the store's own colours. */
        .sgai_dialog_back{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);}
        .sgai_dialog{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:20px 22px;
            background:#1b2838;color:#c6d4df;border-radius:4px;box-shadow:0 10px 40px rgba(0,0,0,.7);font:14px/1.45 "Motiva Sans",Arial,sans-serif;text-align:left;}
        .sgai_dialog h2{margin:0 0 8px;padding:0;font:normal 20px/1.2 "Motiva Sans",Arial,sans-serif;color:#fff;text-transform:none;letter-spacing:0;}
        .sgai_dialog p{margin:0 0 12px;}
        .sgai_dialog textarea{display:block;box-sizing:border-box;width:100%;height:210px;margin:0;padding:8px 10px;resize:vertical;
            background:#0e141b;color:#c6d4df;border:1px solid #2a475e;border-radius:3px;font:12px/1.45 Consolas,"Courier New",monospace;white-space:pre;}
        .sgai_dialog_status{min-height:1.45em;margin-top:10px;color:#a4d007;}
        .sgai_dialog_row{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px;}
        .sgai_dialog button{padding:7px 16px;border:0;border-radius:2px;cursor:pointer;font:14px "Motiva Sans",Arial,sans-serif;color:#fff;background:#3d4450;}
        .sgai_dialog button:hover{background:#464d58;}
        .sgai_dialog button.sgai_dialog_main{background:linear-gradient(90deg,#06bfff,#2d73ff);}
        .sgai_dialog button.sgai_dialog_main:hover{background:linear-gradient(90deg,#29c8ff,#4e89ff);}
    `;

    // A CSP without 'unsafe-inline' blocks GM_addStyle's <style>; a constructed stylesheet still applies,
    // so it goes first. Every route is verified by measuring a sentinel.
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

    // Set by start(), once there is a page to measure against. SHEET distinguishes "styled, but we
    // hold no sheet" (null) from "nothing applied" (undefined).
    let SHEET, STYLES_OK = false, INLINE_STYLES_OK = false;

    // Positions go on the element's own style: writes into a live stylesheet cost ~100x more. A CSP could
    // in theory block script styles, so that is measured, and a sheet rule kept as the fallback.
    function inlineStylesWork() {
        try {
            const t = document.createElement('span');
            t.style.letterSpacing = '3px';
            (document.body || document.documentElement).appendChild(t);
            const ok = getComputedStyle(t).letterSpacing === '3px';
            t.remove();
            return ok;
        } catch (e) { return false; }
    }
    const sheetRules = {};
    function styleOf(el, sel) {
        if (INLINE_STYLES_OK || !SHEET) return el.style;
        try {
            sheetRules[sel] = sheetRules[sel] || SHEET.cssRules[SHEET.insertRule(sel + '{}', SHEET.cssRules.length)];
            return sheetRules[sel].style;
        } catch (e) { return el.style; }
    }

    // Cache (GM storage)
    // The store can be edited by the user or a backup/sync tool, so every row is validated. Return null,
    // never throw: a throw in the IntersectionObserver callback strands the rest of its batch.
    const key = id => 'sgai:' + id;
    function cacheGet(id) {
        if (!validId(id)) return null;
        const v = GM_getValue(key(id), null);
        if (!v || typeof v !== 'object') return null;         // a string or number would throw on `in`
        if (!('name' in v)) return null;                      // pre-2.9 entry, no game name: refetch once
        if (!Number.isFinite(v.ts)) return null;              // no timestamp: would never expire
        // Read as text everywhere; a number here would throw in every caller.
        if ((v.name !== null && typeof v.name !== 'string') || (v.text != null && typeof v.text !== 'string')) return null;
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
        const last = +GM_getValue('sgai:swept', 0);
        // A garbled or future stamp would sweep on every load, or never again.
        if (Number.isFinite(last) && last <= Date.now() && Date.now() - last < SWEEP_EVERY) return;
        GM_setValue('sgai:swept', Date.now());
        let gone = 0;
        for (const k of GM_listValues() || []) {
            const m = /^sgai:(\d+)$/.exec(k);
            if (!m) continue;
            if (!cacheGet(m[1])) { GM_deleteValue(k); gone++; }   // same validity rules as a read
        }
        if (gone) console.info(`[SteamGameAI] pruned ${gone} stale cache entries`);
    }

    // Carousels Steam builds from game lists
    // Hidden games are taken out of the lists Steam builds React carousels from, before Steam reads
    // them, so Steam packs every page itself. Page load only; a game hidden mid-visit leaves its gap.

    // Games that would be taken off the page anyway: the hand-hidden list while on, and known AI games
    // in hide mode. Blur and a shown list keep their games in place, so they leave the lists alone.
    const dropped = id => validId(id) && ((OWN === 'hide' && id in hidden) || (MODE === 'hide' && !!(cacheGet(id) || {}).ai));

    // What the carousels on this page are about to show, list by list, soonest first: the games
    // worth checking before they are drawn (see prefetch).
    const upcomingLists = [], prefetchSeen = new Set();
    let prefetched = 0, prefetchTimer = 0, prefetchReady = false;   // up here: the lists arrive while the page loads
    const noteUpcoming = ids => { if (ids.length) upcomingLists.push(ids.map(String)); prefetchSoon(); };

    // Prunes either shape in place; true if anything went. A list that would come out empty is left
    // whole: Steam may not expect an empty carousel, and a game shown beats a broken section.
    function pruneGames(v) {
        let changed = false;
        const keep = (arr, gone) => {
            const kept = arr.filter(x => !gone(x));
            if (!kept.length || kept.length === arr.length) return arr;
            changed = true;
            return kept;
        };
        if (Array.isArray(v) && v.some(x => x && Array.isArray(x.apps))) {
            for (const l of v) if (l && Array.isArray(l.apps)) {
                l.apps = keep(l.apps, a => !!a && a.item_type === 'app' && dropped(String(a.id)));
                noteUpcoming(l.apps.filter(a => a && a.item_type === 'app').map(a => a.id));
            }
        } else if (Array.isArray(v)) {
            // An event is about its game, or about the demo it announces; a bare number is a game.
            const pruned = keep(v, x => typeof x === 'number' ? dropped(String(x))
                : !!x && (dropped(String(x.appid)) || (!!x.demo_appid && dropped(String(x.demo_appid)))));
            if (v.length && v.every(x => typeof x === 'number')) noteUpcoming(pruned);
            if (pruned !== v) { v.length = 0; v.push(...pruned); }
        } else if (v && typeof v === 'object' && Array.isArray(v.appids)) {
            const before = v.appids.length;
            v.appids = keep(v.appids, id => dropped(String(id)));
            // The keys run alongside the ids; keep them in step, and only when they were in step.
            if (Array.isArray(v.store_item_keys) && v.store_item_keys.length === before && v.appids.length < before)
                v.store_item_keys = v.store_item_keys.filter(k => !(/^app_\d+$/.test(k) && dropped(k.slice(4))));
            noteUpcoming(v.appids);
        }
        return changed;
    }
    const pruneText = text => {
        try {
            const v = JSON.parse(text);
            const lists = v && !Array.isArray(v) && Array.isArray(v.mainListData) ? v.mainListData : v;
            return pruneGames(lists) ? JSON.stringify(v) : text;
        } catch (e) { return text; }                         // not a shape we know: leave it
    };

    // The page's own copy: the list attributes on #application_config.
    const LIST_ATTR = /^data-(ch_main_list_data$|section_|browser_|hubitems_|recent_events_|demoeventstore$|discount_)/;
    function pruneConfig(el) {
        for (const a of [...el.attributes]) {
            if (!LIST_ATTR.test(a.name)) continue;
            const out = pruneText(a.value);
            if (out !== a.value) el.setAttribute(a.name, out);
        }
    }
    // Steam reads the downloads in the page's world, out of our sandbox's reach, so a small page script
    // hands each response over through a DOM attribute plus a synchronous event and takes back the result.
    const ASK = 'sgai-repack', ASKED = 'data-sgai-in', ANSWER = 'data-sgai-out', PB = 'pb:';
    document.addEventListener(ASK, () => {
        const root = document.documentElement;
        try {
            const text = root.getAttribute(ASKED) || '';
            root.setAttribute(ANSWER, text.startsWith(PB) ? PB + prunePb(text.slice(PB.length)) : pruneText(text));
        } catch (e) { root.removeAttribute(ANSWER); }
    });

    // Signed-in personal rows come from GetItemsByUserRecommendedTags as protobuf (repeated 1 = row
    // {1 = tag, repeated 2 = {1 = appid}}); just enough decoding to drop games, the rest kept byte for byte.
    const pbVarint = (b, i) => {
        let v = 0, shift = 0, x;
        do { if (i >= b.length) throw new Error('truncated'); x = b[i++]; v += (x & 127) * 2 ** shift; shift += 7; } while (x & 128);
        return [v, i];
    };
    const pbVarintBytes = v => { const out = []; do { let x = v % 128; v = Math.floor(v / 128); if (v) x |= 128; out.push(x); } while (v); return out; };
    function pbFields(b) {                                   // [{ f, w, start, end, body }] or throws
        const out = [];
        for (let i = 0; i < b.length;) {
            const start = i; let tag, len, body = null;
            [tag, i] = pbVarint(b, i);
            const w = tag & 7;
            if (w === 0) [, i] = pbVarint(b, i);
            else if (w === 2) { [len, i] = pbVarint(b, i); body = b.subarray(i, i + len); i += len; }
            else if (w === 5) i += 4;
            else if (w === 1) i += 8;
            else throw new Error('wire type ' + w);
            if (i > b.length || !(tag >> 3)) throw new Error('not protobuf');
            out.push({ f: tag >> 3, w, start, end: i, body });
        }
        return out;
    }
    const pbJoin = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
    function prunePb(b64) {
        const raw = atob(b64), b = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
        let changed = false;
        const parts = pbFields(b).map(row => {
            const whole = b.subarray(row.start, row.end);
            if (row.f !== 1 || row.w !== 2) return whole;
            const kids = pbFields(row.body);
            const appid = k => { const id = pbFields(k.body).find(x => x.f === 1 && x.w === 0); return id ? pbVarint(k.body, pbVarint(k.body, id.start)[1])[0] : null; };
            const items = kids.filter(k => k.f === 2 && k.w === 2);
            const gone = new Set(items.filter(k => { const id = appid(k); return id !== null && dropped(String(id)); }));
            noteUpcoming(items.filter(k => !gone.has(k)).map(appid).filter(id => id !== null));
            if (!gone.size || gone.size === items.length) return whole;   // never empty a row
            changed = true;
            const inner = pbJoin(kids.filter(k => !gone.has(k)).map(k => row.body.subarray(k.start, k.end)));
            return pbJoin([Uint8Array.from(pbVarintBytes((1 << 3) | 2)), Uint8Array.from(pbVarintBytes(inner.length)), inner]);
        });
        if (!changed) return b64;
        const out = pbJoin(parts);
        let bin = '';
        for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return btoa(bin);
    }
    // Runs in the page, as its own <script>: nothing from our scope is visible there.
    function repackInPage(ASK, ASKED, ANSWER, PB) {
        const LISTS = /\/contenthub\/ajaxgetcontenthubdata|\/saleaction\/ajaxgetsaledynamicappquery/;
        const handOver = text => {
            const root = document.documentElement;
            try {
                root.setAttribute(ASKED, text);
                root.removeAttribute(ANSWER);
                document.dispatchEvent(new CustomEvent(ASK));  // answered before this returns
                const out = root.getAttribute(ANSWER);
                return out === null ? text : out;
            } catch (e) { return text; }
            finally { root.removeAttribute(ASKED); root.removeAttribute(ANSWER); }
        };
        const X = XMLHttpRequest.prototype, open = X.open;
        const own = k => Object.getOwnPropertyDescriptor(X, k);
        const rText = own('responseText'), rBody = own('response');
        X.open = function (method, url) {
            delete this.responseText;                        // a reused request starts clean
            delete this.response;
            if (LISTS.test(String(url))) {
                let out = null;
                const text = () => {
                    if (out === null) out = handOver(this.responseType === 'json' ? JSON.stringify(rBody.get.call(this)) : rText.get.call(this));
                    return out;
                };
                Object.defineProperty(this, 'responseText', { configurable: true,
                    get() { return this.readyState === 4 ? text() : rText.get.call(this); } });
                Object.defineProperty(this, 'response', { configurable: true, get() {
                    const type = this.responseType;
                    if (this.readyState !== 4 || (type !== '' && type !== 'text' && type !== 'json')) return rBody.get.call(this);
                    return type === 'json' ? JSON.parse(text()) : text();
                } });
            }
            return open.apply(this, arguments);
        };
        // Older pages pick each carousel's games from long lists through GStoreItemData.FilterItemsForDisplay;
        // drop hidden games before it picks and it fills the carousel with others.
        const wrapFilter = g => {
            const pick = g && g.FilterItemsForDisplay;
            if (typeof pick !== 'function' || pick.sgai) return;
            g.FilterItemsForDisplay = function (items) {
                const args = [...arguments];
                try {
                    const id = x => (x && typeof x === 'object' && x.appid) || null;
                    const ids = Array.isArray(items) ? items.map(id).filter(Boolean) : [];
                    const kept = ids.length ? JSON.parse(handOver(JSON.stringify({ appids: ids }))).appids : null;
                    if (Array.isArray(kept) && kept.length < ids.length) {
                        const keep = new Set(kept.map(String));
                        args[0] = items.filter(x => !id(x) || keep.has(String(id(x))));
                    }
                } catch (e) { /* not a list we know: Steam's own pick */ }
                return pick.apply(this, args);
            };
            g.FilterItemsForDisplay.sgai = true;
        };
        if (window.GStoreItemData) wrapFilter(window.GStoreItemData);
        else try {
            let v;
            Object.defineProperty(window, 'GStoreItemData', { configurable: true, enumerable: true,
                get() { return v; }, set(x) { v = x; wrapFilter(x); } });
        } catch (e) { /* defined some other way: left alone */ }
        const BINARY = /\/IStoreQueryService\/GetItemsByUserRecommendedTags\//;
        const f = window.fetch;
        if (typeof f === 'function') window.fetch = function (input) {
            const p = f.apply(this, arguments);
            const url = input && typeof input === 'object' && 'url' in input ? input.url : String(input);   // string, URL or Request
            const redo = (res, body) => new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
            if (BINARY.test(url)) return p.then(res => !res.ok ? res : res.clone().arrayBuffer().then(buf => {
                const b = new Uint8Array(buf); let bin = '';
                for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
                const out = handOver(PB + btoa(bin));
                if (!out.startsWith(PB) || out === PB + btoa(bin)) return res;
                const raw = atob(out.slice(PB.length)), o = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) o[i] = raw.charCodeAt(i);
                return redo(res, o);
            }).catch(() => res));
            if (!LISTS.test(url)) return p;
            return p.then(res => res.clone().text().then(t => {
                const out = handOver(t);
                return out === t ? res : redo(res, out);
            }).catch(() => res));
        };
    }
    // Both halves go in when #application_config appears (only React pages carry it). The parser sets
    // its attributes before inserting it, and this callback runs before the next script: ahead of Steam's.
    (function startRepack() {
        const setUp = el => {
            try { pruneConfig(el); } catch (e) { console.warn('[SteamGameAI] could not repack the page lists', e); }
            try {
                const s = document.createElement('script');
                s.textContent = `(${repackInPage})(${JSON.stringify(ASK)}, ${JSON.stringify(ASKED)}, ${JSON.stringify(ANSWER)}, ${JSON.stringify(PB)});`;
                (document.head || document.documentElement).appendChild(s);
                s.remove();                                  // it has run; the element is not needed
            } catch (e) { console.warn('[SteamGameAI] could not set up carousel repacking', e); }
        };
        const now = document.getElementById('application_config');
        // Already there: started after the page's lists, perhaps too late for Steam to see them
        // pruned. Noted on <html> so a report can say so; the attempt is made all the same.
        if (now) { document.documentElement.dataset.sgaiLate = document.readyState; return setUp(now); }
        if (document.readyState !== 'loading') return;
        const found = n => n.nodeType === 1 && (n.id === 'application_config' ? n : n.querySelector && n.querySelector('#application_config'));
        const mo = new MutationObserver(recs => {
            for (const r of recs) for (const n of r.addedNodes) {
                const el = found(n);
                if (el) { mo.disconnect(); setUp(el); return; }
            }
        });
        mo.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', () => mo.disconnect(), { once: true });
    })();

    // Parse disclosure out of a document
    // The disclosure's heading and the box around it, or null.
    function findDisclosure(root) {
        // Collapse whitespace before matching: a heading Steam's template wrapped across source
        // lines, or one holding a non-breaking space, is the same heading.
        const flat = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
        const h2 = [...root.querySelectorAll('h2')].find(h => TITLE_SET.has(flat(h)));
        if (!h2) return null;
        // Steam's disclosure sits in the content-descriptors block. Outside it, the same heading is a
        // developer's [h2], so only a box small enough to be a disclosure counts (one swept in 45 KB).
        let box = h2.closest('#game_area_content_descriptors');
        if (!box) {
            box = h2.parentElement;
            if (!box || box.textContent.length > 2000) return null;
        }
        return { h2, box };
    }

    function getDisclosure(root) {
        const found = findDisclosure(root);
        if (!found) return { ai: false, text: null };
        const { h2, box } = found;
        // What follows the heading, up to the next one: the descriptors block can hold the
        // mature-content description as well, and that is not this disclosure's text.
        let text = '';
        for (let n = h2.nextSibling; n; n = n.nextSibling) {
            if (n.nodeType === 1 && (n.matches('h2') || n.querySelector('h2'))) break;
            text += (n.textContent || '') + ' ';
        }
        // A heading wrapped on its own inside the box: take the box, less the heading.
        if (!text.trim()) box.childNodes.forEach(n => { if (n !== h2 && !n.contains?.(h2)) text += (n.textContent || '') + ' '; });
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

    // Throttled background lookup
    // Three lookups at a time. `epoch` lets a queued backlog (an infinite-scroll page queues 1000+)
    // be dropped when listings are switched off, instead of draining into Steam.
    let active = 0, epoch = 0;
    const queue = [];
    const cancelled = () => Object.assign(new Error('lookup cancelled'), { cancelled: true });
    const slot = () => new Promise((res, rej) => {
        const mine = epoch;
        // The slot is taken when it is actually handed over, never in release(), so a cancelled
        // waiter cannot leave the count above what is really running.
        const take = () => (mine === epoch ? (active++, res()) : rej(cancelled()));
        if (active < MAX_CONCURRENT) take(); else queue.push(take);
    });
    const release = () => {
        active = Math.max(0, active - 1);                    // never let a stray release go negative
        // Newest first. An infinite-scroll page can queue a thousand games, and the ones worth
        // answering are the ones under the reader's eyes now, not row 12 from ten screens ago.
        const next = queue.pop();
        if (next) next();
        else prefetchSoon(50);                               // the screen is served: look ahead
    };
    function dropQueued() {                                  // nothing waiting held a slot
        epoch++;
        queue.splice(0).forEach(take => take());
    }

    // Steam answers bursts with 429/503; pressing on fails the rest of the list and throttles the user's
    // own browsing. Every read waits out the pause Steam asked for, or a doubling one.
    let pauseUntil = 0, backoff = 0;
    const BACKOFF_MIN = 30e3, BACKOFF_MAX = 5 * 60e3;
    async function waitOut() {
        while (Date.now() < pauseUntil) await new Promise(r => setTimeout(r, pauseUntil - Date.now()));
    }
    function throttled(res) {
        backoff = Math.min(BACKOFF_MAX, backoff ? backoff * 2 : BACKOFF_MIN);
        const asked = +res.headers.get('retry-after') * 1000;          // seconds; a date reads NaN
        pauseUntil = Date.now() + (asked > 0 ? Math.min(asked, BACKOFF_MAX) : backoff);
        console.warn(`[SteamGameAI] Steam is throttling reads; pausing ${Math.round((pauseUntil - Date.now()) / 1000)}s`);
    }

    // Adult pages serve an age gate with no disclosure, read as "no AI". Age cookies are set lazily on
    // the first gate: host-only, one day, never over Steam's own birthtime, verified by reading back.
    let ageCookiesSet = false, ageCookiesTried = false;
    function setAgeCookies() {
        if (ageCookiesSet || ageCookiesTried) return ageCookiesSet;
        ageCookiesTried = true;
        if (/\bbirthtime=/.test(document.cookie)) return (ageCookiesSet = true);
        const opts = '; path=/; max-age=86400; SameSite=Lax; Secure';
        document.cookie = 'birthtime=631152001' + opts;             // 1 Jan 1990
        document.cookie = 'lastagecheckage=1-January-1990' + opts;
        ageCookiesSet = /\bbirthtime=631152001\b/.test(document.cookie);
        if (!ageCookiesSet) console.warn('[SteamGameAI] age cookies blocked; gated games stay unverified');
        return ageCookiesSet;
    }
    const isAgeGate = (url, html) => url.includes('/agecheck') || /agegate_birthday|app_agegate|agegate_text_container/.test(html);

    // Every app page read rewrites `recentapps` (Steam's ten "recently viewed"). After each read, every
    // game we read is taken back out unless the user viewed it; other new entries are left alone.
    const RECENT_MAX = 10;
    const readRecent = () => {
        const m = document.cookie.match(/(?:^|;\s*)recentapps=([^;]*)/);
        try { const o = m && JSON.parse(decodeURIComponent(m[1])); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
        catch (e) { return {}; }
    };
    let userRecent = readRecent();
    // Ours: a game with a read in flight, or still carrying the exact time Steam wrote for our read.
    // Compared as Steam wrote them, so a skewed local clock can't mix up a real visit.
    const reading = new Map(), ourStamps = new Map();
    function restoreRecent() {
        const now = readRecent();
        const strip = Object.keys(now).filter(id => now[id] !== userRecent[id] &&
            (reading.has(id) || ourStamps.get(id) === now[id]));
        if (!strip.length) return;                                    // nothing of ours
        const merged = { ...userRecent, ...now };                     // pushed-out entries come back
        for (const id of strip) if (id in userRecent) merged[id] = userRecent[id]; else delete merged[id];
        const keep = Object.entries(merged).filter(([, t]) => Number.isFinite(t))
            .sort((a, b) => b[1] - a[1]).slice(0, RECENT_MAX);
        userRecent = Object.fromEntries(keep);
        document.cookie = 'recentapps=' + encodeURIComponent(JSON.stringify(userRecent)) +
            (keep.length ? '; max-age=7776000' : '; max-age=0') + '; path=/; Secure; SameSite=None';
    }
    // A read still in flight when the tab goes away would leave its game sitting in that list.
    addEventListener('pagehide', () => restoreRecent());
    addEventListener('visibilitychange', () => { if (document.hidden) restoreRecent(); });

    async function fetchAppPage(id) {
        // No ?l= or ?cc=: asking for a language makes Steam set a cookie that changes the store language
        // the user browses in. The page comes in their language, which TITLES covers.
        const url = `https://store.steampowered.com/app/${id}/`;
        // A demo's page redirects to the full game, and Steam writes THAT game into the recently
        // viewed list: an id we never asked for. So note where the read actually landed.
        const ids = new Set(), served = new Set();
        const hold = x => { if (!ids.has(x)) { ids.add(x); reading.set(x, (reading.get(x) || 0) + 1); } };
        hold(String(id));
        const landed = h => {
            const m = (h.url || '').match(/\/app\/(\d+)/);
            if (m) hold(m[1]);
            served.add(m ? m[1] : String(id));                // a page came back: Steam wrote it down
            return h;
        };
        try {
            let page = landed(await read(url, {}));
            if (page.gate && BYPASS_AGE_GATE && setAgeCookies()) page = landed(await read(url, { cache: 'reload' }));
            // Still gated: adult-only titles need a per-app opt-in we are not going to set, and a
            // gate page parses as "no disclosure". Fail instead, so it is never cached as clean.
            if (page.gate) throw new Error('age gate not cleared');
            return page;
        } finally {
            const now = readRecent();
            for (const x of ids) {
                if (served.has(x) && x in now) ourStamps.set(x, now[x]);
                const n = reading.get(x) - 1;
                if (n > 0) reading.set(x, n); else reading.delete(x);
            }
            restoreRecent();
        }
    }

    // One read, with the failure modes that actually happen on Steam handled: a stalled socket
    // (abort), an error or maintenance page (status), and a response too big to be an app page.
    async function read(url, opts) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
        try {
            const res = await fetch(url, { ...opts, signal: ac.signal });
            if (res.status === 429 || res.status === 503) throttled(res);
            if (!res.ok) throw new Error('HTTP ' + res.status);   // 429/503/404 must not cache as "no AI"
            backoff = 0;
            const len = +res.headers.get('content-length');     // the compressed size, when sent at all
            if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('body too large: ' + len);
            const text = await res.text();
            if (text.length > MAX_BYTES) throw new Error('body too large: ' + text.length);
            return { text, url: res.url || url, gate: isAgeGate(res.url || url, text) };
        } finally { clearTimeout(timer); }
    }

    // The game's name out of the raw page, without building a DOM for it. Most games carry no
    // disclosure and never get parsed, and the hidden list still wants to say what it is holding.
    function rawName(html) {
        const m = html.match(/id="appHubAppName"[^>]*>([^<]{1,200})</)
               || html.match(/<div[^>]+class="[^"]*apphub_AppName[^"]*"[^>]*>([^<]{1,200})</);
        if (!m) return null;
        // Still HTML-escaped: "Tom Clancy&#39;s" and "Dungeons &amp; Dragons" as written in the
        // source. Decoded by the parser, on this one short string; it holds no tags to run.
        const s = m[1].includes('&') ? new DOMParser().parseFromString(m[1], 'text/html').body.textContent : m[1];
        return s.replace(/\s+/g, ' ').trim() || null;
    }

    // Most games carry no disclosure and a page is megabytes: test the raw text and skip the DOM parse
    // (~20 ms) on misses. The descriptors block must be there too; the phrase also turns up in reviews.
    function mayDisclose(html) {
        if (!html.includes('game_area_content_descriptors')) return false;
        if (TITLES.some(t => html.includes(t))) return true;
        const at = html.indexOf('id="game_area_content_descriptors"');
        return TITLE_RE.test(at > -1 ? html.slice(at, at + 20000) : html);
    }

    // Checking ahead
    // In filtering modes, check the games carousels are about to show before they are drawn: a few from
    // each list in turn, only when nothing on screen waits, never while throttled, capped per page.
    const PREFETCH_DEPTH = 12, PREFETCH_MAX = 80;
    function prefetchSoon(ms = 400) {
        if (prefetchReady && !prefetchTimer) prefetchTimer = setTimeout(() => { prefetchTimer = 0; pumpPrefetch(); }, ms);
    }
    function nextUpcoming() {
        for (let d = 0; d < PREFETCH_DEPTH; d++) {
            for (const list of upcomingLists) {
                const id = list[d];
                if (id === undefined || prefetchSeen.has(id)) continue;
                prefetchSeen.add(id);
                if (validId(id) && !cacheGet(id) && !inflight.has(id)) return id;
            }
        }
        return null;
    }
    function pumpPrefetch() {
        while (filtering() && !document.hidden && prefetched < PREFETCH_MAX && active < MAX_CONCURRENT
               && !queue.length && Date.now() >= pauseUntil) {
            const id = nextUpcoming();
            if (!id) return;
            prefetched++;
            lookup(id).then(d => { if (d && d.ai) packSoon(); prefetchSoon(50); });
        }
    }

    const inflight = new Map();
    // `urgent` is for a game the user just acted on: it jumps the three-at-a-time queue, which on
    // a long listing can be hundreds of games deep, and doesn't join an already queued read.
    function lookup(id, urgent) {
        const c = cacheGet(id);
        if (c) return Promise.resolve(c);
        if (!urgent && inflight.has(id)) return inflight.get(id);
        const p = (async () => {
            let held = false;                                 // only release a slot we actually took
            try {
                const mine = epoch;
                if (!urgent) { await slot(); held = true; }
                await waitOut();
                if (!urgent && mine !== epoch) throw cancelled();   // listings turned off meanwhile
                const { text: html, url } = await fetchAppPage(id);
                // A login wall, a delisted game's redirect or a region notice is not this game's page and must not
                // be cached as clean. A non-game app id (Labs, hardware) redirects too: cached as notApp, no badge.
                if (!/\/app\/\d+/.test(url) && !/login|agecheck/i.test(url)) {
                    const d = { ai: false, text: null, name: null, notApp: true };
                    cacheSet(id, d);
                    return d;
                }
                if (!/\/app\/\d+/.test(url) || !/appHubAppName|apphub_AppName/.test(html)) throw new Error('not an app page: ' + url);
                if (!mayDisclose(html)) {
                    const d = { ai: false, text: null, name: rawName(html) };
                    cacheSet(id, d);
                    return d;
                }
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const d = getDisclosure(doc);
                d.name = appName(doc);
                cacheSet(id, d);                            // only cache successful reads
                return d;
            } catch (e) {
                // A cancelled lookup is us switching listings off, not a failure: no warning, and
                // no "not verified" badge either, because nothing was attempted.
                if (e && e.cancelled) return { ai: false, text: null, name: null, cancelled: true };
                console.warn('[SteamGameAI] lookup failed', id, e);
                return { ai: false, text: null, name: null, error: true };
            } finally { if (held) release(); if (!urgent) inflight.delete(id); }
        })();
        if (!urgent) inflight.set(id, p);
        return p;
    }

    // Badges
    function makeBadge(text) {
        const b = document.createElement('span');
        b.className = 'sgai_badge';
        b.textContent = 'AI';
        b.title = text ? `${text}

${SIGNATURE}` : SIGNATURE;
        return b;
    }

    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // The name on a capsule's own artwork. Hover previews add screenshots whose alt reads
    // "<game>'s screenshot 1", so prefer a real capsule image (its URL has the asset path).
    const CAPSULE_IMG = 'img[alt]:not([alt=""])';
    const capsuleAlt = el => {
        if (el.matches('img')) return el.getAttribute('alt') || '';
        const imgs = [...el.querySelectorAll(CAPSULE_IMG)];
        const src = i => i.getAttribute('src') || '';
        // Screenshots sit beside the artwork under the same app folder, named ss_…, so pick by the
        // kind of image rather than by its folder.
        const img = imgs.find(i => /(header|capsule|hero|library_|logo)/i.test(src(i)))
                 || imgs.find(i => !/\/ss_|screenshot|movie|\.webm|broadcast/i.test(src(i)))
                 || imgs[0];
        const alt = (img && img.getAttribute('alt')) || el.getAttribute('aria-label') || '';
        return alt.replace(/['’]s screenshot \d+$/i, '');   // a hover preview's picture still names its game
    };

    // The appid an element stands for, exactly: "/app/700330" must not read as app 70. Only paths that
    // start /app/<id>; a news post (/news/app/<id>/) or an age check is not a capsule.
    const APP_HREF = /^(?:(?:https?:)?\/\/[^/]+)?\/app\/(\d+)/;
    const hrefApp = h => ((h || '').trim().match(APP_HREF) || [])[1] || null;
    function appIdOf(el) {
        if (!el || !el.getAttribute) return null;
        const d = (el.getAttribute('data-ds-appid') || '').trim();
        if (/^\d+$/.test(d)) return d;
        return hrefApp(el.getAttribute('href'));
    }
    // The game a scanned node shows now. React reuses nodes (a virtualized list, a queue that
    // advances in place), so this is re-read the same way the scanner read it the first time.
    function currentId(el) {
        const own = appIdOf(el);
        if (own) return own;
        const h = /^hover_app_(\d+)$/.exec(el.id || '');
        if (h) return h[1];
        return el.matches('.AppVideoCtn, .StoreSaleWidgetShortDesc, .tab_preview') ? widgetAppId(el) : null;
    }
    // Our badge needs a positioned host, but making a box positioned moves Steam's own overlays by
    // hundreds of pixels: add the class only when needed, and remove it with the badge. '' means not laid out.
    function ensureHost(el) {
        if (!el || !el.isConnected) return false;
        if (el.dataset.sgaiHosted) return true;
        const pos = getComputedStyle(el).position;
        if (pos === '') return false;
        if (pos === 'static') { el.classList.add('sgai_host'); el.dataset.sgaiHosted = '1'; }
        if (el.dataset.sgaiHosted && getComputedStyle(el).display === 'inline' && el.querySelector('img')) el.classList.add('sgai_host_box');
        return true;
    }
    function releaseHost(el) {
        if (!el || !el.dataset || !el.dataset.sgaiHosted) return;
        if (el.querySelector(':scope > .sgai_cap')) return;   // another badge still needs it
        el.classList.remove('sgai_host', 'sgai_host_box');
        delete el.dataset.sgaiHosted;
    }

    // One badge per card: grow to the largest ancestor that mentions only this game. A popup's several
    // links make one claim; two cards for the same game in a mixed row each claim themselves.
    function claimCard(el, id, attr) {
        const prior = el.closest(`[${attr}~="${id}"]`);
        if (prior) {
            // A claim whose badge did not survive a re-render is stale; honouring it would
            // suppress this card's badge for the rest of the session.
            if (prior.querySelector('.sgai_cap')) return false;
            unclaim(prior, attr, id);
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

    function unclaim(holder, attr, id) {
        const left = (holder.getAttribute(attr) || '').split(/\s+/).filter(x => x && x !== id);
        left.length ? holder.setAttribute(attr, left.join(' ')) : holder.removeAttribute(attr);
    }

    // Shown only while a lookup is on the network and a filter is on, so a game about to be blurred
    // or hidden doesn't read as checked and cleared.
    function checkBadge(el, on) {
        const had = el.querySelector(':scope > .sgai_check');
        if (!on) { if (had) { had.remove(); releaseHost(el); } return; }
        if (!filtering() || had) return;
        // A capsule whose image has not arrived yet is a sliver; a spinner would hang off it.
        const box = el.getBoundingClientRect();
        if (box.width < 40 || box.height < 30 || !ensureHost(el)) return;
        const b = document.createElement('span');
        b.className = 'sgai_badge sgai_cap sgai_check';
        b.title = `Checking for an AI Generated Content Disclosure…

${SIGNATURE}`;
        el.appendChild(b);
    }

    // A lookup that failed leaves a game looking clean, which matters once a filter is on: the
    // game stays visible as if it had been checked and cleared. Mark those so the gap is visible
    function errBadge(el, id) {
        if (!filtering() || !el.isConnected) return;
        if (badgeKind(el) === 'desc') return;                    // the capsule of this card carries it
        if (!claimCard(el, id, 'data-sgai-err')) return;
        if (!ensureHost(el)) return;
        const b = makeBadge(`AI disclosure check failed for app ${id}. This game was not verified.`);
        b.classList.add('sgai_cap', 'sgai_err');
        b.textContent = 'AI?';
        el.appendChild(b);
    }
    // A retry got through: the game is verified now, one way or the other.
    function clearErr(el, id) {
        const b = el.querySelector(':scope > .sgai_err');
        if (!b) return;
        b.remove();
        releaseHost(el);
        const holder = el.closest(`[data-sgai-err~="${id}"]`);
        if (holder) unclaim(holder, 'data-sgai-err', id);
    }
    // A failed read is tried again, twice, with room in between: a throttled burst or a dropped
    // connection is usually over by then. Only while the node still shows that game.
    const RETRY_MS = [60e3, 300e3];
    const retries = new WeakMap();
    function retryLater(el, id) {
        const n = retries.get(el) || 0;
        if (n >= RETRY_MS.length) return;
        retries.set(el, n + 1);
        setTimeout(() => {
            if (!el.isConnected || el.dataset.sgaiId !== id) return;
            el.dataset.sgai = MODE === 'skip' ? 'idle' : 'pending';   // skip: when listings come back on
            if (MODE !== 'skip') io.observe(el);
        }, RETRY_MS[n]);
    }

    function titleBadge(text) {
        const t = document.querySelector('#appHubAppName, .apphub_AppName');
        if (!t || t.querySelector('.sgai_title')) return;
        const b = makeBadge(`${text || 'This game discloses AI generated content'}\n\nClick to jump to the disclosure.`);
        b.classList.add('sgai_title');
        b.tabIndex = 0;
        b.setAttribute('role', 'button');
        b.setAttribute('aria-label', 'AI generated content disclosure: jump to it');
        b.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
        });
        b.addEventListener('click', e => {
            e.preventDefault();
            const box = markDisclosure();
            if (!box) return;
            const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
            box.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
            // Restart the pulse on every click: drop the class, force a style flush, add it back.
            box.classList.remove('sgai_flash');
            void box.offsetWidth;
            box.classList.add('sgai_flash');
        });
        t.insertBefore(b, t.querySelector(':scope > .sgai_title_hide'));   // straight after the name
    }

    // Marks Steam's disclosure box with an amber bar, and an AI chip drawn by CSS ::after so the
    // heading text stays Steam's: findDisclosure() matches on it.
    function markDisclosure() {
        const found = findDisclosure(document);
        if (!found) return null;
        found.box.classList.add('sgai_disclosure');
        found.h2.classList.add('sgai_dh');
        if (!found.box.dataset.sgaiFlashHook) {
            found.box.dataset.sgaiFlashHook = '1';
            found.box.addEventListener('animationend', e => {
                if (e.animationName === 'sgai_flash') found.box.classList.remove('sgai_flash');
            });
        }
        return found.box;
    }

    const managed = [];   // badges we've placed, re-asserted if a React re-render strips them

    function badgeKind(el) {
        if (el.matches('.hover_title, .tab_preview') || el.querySelector('.hover_title, .tab_title')) return 'title';
        if (el.matches('.StoreSaleWidgetShortDesc')) return 'desc';
        return 'corner';
    }

    // In blur mode the corner badge sits on the card itself: a filter blurs its whole subtree, so a
    // badge inside the target would blur too. As a direct child, :not(.sgai_cap) keeps it sharp.
    const badgeHost = m => (MODE === 'blur' && m.target && m.target.isConnected) ? m.target : m.el;

    function placedOk(m) {
        if (!m.node || !m.node.isConnected) return false;
        if (m.kind === 'desc') return m.node.previousElementSibling === m.el;
        if (m.kind === 'title') return !!m.node.parentElement?.matches('.hover_title, .tab_title');
        return m.node.parentElement === badgeHost(m);
    }

    // Moves the badge this entry owns instead of building another: a "one next to me?" check broke on
    // any re-render in between, and every re-render added a badge.
    function placeBadge(m) {
        if (!m.node) m.node = makeBadge(m.text);
        if (m.kind === 'title') {
            const t = m.el.matches('.hover_title, .tab_title') ? m.el : m.el.querySelector('.hover_title, .tab_title');
            if (!t) { m.kind = 'corner'; return placeBadge(m); }   // a preview with no title node
            m.node.classList.add('sgai_cap', 'sgai_inline');
            // A space first: the popup's title is read as text elsewhere, and appending straight
            // onto it turns "Ai Vpet" into "Ai VpetAI".
            if (t.lastChild !== m.node) t.append(' ', m.node);
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
        const flag = !!host.querySelector('.ds_flag');
        m.node.classList.toggle('sgai_under_flag', flag);
        // A React capsule draws its marks (signed in, a DLC's ribbon in this corner) in its
        // decorators, and a game streaming now has a LIVE chip there: sit just below them.
        let below = '';
        const MARKS = '.CapsuleDecorators > *, .broadcast_live_stream_icon';     // a DLC's ribbon, the LIVE chip
        if (!flag && host.querySelector(MARKS)) {
            const h = host.getBoundingClientRect();
            const bottoms = [...host.querySelectorAll(MARKS)].map(e => e.getBoundingClientRect())
                .filter(r => r.height > 4 && r.left - h.left < 60 && r.top - h.top < 30).map(r => r.bottom - h.top);
            if (bottoms.length) below = Math.round(Math.min(80, Math.max(...bottoms) + 2)) + 'px';
        }
        if (m.node.style.top !== below) m.node.style.top = below;
        host.appendChild(m.node);
        if (m.host && m.host !== host) releaseHost(m.host);
        m.host = host;
    }

    // What blur and hide act on
    // The game's whole card, grown out from the capsule. Growth stops at another game, an added
    // heading, a container named for the app, or text that isn't this game's.
    const HIDE_STOP = 'body, main, #StoreTemplate, #responsive_page_template_content, [data-featuretarget],' +
        '.responsive_page_frame, .responsive_page_content, #page_background_container, .page_content_ctn, .creator_grid_ctn,' +
        '#tab_preview_container,' +                          // the front page's tabs: one preview per game, built on hover
        '#global_hover,' +                                   // the old pages' tooltip: one box for every game, refilled on hover
        '.VideoRow';                                         // a trailer carousel: one game at a time, between its arrows

    const APP_CAROUSELS = '#recommended_block, [data-featuretarget^="storeitems-carousel"], [data-featuretarget="creatorhome-carousel"]';

    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Punctuation, ™ and emoji read as spaces: stored and displayed names differ (a demo's card says
    // "All-Night Ascension Demo", its lookup stored "All Night Ascension").
    const loose = s => ' ' + s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
    // Whole words only, so the game "Control" is not found inside "Controller-friendly picks".
    // `wants` holds every name this game goes by: the stored one and the capsule's own alt text.
    function namesGame(text, wants) {
        for (const want of wants) {
            if (new RegExp(`(^|\\W)${escapeRe(want)}(\\W|$)`).test(text)) return true;
            const w = loose(want);
            if (w.trim() && loose(text).includes(w)) return true;
        }
        return false;
    }
    // Text with spaces between text nodes: textContent glues neighbours together ("wishlistpotion
    // democasual"), and the word-boundary test then misses the name.
    function spacedText(el) {
        let s = '';
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) s += n.data + ' ';
        return s;
    }
    // The text an ancestor adds beyond what we already have; t's text is contiguous inside it.
    function addedText(n, t, read = spacedText) {
        const full = norm(read(n)), inner = norm(read(t));
        if (!inner) return full;
        const i = full.indexOf(inner);
        return (i === -1 ? full : full.slice(0, i) + ' ' + full.slice(i + inner.length)).trim();
    }
    // Spaced first; the plain read still catches a name split by an inline tag ("Half-<b>Life</b>").
    const textOnly = el => el.textContent;
    // A card with no title text (the sale pages' big expanded widget) says its name only on the
    // artwork: a second capsule beside the details names the card as a title would.
    const altNamed = (n, t, want) => [...n.querySelectorAll(CAPSULE_IMG)].some(i => !t.contains(i) && namesGame(norm(i.getAttribute('alt')), want));
    const namedIn = (n, t, want) => namesGame(addedText(n, t), want) || namesGame(addedText(n, t, textOnly), want) || altNamed(n, t, want);
    // A heading beside the card belongs to a section, unless it is exactly the game's name: then it is
    // the card's title set above the capsule ("Half-Life Franchise" is a section).
    const headingOutside = (n, t, want) => [...n.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .some(h => !t.contains(h) && !(want && want.includes(norm(h.textContent))));
    // Last-resort backstop: nothing that fills the screen is one game's card.
    function pageSized(n) {
        const r = n.getBoundingClientRect();
        return r.height > innerHeight * 0.8 && r.width > innerWidth * 0.9;
    }

    // For hand-hidden games with no name to grow by (chart rows, bare capsules): take the card by
    // shape, growing until something objects, well short of page size. Never sure; heal() re-checks.
    const BLIND_AREA = 25;                                   // an unnamed card is not 25x its capsule
    function blindTarget(t, id) {
        const start = t.getBoundingClientRect();
        const area = Math.max(1, start.width * start.height);
        for (let n = t.parentElement, i = 0; n && i < 8 && !n.matches(HIDE_STOP); n = n.parentElement, i++) {
            if (foreignApp(n, id) || headingOutside(n, t) || pageSized(n)) break;
            const r = n.getBoundingClientRect();
            if (r.width * r.height > area * BLIND_AREA) break;
            t = n;
        }
        return { t, sure: false };
    }

    function hideTarget(el, kind, id, name, blind) {
        if (kind === 'title') return null;
        // Steam's old tooltip: one box for every game, holding one #hover_app_<id> per game pointed
        // at. That one is the game's own; the box around it is everybody's.
        if (/^hover_app_\d+$/.test(el.id || '')) return { t: el, sure: true };
        // A trailer carousel (a creator's "Popular Titles", the demo hub's top): the game on show is
        // all of what sits between its two arrows: trailer, art, tags, buttons.
        const row = el.closest('.VideoRow');
        const mid = row && [...row.children].find(c => !c.matches('button') && c.contains(el));
        if (mid) return { t: mid, sure: true };
        // A sale widget's description is one part of the card its capsule makes: take that card.
        // Grown from the text alone it stops at the tags below it, and half the card stays.
        if (el.matches('.StoreSaleWidgetShortDesc')) {
            const a = capsuleNear(el, id), r = a && hideTarget(a, 'corner', id, name, blind);
            if (r && r.t.contains(el)) return r;
        }
        let t = el.closest('a[href*="/app/"]') || el.closest('[data-ds-appid]') || el;
        const want = [...new Set([norm(name), norm(titleNear(t)), norm(capsuleAlt(t))])].filter(Boolean);
        // With no name we cannot tell this game's card from the page around it. For the AI filter
        // that means leaving it alone: hiding a guess would strand half a card or eat a section.
        if (!want.length) return blind ? blindTarget(t, id) : null;
        let named = namesGame(norm(spacedText(t)), want) || namesGame(norm(t.textContent), want), scoped = false;
        for (let n = t.parentElement, i = 0; n && i < 8 && !n.matches(HIDE_STOP); n = n.parentElement, i++) {
            if (foreignApp(n, id)) break;
            if (headingOutside(n, t, want)) break;
            if (pageSized(n)) break;
            if (appScoped(n, id)) { t = n; scoped = true; continue; }
            if (scoped) break;                               // past that container: page furniture
            const added = addedText(n, t);
            if (!added) { t = n; continue; }                 // adds nothing: a wrapper, absorb it
            if (named) { t = n; continue; }                  // the card's own price / tags / buttons
            if (namedIn(n, t, want)) { t = n; named = true; continue; }
            break;                                           // somebody else's text: card ended below
        }
        // No name found (a grid card whose only text is "More like this"): for a hand-hidden game, fall
        // back to shape rather than leave the button and price behind.
        if (!named && !scoped && blind) return blindTarget(t, id);
        return { t, sure: named || scoped };
    }

    // The nearest capsule of this game around a node: a link to it holding its artwork.
    function capsuleNear(el, id) {
        for (let n = el.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
            const l = [...n.querySelectorAll('a[href*="/app/"]')].find(l => appIdOf(l) === id && l.querySelector(CAPSULE_IMG));
            if (l) return l;
        }
        return null;
    }

    // Named for this app (#app-ctn-<appid>): exactly one game's card, so growth stops there. Strict,
    // so "sale_row_400" is not app 400.
    function appScoped(n, id) {
        if ((n.getAttribute('data-ds-appid') || '').trim() === id) return true;
        if ((n.getAttribute('data-appid') || '').trim() === id) return true;
        return new RegExp(`(^|[-_])app[-_]?(ctn|card|capsule|container)?[-_]?${id}($|[-_])`, 'i').test(n.id || '');
    }

    // A short reason line ("Because you played <game>") links other games without being about them,
    // so its links neither end the card nor name it. A tall box of that class is a card itself.
    const REASON = '.home_content_reason, [class*="reason" i]';
    const aside = l => { const r = l.closest(REASON); return !!r && r.getBoundingClientRect().height < 60; };

    // Does this container reference any app other than `id`? A box already found to be another
    // game's (the scanner's tag) counts, whether or not it links anywhere (a hover preview doesn't).
    function foreignApp(n, id) {
        const own = (n.getAttribute('data-ds-appid') || n.getAttribute('data-sgai-id') || '').trim();
        if (own && own !== id) return true;
        for (const l of n.querySelectorAll('a[href*="/app/"], [data-ds-appid], [data-sgai-id]')) {
            const lid = l.getAttribute('data-sgai-id') || appIdOf(l);
            if (lid && lid !== id && !aside(l)) return true;
        }
        return false;
    }

    // Two entries can land on one card: a capsule and a link inside it. Take the tag
    // off only when no other entry still holds that card, or the game comes back while listed.
    function untag(m, list, cls) {
        const t = m.target;
        if (!t || list.some(x => x !== m && x.target === t)) return;
        t.classList.remove(cls);
        if (cls === 'sgai_ai') releaseHost(t);
    }

    // Where the filter acts for this entry: { t: the card or null, sure }. Reads layout only, so a
    // batch can measure every card first and then write, instead of forcing a layout per game.
    function aiTarget(m) {
        // On a game's own page nearly everything references it, so cards would grow into whole page
        // sections: hide only inside its carousels of other games. Title badges have no card by design.
        const kind = m.el.matches('.tab_preview') ? 'corner' : m.kind;   // the tabs' preview: its badge is a title's, the preview is the card
        if (kind === 'title' || (APP_PAGE_ID && !m.el.closest(APP_CAROUSELS)) || m.id === dlcPageGame()) return { t: null, sure: true };
        // No name yet: React may not have drawn the card. Not sure, so heal() looks again a few times.
        return hideTarget(m.el, kind, m.id, m.name) || { t: null, sure: false };
    }

    function markAI(m, found) {
        if (!filtering()) {                                  // badge-only: nothing to mark
            if (m.target) { untag(m, managed, 'sgai_ai'); m.target = null; }
            m.settled = false;
            return;
        }
        found = found || aiTarget(m);
        const t = found.t;
        m.sure = found.sure;
        m.settled = true;
        // A re-render can move the card boundary: a wrapper we absorbed may since have gained
        // another game. Drop the old tag so the previous target doesn't stay hidden with it.
        if (m.target && m.target !== t) untag(m, managed, 'sgai_ai');
        m.target = t || null;
        if (!t) return;
        // Blur's label is drawn across the card, so the card must be the positioning context; same guard
        // as badge hosts, only when nothing is set already.
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
        packSoon();
    }

    // Carousels with games hidden after Steam built them
    // A carousel built with a now-hidden game keeps sizing its strip, thumb and pages for every slide.
    // React owns the count, so the layout for the slides left is laid over it in CSS; nothing is moved.
    const SLIDES_GONE = () => (OWN === 'hide' ? '.sgai_own' : '') + (OWN === 'hide' && MODE === 'hide' ? ',' : '') + (MODE === 'hide' ? '.sgai_ai' : '');
    const packWatch = new WeakSet(), turned = new WeakMap();
    let packFrame = 0;
    const packSoon = () => { if (!packFrame) packFrame = requestAnimationFrame(() => { packFrame = 0; packCarousels(); }); };

    function packCarousels() {
        if (!STYLES_OK) return;
        for (const tray of document.querySelectorAll('.carousel__slider-tray')) {
            try { packCarousel(tray); } catch (e) { console.warn('[SteamGameAI] could not pack a carousel', e); }
        }
        const gone = SLIDES_GONE();
        for (const box of document.querySelectorAll('.carousel_container')) {
            try { packLegacy(box, gone); } catch (e) { console.warn('[SteamGameAI] could not pack a carousel', e); }
        }
        try { packGrids(gone); } catch (e) { console.warn('[SteamGameAI] could not pack a grid', e); }
        try { packTrailers(gone); } catch (e) { console.warn('[SteamGameAI] could not pack a trailer carousel', e); }
        try { packTabs(gone); } catch (e) { console.warn('[SteamGameAI] could not refocus the tabs', e); }
    }
    // A slide is gone when it is hidden itself, or when every game in it is hidden: marked, or
    // already known (the list, the cache) the moment Steam draws it, before it is painted.
    function allGone(s, gone) {
        if (gone && s.matches(gone)) return true;
        const links = [...s.querySelectorAll('a[href*="/app/"]')].filter(a => !aside(a));
        if (s.matches('a[href*="/app/"]')) links.push(s);
        return !!links.length && links.every(a => (gone && a.closest(gone)) || dropped(appIdOf(a) || ''));
    }

    // Steam's older carousels (front page): one item per dot. An item whose games are all hidden goes
    // with its dot; one left, the arrows go too; none left, the section. For games hidden after load.
    function packLegacy(box, gone) {
        const list = box.querySelector('.carousel_items');
        const items = list ? [...list.children] : [];
        if (!items.length) return;
        const dots = [...(box.querySelector('.carousel_thumbs')?.children || [])];
        const paired = dots.length === items.length;
        const paged = reflow(items, gone);
        let left = 0;
        items.forEach((it, k) => {
            const g = allGone(it, gone) || (paged && !kidsOf(it).length);
            it.classList.toggle('sgai_slide_gone', g && !(gone && it.matches(gone)));
            if (paired) dots[k].classList.toggle('sgai_slide_gone', g);
            if (!g) left++;
        });
        box.classList.toggle('sgai_legacy_one', left <= 1 && left < items.length);
        const section = box.closest('.home_pagecontent_ctn');
        (section && section.querySelectorAll('.carousel_container').length === 1 ? section : box).classList.toggle('sgai_section_gone', !left);
        // The item on show is one that went: step on, as Steam's own arrow does, which skips it.
        // Not when the arrow is not laid out: the narrow layout scrolls instead of paging.
        const shown = items.find(it => it.classList.contains('focus'));
        const next = box.querySelector('.arrow.right');
        if (left && shown && allGone(shown, gone) && next && next.getClientRects().length) next.click();
    }

    // Games flowing through a run of boxes (carousel pages, sale grid rows) move up in Steam's order;
    // gone ones wait out of sight in the last box. Only runs of pure capsules, never the spotlight.
    const capsuleKid = c => c.matches('a[href], [data-ds-appid]');
    const isPad = c => c.classList.contains('sgai_pad');
    const kidsOf = b => [...b.children].filter(c => !isPad(c));
    // An empty, invisible copy of a capsule's box: the same tag and classes, so the same size.
    const NOT_COPIED = /^(sgai_|app_impression_tracked$|add_microtrailer$|with_microtrailer$|focus$)/;
    function makePad(model) {
        const p = document.createElement(model.tagName);
        p.className = [...model.classList].filter(c => !NOT_COPIED.test(c)).join(' ');
        p.classList.add('sgai_pad');
        p.setAttribute('aria-hidden', 'true');
        return p;
    }
    // Steam loads a page's pictures the first time that page comes on screen: a capsule moved into
    // a page already shown would keep its placeholder, a price and no art.
    function loadArt(c) {
        for (const img of c.querySelectorAll('img[data-image-url]')) {
            const src = img.getAttribute('src') || '';
            if (!src || /placeholder|blank|transparent|1x1/i.test(src)) img.src = img.dataset.imageUrl;
        }
    }
    function reflow(boxes, gone, single) {
        if (boxes.length < (single ? 1 : 2) || !boxes.every(b => !capsuleKid(b) && kidsOf(b).every(capsuleKid))) return false;
        // Each box's share is read the first time it is seen, before we move anything: Steam's own
        // layout. A box Steam adds later joins the run; one it is still filling is waited for.
        if (boxes.some(b => !b.dataset.sgaiRoom && !kidsOf(b).length)) return false;
        let next = 1 + Math.max(-1, ...boxes.flatMap(kidsOf).map(c => (c.dataset.sgaiOrd === undefined ? -1 : +c.dataset.sgaiOrd)));
        for (const b of boxes) {
            if (b.dataset.sgaiRoom) continue;
            b.dataset.sgaiRoom = kidsOf(b).length;
            for (const c of kidsOf(b)) if (c.dataset.sgaiOrd === undefined) c.dataset.sgaiOrd = next++;
        }
        const room = boxes.map(b => +b.dataset.sgaiRoom);
        if (Math.max(...room) < 2) return false;
        const ord = c => (c.dataset.sgaiOrd === undefined ? 1e9 : +c.dataset.sgaiOrd);
        const caps = boxes.flatMap(kidsOf).sort((x, y) => ord(x) - ord(y));
        const shown = caps.filter(c => !allGone(c, gone)), off = caps.filter(c => allGone(c, gone));
        let at = 0;
        boxes.forEach((b, k) => {
            // A game that leaves this box for a later one is taken out when that box is filled.
            const last = k === boxes.length - 1;
            const mine = last ? shown.slice(at) : shown.slice(at, at + room[k]);
            at += room[k];
            // The box the games run out in keeps its size: Steam stretches a short row's games to
            // fill it, so invisible stand-ins hold the places of the ones gone.
            const need = mine.length && mine.length < room[k] ? room[k] - mine.length : 0;
            const pads = [...b.children].filter(isPad);
            for (const p of pads.splice(need)) p.remove();
            while (pads.length < need) pads.push(makePad(mine[0]));
            const want = mine.concat(pads, last ? off : []);
            const have = [...b.children];
            if (want.length !== have.length || want.some((c, i) => c !== have[i])) {
                for (const c of mine) if (c.parentElement !== b) loadArt(c);
                b.append(...want);
            }
        });
        return true;
    }
    // A box with games in it, every one of them gone.
    const emptied = (b, gone) => kidsOf(b).length > 0 && kidsOf(b).every(c => capsuleKid(c) && allGone(c, gone));

    // Sale grids and lists under a heading: rows refill, an empty row goes, and a list with all games
    // gone takes its heading with it.
    function packGrids(gone) {
        const holders = new Set([...document.querySelectorAll('.salerow')].map(r => r.parentElement));
        for (const h of holders) {
            const rows = [...h.children].filter(r => r.matches('.salerow'));
            // Rows of one size together: a big capsule's row and a small one's draw different art.
            const size = r => r.className.replace(/\s*sgai_\w+/g, '').trim();
            for (const cls of new Set(rows.map(size))) reflow(rows.filter(r => size(r) === cls), gone);
            let left = 0;
            for (const r of rows) {
                const g = kidsOf(r).length ? emptied(r, gone) : !!r.dataset.sgaiRoom;
                r.classList.toggle('sgai_slide_gone', g);
                if (!g) left++;
            }
            h.classList.toggle('sgai_section_gone', rows.length > 0 && !left && rows.length === h.children.length);
        }
        // A sale page's grids outside any carousel ("Popular titles", a hub's "On sale now" rows):
        // their rows close up around a hidden game, as the rows on a carousel's page do.
        packRowList([...document.querySelectorAll('.SaleSectionContainer')].filter(r => !r.closest('.carousel__slide')), gone);
        // One box of games under a heading (tag blocks, "due to your recent playtime"): the rest close up
        // in Steam's order, gone places held empty so nothing stretches; none left, the heading goes.
        for (const [list, sec] of [...document.querySelectorAll('.home_content > .home_content_items')].map(l => [l, l.parentElement])
            .concat([...document.querySelectorAll('.home_discounts_block .home_discount_games_ctn')].map(l => [l, l.closest('.home_discounts_block')]))) {
            reflow([list], gone, true);
            if (sec.querySelectorAll('.home_content_items, .home_discount_games_ctn').length !== 1) continue;
            sec.classList.toggle('sgai_section_gone', emptied(list, gone));
        }
    }

    // A trailer carousel shows one game at a time and only that one is in the page: step past a gone
    // game with Steam's own arrow. Coming round to one already passed means all are gone.
    function packTrailers(gone) {
        for (const row of document.querySelectorAll('.VideoRow')) {
            const sec = row.closest('.SaleSectionCtn') || row;
            const arrows = row.querySelectorAll(':scope > button'), next = arrows[arrows.length - 1];
            const shown = [...row.children].find(c => !c.matches('button'));
            const id = shown && appIdOf(shown.querySelector('a[href*="/app/"]'));
            if (!id) continue;
            const d = sec.dataset, passed = (d.sgaiPassed || '').split(',').filter(Boolean);
            if (!allGone(shown, gone)) {
                for (const k of ['sgaiPassed', 'sgaiFrom', 'sgaiDir']) delete d[k];
                sec.classList.remove('sgai_section_gone');
                continue;
            }
            const since = Date.now() - (+d.sgaiTurned || 0);
            if (since < 500) { setTimeout(packSoon, 520 - since); continue; }   // the last turn is still drawing
            // The arrows don't wrap: a turn that went nowhere is an end, and the way back is the other arrow.
            // Blocked both ways, or back at a game already passed: none left.
            let dir = +(d.sgaiDir || 1);
            if (d.sgaiFrom === id) {
                if (dir < 0 || arrows.length < 2) { sec.classList.add('sgai_section_gone'); continue; }
                dir = -1;
                d.sgaiDir = dir;
            } else if (passed.includes(id) || arrows.length < 2) { sec.classList.add('sgai_section_gone'); continue; }
            d.sgaiPassed = passed.concat(id).join(',');
            d.sgaiFrom = id;
            d.sgaiTurned = Date.now();
            (dir > 0 ? next : arrows[0]).click();
        }
    }

    // On a tab switch the preview shows the first row's game, which may be gone and leave the column
    // empty: point at the first row still shown, as the pointer would.
    let tabWatch = null;
    function packTabs(gone) {
        const box = document.getElementById('tab_preview_container');
        if (!box) return;
        if (!tabWatch) {                                     // Steam switches the preview by its class
            tabWatch = new MutationObserver(() => packTabs(SLIDES_GONE()));   // this alone, not every carousel on each hover
            tabWatch.observe(box, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
        }
        const f = box.querySelector('.tab_preview.focus');
        if (!gone || !f || !f.closest(gone)) return;
        const row = [...document.querySelectorAll('.tab_content a.tab_row_item')].find(r => r.getClientRects().length && !allGone(r, gone));
        if (row) row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }

    function packCarousel(tray, stepped) {
        const root = tray.closest('.carousel') || tray.closest('.carousel__slider')?.parentElement?.parentElement;
        if (!root) return;
        const slides = [...tray.children].filter(s => s.classList.contains('carousel__slide'));
        const N = slides.length, W = parseFloat(tray.style.width), X = /translateX\(\s*(-?[\d.]+)%/.exec(tray.style.transform || '');
        if (!N || !(W > 0)) return;
        const V = Math.max(1, Math.round(N * 100 / W));
        const i = X ? Math.max(0, Math.round(-parseFloat(X[1]) / 100 * N)) : 0;
        if (!packWatch.has(tray)) {
            packWatch.add(tray);
            root.addEventListener('click', e => {
                const b = e.target.closest && e.target.closest('.carousel__next-button, .carousel__back-button');
                if (b) turned.set(root, { dir: b.matches('.carousel__next-button') ? 1 : -1, t: Date.now() });
            }, true);
            // React rewrites the strip's style and every slide's class list as pages turn, wiping our marks.
            // Put them back here, before paint, so a hidden game never flashes.
            new MutationObserver(recs => {
                let moved = false, touched = false;
                for (const r of recs) {
                    if (r.target === tray) { touched = true; if (r.attributeName === 'style') moved = true; }
                    else if (r.type === 'attributes' && r.target.parentElement === tray) { remark(r.target); touched = true; }
                    else if (r.type === 'attributes' && r.attributeName === 'class' && (r.oldValue || '').includes('sgai_')) touched = true;   // a row's or card's mark wiped
                    else if (r.type === 'childList' && [...r.addedNodes].some(n => n.nodeType === 1 && (n.matches('a[href*="/app/"]') || n.querySelector('a[href*="/app/"]')))) touched = true;   // a slide drawn
                }
                if (touched) packCarousel(tray, moved);         // not for every change deep inside a card
            }).observe(tray, { attributes: true, attributeFilter: ['style', 'class'], attributeOldValue: true, childList: true, subtree: true });
        }
        const gone = SLIDES_GONE();
        const isGone = s => allGone(s, gone);
        for (const sl of slides) packRows(sl, gone);
        let M = 0, before = 0;
        slides.forEach((s, k) => {
            const g = isGone(s);
            s.classList.toggle('sgai_slide_gone', g && !(gone && s.matches(gone)));
            if (!g) { M++; if (k < i) before++; }
        });
        // Nothing left: the panel goes with its heading and "See All", when it is this carousel's alone.
        const panel = root.closest('[data-featuretarget], .SaleSectionCtn');
        if (panel && panel.querySelectorAll('.carousel__slider-tray').length === 1) panel.classList.toggle('sgai_section_gone', !M);
        if (M === N) {                                        // nothing gone: Steam's own layout
            if (root.classList.contains('sgai_packed')) {
                root.classList.remove('sgai_packed', 'sgai_pack_none');
                delete root.dataset.sgaiAt; delete root.dataset.sgaiI;
            }
            return;
        }
        const last = Math.max(0, M - V);
        const was = root.dataset.sgaiAt, wasI = root.dataset.sgaiI;
        let at = was === undefined ? Math.min(before, last) : Math.min(+was, last);   // at first, where Steam is
        // Steam turned: turn ours a page the same way, from our last page round to the first and
        // back. Its button tells which way; a drag cannot wrap, so there the sign does.
        if (stepped && was !== undefined && wasI !== undefined && i !== +wasI && M > V) {
            const t = turned.get(root);
            turned.delete(root);
            const dir = t && Date.now() - t.t < 2000 ? t.dir : Math.sign(i - +wasI);
            const step = Math.min(V, +root.dataset.sgaiStep || V);
            at = dir > 0 ? (+was >= last ? 0 : Math.min(+was + step, last)) : (+was <= 0 ? last : Math.max(+was - step, 0));
            // Steam's own step, where it shows: a turn clear of either end of its strip.
            if (Math.sign(i - +wasI) === dir && i < N - V && +wasI < N - V) root.dataset.sgaiStep = Math.abs(i - +wasI);
        }
        // The thumb and its click zones, found by what they are rather than by Steam's hashed class
        // names: the thumb is the one element beside the strip placed by both left and right.
        for (const el of root.querySelectorAll('[style*="left"], [style*="right"]')) {
            if (el.closest('.carousel__slider')) continue;
            const st = el.style;
            if (st.left.endsWith('%') && st.right.endsWith('%')) el.dataset.sgaiThumb = '';
            else if (st.width.endsWith('%') && el.querySelector('.carousel__back-button')) el.dataset.sgaiZone = 'prev';
            else if (st.width.endsWith('%') && el.querySelector('.carousel__next-button')) el.dataset.sgaiZone = 'next';
        }
        root.classList.add('sgai_packed');
        root.classList.toggle('sgai_pack_none', M <= V);      // it all fits: nothing to turn
        const put = (k, v) => { if (root.style.getPropertyValue(k) !== String(v)) root.style.setProperty(k, String(v)); };
        put('--sgai-m', M); put('--sgai-v', V); put('--sgai-t', Math.min(V, M)); put('--sgai-i', at);
        root.dataset.sgaiI = i;
        root.dataset.sgaiAt = at;
    }
    // Sale rows (two over three) with games hidden: each row is laid out again over the games left,
    // centred at their old width; an empty row folds, an empty page drops. Moving between pages is React's.
    function packRows(slide, gone) { packRowList(slide.querySelectorAll('.SaleSectionContainer'), gone); }
    function packRowList(rows, gone) {
        for (const row of rows) {
            const kids = [...row.children];
            const cards = kids.filter(k => k.querySelector('a[href*="/app/"]'));
            if (!cards.length) continue;
            const off = c => [...c.querySelectorAll('a[href*="/app/"]')].filter(a => !aside(a)).every(a => (gone && a.closest(gone)) || dropped(appIdOf(a) || ''));
            let left = 0;
            for (const c of cards) {
                const o = off(c);
                c.classList.toggle('sgai_card_gone', o && !(gone && c.matches(gone)));
                if (!o) left++;
            }
            const packed = left < cards.length;
            row.classList.toggle('sgai_row_gone', packed && !left);
            row.classList.toggle('sgai_row_packed', packed && left > 0);
            for (const k of kids) k.classList.toggle('sgai_spacer', packed && !cards.includes(k));   // Steam's own centring spacers, not a card drawn late
            if (packed && left) {
                const n = +((row.className.match(/ItemCount_(\d+)/) || [])[1]) || cards.length;
                const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
                const cols = `repeat(${left}, calc((100% - ${(n - 1) * gap}px) / ${n}))`;
                if (row.style.getPropertyValue('--sgai-cols') !== cols) row.style.setProperty('--sgai-cols', cols);
            }
        }
    }
    // Our hide marks on a slide React has just rewritten the class list of. Only when missing:
    // adding a class that is already there still counts as a change to the observer above.
    function remark(slide) {
        const mark = cls => { if (!slide.classList.contains(cls)) slide.classList.add(cls); };
        if (filtering() && managed.some(m => m.target === slide)) mark('sgai_ai');
        if (ownMarks.some(m => m.target === slide && m.id in hidden)) mark('sgai_own');
    }

    // Games you hid yourself
    // Entries only for listed games. The add button is one element that follows the pointer: one per
    // capsule would make every capsule positioned, which moves Steam's own overlays.
    const ownMarks = [];

    function ownEntry(el, id) {
        if (!(id in hidden)) return null;
        let m = ownMarks.find(x => x.el === el && x.id === id);
        if (!m) { m = { el, id, target: null, sure: true }; ownMarks.push(m); }
        markOwn(m);
        return m;
    }

    // The name Steam writes inside the card. Named title elements only: a loose [class*="Title"]
    // also matches Steam's own column labels, which put a game on the list called "Tags".
    const TITLE_NEAR = '.title, .StoreSaleWidgetTitle, .tab_item_name, .app_name, .hover_title, ' +
        '.search_name > span, .apphub_AppName, [class*="AppName"], [class*="GameName"]';
    function titleNear(el) {
        const card = el.closest('[data-ds-appid], a[href*="/app/"]') || el;
        let t = card.querySelector(TITLE_NEAR);
        // One step out, but only while that step still talks about this game alone; otherwise the
        // name of the card next door would be picked up.
        if (!t) {
            const up = card.parentElement;
            const ids = up && new Set([...up.querySelectorAll('a[href*="/app/"]')].map(appIdOf).filter(Boolean));
            if (ids && ids.size <= 1) t = up.querySelector(TITLE_NEAR);
        }
        return ((t && t.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);   // as written
    }

    function toggleHidden(el, id) {
        // Another tab may have changed the list since this one read it; saving the stale copy
        // would put back what it took off and drop what it added.
        hidden = loadHidden();
        if (id in hidden) {
            delete hidden[id];
            // Every mark for the game, not just this capsule's: a copy elsewhere on the page would
            // otherwise stay faded until something else redrew the page.
            for (let i = ownMarks.length - 1; i >= 0; i--) if (ownMarks[i].id === id) dropOwn(ownMarks[i], i);
        } else {
            hidden[id] = ((cacheGet(id) || {}).name || titleNear(el) || capsuleAlt(el) || '').slice(0, 120);
            // A listing's name for a game is a guess (chart rows have none; previews show screenshot alts).
            // Show it at once, then settle it against the game's page: one request, cached.
            lookup(id, true).then(d => {
                if (!d || !d.name) return;
                hidden = loadHidden();
                if (!(id in hidden) || hidden[id] === d.name.slice(0, 120)) return;
                hidden[id] = d.name.slice(0, 120);
                saveHidden();
                healOwn();                                   // a real name can find a better card edge
            }).catch(() => { /* the game stays on the list under whatever the page called it */ });
            ownEntry(el, id);
            // Every capsule for that game on this page, not just the one under the pointer: a game
            // can be in a row, a carousel and a sidebar at once, and half-hiding it is worse.
            for (const other of document.querySelectorAll(`[data-sgai-id="${id}"]`)) ownEntry(other, id);
        }
        saveHidden();
        syncOwnButtons();                                    // the header count changed
        packSoon();
    }

    // Same card-growing as the AI filter, with the shape fallback (blindTarget) when there is no name:
    // the user picked this game by hand, and half a card left behind is the worst outcome.
    function markOwn(m) {
        // On a game's own page nearly everything links to it, so a grown card takes whole sections:
        // keep to its carousels of other games, as the AI filter does.
        const want = m.id in hidden && !(APP_PAGE_ID && !m.el.closest(APP_CAROUSELS)) && m.id !== dlcPageGame();
        const found = want ? hideTarget(m.el, 'corner', m.id, hidden[m.id] || (cacheGet(m.id) || {}).name, true) : null;
        const t = want ? ((found && found.t) || m.el) : null;
        m.sure = !want || !found || found.sure;
        if (m.target && m.target !== t) untag(m, ownMarks, 'sgai_own');
        m.target = t;
        if (t) t.classList.add('sgai_own');
        packSoon();                                          // a carousel may have lost a slide
    }
    function dropOwn(m, i) {
        untag(m, ownMarks, 'sgai_own');
        ownMarks.splice(i, 1);
    }

    function healOwn(force) {
        for (let i = ownMarks.length - 1; i >= 0; i--) {
            const m = ownMarks[i];
            const own = currentId(m.el);
            // Gone, recycled for another game, or taken off the list.
            if (!m.el.isConnected || (own && own !== m.id) || !(m.id in hidden)) { dropOwn(m, i); continue; }
            if (force || !m.target || !m.target.isConnected || !m.target.classList.contains('sgai_own')
                || (!m.sure && (m.rechecks = (m.rechecks || 0) + 1) <= RECHECKS)) markOwn(m);
        }
    }

    // The list as another tab left it, applied here: read when this tab comes back into view.
    function reloadHidden() {
        const was = JSON.stringify(hidden);
        hidden = loadHidden();
        const own = GM_getValue('sgai:own', 'hide') === 'show' ? 'show' : 'hide';
        if (own !== OWN) { OWN = own; applyOwn(); }
        if (JSON.stringify(hidden) !== was) {
            for (const el of document.querySelectorAll('[data-sgai-id]')) {
                const id = el.dataset.sgaiId;
                if (id in hidden) ownEntry(el, id);
            }
            healOwn();
            if (hoverEl) syncHoverButton();
        }
        syncOwnButtons();
    }

    // Sharing the hidden list
    // Export as text (a store link and name per game) or a .json file; import either, or any text with
    // links or appids, adding to the list. A page dialog so clipboard, download and file picker get a click.
    const SHARE_TYPE = 'steam-hidden-games';
    const shareName = n => String(n || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);

    function shareText(list) {
        const ids = Object.keys(list);
        return [`Steam games hidden with ${INFO.name || 'Steam AI Content Disclosure Badge'} (${ids.length})`,
            ...ids.map(id => `https://store.steampowered.com/app/${id}/` + (list[id] ? '  ' + list[id] : ''))].join('\n');
    }

    // Whatever was pasted or picked → { appid: name }, or null when there is nothing in it.
    function parseShared(text) {
        text = String(text || '').trim();
        if (!text) return null;
        const out = {};
        let data;
        try { data = JSON.parse(text); } catch (e) { data = undefined; }
        if (data !== undefined) {                            // an exported file, or a plain JSON list
            const games = data && typeof data === 'object' && !Array.isArray(data) && data.games ? data.games : data;
            if (Array.isArray(games)) {
                for (const g of games) {
                    const id = String(g && typeof g === 'object' ? (g.appid ?? g.id) : g);
                    if (validId(id)) out[id] = shareName(g && g.name);
                }
            } else if (games && typeof games === 'object') {
                for (const [id, name] of Object.entries(games)) if (validId(id)) out[id] = shareName(typeof name === 'string' ? name : '');
            }
        } else {                                             // text: store links or appids, one a line
            for (const line of text.split(/\r?\n/)) {
                const m = line.match(/\/app\/(\d+)/) || line.match(/^\s*(\d{1,10})(?!\S)/);
                if (!m || !validId(m[1])) continue;
                out[m[1]] = shareName(line.replace(/https?:\/\/\S+/g, '').replace(/^\s*\d+(?!\S)/, ''));
            }
        }
        return Object.keys(out).length ? out : null;
    }

    function importShared(list) {
        hidden = loadHidden();                               // another tab may have changed it
        let added = 0;
        for (const [id, name] of Object.entries(list)) if (!(id in hidden)) { hidden[id] = name; added++; }
        if (added) {
            saveHidden();
            for (const el of document.querySelectorAll('[data-sgai-id]')) if (el.dataset.sgaiId in hidden) ownEntry(el, el.dataset.sgaiId);
            syncOwnButtons();
            packSoon();
        }
        return added;
    }

    function shareDialog(mode) {
        document.querySelector('.sgai_dialog_back')?.remove();
        const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
        const back = make('div', 'sgai_dialog_back'), box = make('div', 'sgai_dialog');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', mode === 'export' ? 'Export hidden games' : 'Import hidden games');
        const opener = document.activeElement;
        const status = make('div', 'sgai_dialog_status');
        const row = make('div', 'sgai_dialog_row');
        const button = (label, act, main) => { const b = make('button', main ? 'sgai_dialog_main' : '', label); b.type = 'button'; b.addEventListener('click', act); row.append(b); return b; };
        const close = () => {
            back.remove();
            removeEventListener('keydown', onKey, true);
            if (opener && opener.isConnected && opener !== document.body) opener.focus();
        };
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        back.addEventListener('click', e => { if (e.target === back) close(); });
        addEventListener('keydown', onKey, true);
        const text = make('textarea');
        text.spellcheck = false;

        if (mode === 'export') {
            const list = loadHidden(), n = Object.keys(list).length;
            box.append(make('h2', '', 'Export hidden games'));
            if (!n) {
                box.append(make('p', '', 'No games are hidden yet.'));
            } else {
                box.append(make('p', '', `${n} game${n === 1 ? '' : 's'}. Send the text or the file; anyone with this script can add them to their own list with "Import hidden games".`));
                text.value = shareText(list);
                text.readOnly = true;
                box.append(text);
                button('Copy text', async () => {
                    try { await navigator.clipboard.writeText(text.value); }
                    catch (e) { text.select(); document.execCommand('copy'); }   // older browsers, odd frames
                    status.textContent = 'Copied.';
                }, true);
                button('Save file', () => {
                    const file = JSON.stringify({ type: SHARE_TYPE, version: 1, exported: new Date().toISOString(), count: n, games: list }, null, 2);
                    const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
                    const a = make('a');
                    a.href = url;
                    a.download = 'steam-hidden-games.json';
                    document.body.append(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                    status.textContent = 'Saved as steam-hidden-games.json.';
                });
            }
        } else {
            box.append(make('h2', '', 'Import hidden games'),
                make('p', '', 'Paste a shared list, or choose the file someone sent you. The games are added to your list; nothing on it is removed.'));
            text.placeholder = 'https://store.steampowered.com/app/…';
            box.append(text);
            const run = source => {
                const list = parseShared(source);
                if (!list) { status.textContent = 'No games found in that. Expected store links, appids, or an exported file.'; return; }
                const all = Object.keys(list).length, added = importShared(list);
                status.textContent = `Added ${added} game${added === 1 ? '' : 's'}` + (all > added ? ` (${all - added} already on your list).` : '.');
            };
            const file = make('input');
            file.type = 'file';
            file.accept = '.json,.txt,application/json,text/plain';
            file.hidden = true;
            file.addEventListener('change', () => {
                const f = file.files && file.files[0];
                if (!f) return;
                if (f.size > 2e6) { status.textContent = 'That file is too big to be a list of games.'; return; }
                f.text().then(t => { text.value = t; run(t); }).catch(() => { status.textContent = 'Could not read that file.'; });
            });
            box.append(file);
            button('Import', () => run(text.value), true);
            button('Choose file…', () => file.click());
        }
        button('Close', close);
        box.append(status, row);
        back.append(box);
        document.body.append(back);
        (mode === 'import' ? text : row.querySelector('button')).focus();
    }

    function unhideAll() {
        hidden = loadHidden();                               // the count as it stands, other tabs included
        const n = hiddenCount();
        if (!n) { alert('No games are hidden.'); return; }
        if (!confirm(`Show all ${n} hidden game(s) again?`)) return;
        hidden = {};
        saveHidden();
        for (const m of ownMarks.splice(0)) m.target?.classList.remove('sgai_own');
        syncOwnButtons();
        syncHoverButton();
        packSoon();
    }

    // One button, moved to whichever capsule the pointer is over. Fixed to the viewport, so no
    // capsule has to become a positioning context and nothing is inserted into Steam's markup.
    let hoverBtn = null, hoverEl = null, hoverId = null, hoverHideTimer = 0;
    const BTN_PX = 22, BTN_GAP = 6;
    // Without the popover API, ':popover-open' is a selector syntax error, not a non-match.
    const POPOVERS = typeof HTMLElement.prototype.showPopover === 'function';

    function hoverButton() {
        if (hoverBtn) {
            if (!hoverBtn.isConnected) document.body.appendChild(hoverBtn);   // a body swap took it
            return hoverBtn;
        }
        hoverBtn = document.createElement('div');
        hoverBtn.className = 'sgai_hide';
        hoverBtn.setAttribute('role', 'button');
        hoverBtn.setAttribute('tabindex', '0');
        const act = e => {
            e.preventDefault();
            e.stopPropagation();
            if (hoverEl && hoverId) toggleHidden(hoverEl, hoverId);
            syncHoverButton();
        };
        hoverBtn.addEventListener('click', act);
        hoverBtn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') act(e); });
        hoverBtn.addEventListener('pointerenter', () => clearTimeout(hoverHideTimer));
        hoverBtn.addEventListener('pointerleave', () => hideHoverSoon());
        // Steam's hover preview is a popover, and the top layer beats any z-index we could pick.
        // Being a popover ourselves is the only way to sit above it; harmless where unsupported.
        hoverBtn.setAttribute('popover', 'manual');
        document.body.appendChild(hoverBtn);
        return hoverBtn;
    }
    // The top layer is ordered by who showed last, so when Steam's preview popover covers us we show
    // ours again. Their preview lands a moment after the pointer, hence the re-checks.
    let bumpTimers = [];
    const covered = () => {
        const r = hoverBtn.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && !hoverBtn.contains(top);
    };
    function toTop() {
        if (!POPOVERS) return;
        try {
            if (!hoverBtn.matches(':popover-open')) hoverBtn.showPopover?.();
            else if (covered()) { hoverBtn.hidePopover(); hoverBtn.showPopover(); }
        } catch (e) { /* no popover support */ }
    }
    function showHoverBtn(on) {
        hoverBtn.classList.toggle('sgai_on', on);
        if (on) return toTop();
        bumpTimers.splice(0).forEach(clearTimeout);
        try { hoverBtn.hidePopover?.(); } catch (e) { /* no popover support */ }
    }
    function bumpSoon() {
        bumpTimers.splice(0).forEach(clearTimeout);
        bumpTimers = [150, 450].map(ms => setTimeout(() => {
            if (hoverEl && hoverBtn.classList.contains('sgai_on')) toTop();
        }, ms));
    }

    // Where the name's last line ends, from the text's own box: a title element is often full-width.
    // Clamped to the element, so an ellipsis-cut name doesn't push the button past the cut.
    function nameEnd(node) {
        const el = node.nodeType === 3 ? node.parentElement : node;
        const box = el.getBoundingClientRect();
        if (box.height <= 6 || box.width <= 6) return null;
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
        const last = lines[lines.length - 1] || box;
        let right = Math.min(last.right, box.right);
        // Our own AI chip after the name (the app page's title badge): past it, never on top of
        // it: the chip is a button too.
        for (const chip of el.querySelectorAll(':scope > .sgai_badge')) {
            const c = chip.getBoundingClientRect();
            if (c.width && c.top < last.bottom && c.bottom > last.top) right = Math.max(right, c.right);
        }
        return { right, top: last.top, height: last.height };
    }

    // Where this game's name is printed inside `root`, matched by text (the preview's title class is
    // hashed per build). Any of its names: a demo's card says "... Demo", its lookup the full game's.
    const skipOurs = { acceptNode: n => n.nodeType === 1 && n.matches('.sgai_badge, .sgai_hide, .sgai_title_hide')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT };
    function nameSpot(root, names) {
        const wants = new Set(names.map(norm).filter(Boolean));
        if (!wants.size) return null;
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skipOurs);
        for (let i = 0, n = walk.nextNode(); n && i < 1500; n = walk.nextNode(), i++) {
            // A text node on its own (a title we put our AI chip after has a child now, and is
            // still the title), or a whole leaf (React splits one name over several text nodes).
            const text = n.nodeType === 3 ? n.data : (n.children.length ? '' : n.textContent);
            if (!text || text.length > 300 || !wants.has(norm(text))) continue;
            const spot = nameEnd(n);
            if (spot) return spot;
        }
        return null;
    }

    // Beside the game's name wherever Steam shows it (its own hover preview included), else
    // beside the wishlist star, matched to the star's size, else the capsule's own corner.
    function buttonSpot(el, id) {
        const names = [titleNear(el), (cacheGet(id) || {}).name, hidden[id], capsuleAlt(el)];
        const roots = [];
        if (POPOVERS) for (const p of document.querySelectorAll('[popover]')) {
            if (p === hoverBtn || !p.matches(':popover-open')) continue;
            if ([...p.querySelectorAll('a[href*="/app/"]')].some(a => appIdOf(a) === id)) roots.push(p);   // Steam's preview for this game
        }
        roots.push(el);
        for (const root of roots) {
            const r = nameSpot(root, names);
            if (r) return { left: r.right + BTN_GAP, top: r.top + (r.height - BTN_PX) / 2, size: BTN_PX };
        }
        for (const root of roots) {
            const star = onScreen(root.querySelector('.WishlistButton') || root.querySelector('.WishlistButtonText')?.parentElement);
            if (!star) continue;
            const s = star.getBoundingClientRect();
            const size = Math.round(Math.min(40, Math.max(18, s.height)));   // the star's own size
            return { left: s.left - size - BTN_GAP, top: s.top + (s.height - size) / 2, size };
        }
        const r = el.getBoundingClientRect();
        const spot = { left: r.right - BTN_PX - 4, top: r.top + 4, size: BTN_PX };
        // Signed in, Steam puts its own "…" menu button in that same corner of a capsule. Sit
        // just left of it, as beside the wishlist star, rather than on top of it.
        const more = onScreen((el.closest('[data-ds-appid]') || el).querySelector('.ds_options > div'));
        if (more) {
            const m = more.getBoundingClientRect();
            if (m.left < spot.left + BTN_PX && m.right > spot.left && m.top < spot.top + BTN_PX && m.bottom > spot.top)
                return { left: m.left - BTN_PX - BTN_GAP, top: m.top + (m.height - BTN_PX) / 2, size: BTN_PX };
        }
        return spot;
    }

    // Beside the name fails when the name is off screen or under Steam's sticky menu: then take the
    // card's own corner, low enough to clear whatever covers the card's top.
    function clearSpot(spot, box) {
        const free = (x, y) => {
            if (y < 0 || y + spot.size > innerHeight || x < 0 || x + spot.size > innerWidth) return false;
            const e = document.elementsFromPoint(x + spot.size / 2, y + spot.size / 2).find(n => !n.closest('.sgai_hide'));
            if (!e || e.closest('[popover]:popover-open')) return true;
            if (!hoverEl.contains(e)) return false;
            // Inside the card, but on one of Steam's controls: "Find More like this", the star.
            const ctl = e.closest('a[href], button, [role="button"]');
            return !ctl || ctl === hoverEl || ctl.contains(hoverEl) || (ctl.matches('a[href]') && appIdOf(ctl) === hoverId);
        };
        if (free(spot.left, spot.top)) return spot;
        const left = box.right - spot.size - 4;
        for (let y = Math.max(box.top, 0) + 4; y + spot.size <= Math.min(box.bottom, innerHeight); y += 8)
            if (free(left, y)) return { left, top: y, size: spot.size };
        return spot;
    }

    function syncHoverButton() {
        if (!hoverBtn || !hoverEl || !hoverEl.isConnected) return;
        // The card has just been hidden, or collapsed: nothing is left to sit beside, and the
        // fallback spot would be the corner of the screen.
        const box = hoverEl.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) { showHoverBtn(false); return; }
        const on = hoverId in hidden;
        if (hoverBtn.dataset.on !== String(on)) {          // redrawn only when it changes
            hoverBtn.dataset.on = on;
            hoverBtn.classList.toggle('sgai_hide_on', on);
            hoverBtn.innerHTML = EYE_SVG[on ? 'open' : 'shut'];
            hoverBtn.title = (on ? 'Show this game again' : 'Hide this game') + `\n\n${SIGNATURE}`;
        }
        const spot = clearSpot(buttonSpot(hoverEl, hoverId), box);
        const style = styleOf(hoverBtn, '.sgai_hide');
        style.width = style.height = spot.size + 'px';
        style.left = Math.round(Math.min(innerWidth - spot.size - 2, Math.max(2, spot.left))) + 'px';
        style.top = Math.round(Math.min(innerHeight - spot.size - 2, Math.max(2, spot.top))) + 'px';
        showHoverBtn(true);                                  // after the move, so the cover check sees where it is
    }
    const hideHoverSoon = () => {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = setTimeout(() => { if (hoverBtn) showHoverBtn(false); hoverEl = hoverId = null; }, 120);
    };

    // Delegated: one listener, and it covers capsules added later. Resolved from the link, not the
    // scanner's tag: Steam re-renders a sale card on hover and the fresh node has no tag yet.
    const onScreen = el => el && el.getBoundingClientRect().height > 6 ? el : null;
    function capsuleUnder(target) {
        if (!target || !target.closest) return null;
        // A sale widget is a whole card (image on one side, title, tags and buttons on the other),
        // and pointing at its text half is still pointing at that game.
        const card = target.closest('.StoreSaleWidgetOuterContainer, .LibraryAssetExpandedDisplay');
        if (card) {
            const id = appIdOf(card.querySelector('a[href*="/app/"]'));
            if (validId(id)) return { el: card, id };
        }
        const el = target.closest('[data-sgai-id], [data-ds-appid], a[href*="/app/"]');
        if (el) {
            const id = el.dataset.sgaiId || appIdOf(el);
            if (validId(id)) return { el, id };
        }
        // Pointing at a row's padding still means that row's game: take the nearest box around the pointer
        // that mentions exactly one game. Size first, stop at a second game: this runs on every pointer move.
        for (let n = target, i = 0; n && i < 4 && n !== document.body; n = n.parentElement, i++) {
            const r = n.getBoundingClientRect();
            if (r.height > 600) break;                       // a whole list, not a row
            if (r.width < 120 || r.height < 30) continue;
            let id = null;
            for (const l of n.querySelectorAll('a[href*="/app/"], [data-ds-appid]')) {
                const x = appIdOf(l);
                if (!x || x === id || aside(l)) continue;
                if (id) return null;                         // two games: so is everything above
                id = x;
            }
            if (id) return { el: n, id };
        }
        return null;
    }
    const inBox = (el, x, y) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    };
    function watchHover(e) {
        if (!STYLES_OK) return;
        // Hovering makes Steam re-render the card, and its events name links elsewhere: only a capsule the
        // pointer is really inside counts, or the button jumps across the screen.
        let c = capsuleUnder(e.target);
        if (c && !inBox(c.el, e.clientX, e.clientY)) {
            // A link drawn inline, its picture spilling out of it (/recommended/): the card around it.
            const up = c.el.parentElement && c.el.parentElement.closest('[data-ds-appid]');
            c = up && appIdOf(up) === c.id && inBox(up, e.clientX, e.clientY) ? { el: up, id: c.id } : null;
        }
        if (c && (cacheGet(c.id) || {}).notApp) c = null;  // a Labs banner, the recommender's button
        // On a game's own page the title has its own button; its header and media are the page, not a card,
        // as is a DLC/demo/soundtrack page's link to its game. Only the carousels get the hover button.
        if (c && APP_PAGE_ID && !c.el.closest(APP_CAROUSELS)) c = null;
        if (c && c.id === dlcPageGame()) c = null;
        if (!c) {
            // Steam lays its own overlay over a capsule when you point at it, and that overlay is
            // not inside the game's link: going by the pointer's position keeps the button up.
            if ((hoverBtn && hoverBtn.contains(e.target)) || inBox(hoverEl, e.clientX, e.clientY) || inBox(hoverBtn, e.clientX, e.clientY))
                clearTimeout(hoverHideTimer);
            else hideHoverSoon();
            return;
        }
        const r = c.el.getBoundingClientRect();
        if (r.width < 60 || r.height < 34) {                 // too small to carry a button
            // …but the same game's own title link is still that game; another game's is not.
            if (c.id !== hoverId && !inBox(hoverEl, e.clientX, e.clientY)) hideHoverSoon();
            return;
        }
        clearTimeout(hoverHideTimer);
        hoverButton();
        const moved = c.el !== hoverEl;
        hoverEl = c.el;
        hoverId = c.id;
        syncHoverButton();
        if (moved) bumpSoon();
    }
    addEventListener('pointerover', watchHover, { passive: true, capture: true });
    // Out of the window altogether: nothing else would say the pointer left the card.
    document.addEventListener('pointerout', e => { if (!e.relatedTarget && hoverEl) hideHoverSoon(); }, { passive: true });
    // Once a frame at most; capture, so a list scrolling inside the page moves it as well.
    let hoverFrame = 0;
    addEventListener('scroll', () => {
        if (!hoverEl || hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; syncHoverButton(); });
    }, { passive: true, capture: true });

    // Undo everything this entry put on the page, scan marks included, so a card React re-attaches or
    // recycles for another game can go through scan() again.
    function detach(m) {
        if (m.node) m.node.remove();
        if (m.host) releaseHost(m.host);
        if (m.target) untag(m, managed, 'sgai_ai');
        seen.delete(m.el);
        try { delete m.el.dataset.sgai; delete m.el.dataset.sgaiId; } catch (e) { /* not an element any more */ }
        for (const a of ['data-sgai-card', 'data-sgai-desc', 'data-sgai-err']) {
            const holder = m.el.closest?.(`[${a}~="${m.id}"]`);
            if (holder) unclaim(holder, a, m.id);
        }
    }

    // Both filters hang off two attributes on <html>, which some pages (the charts app re-renders the
    // whole document) drop. Cheap to check, so checked on every touch and watched besides.
    function keepFlags() {
        const d = document.documentElement;
        if (d.dataset.sgaiMode !== MODE) applyMode();
        if (d.dataset.sgaiOwn !== OWN) applyOwn();
    }
    const RECHECKS = 20;                                     // sweeps an unrecognised card edge is retried
    // Re-adds badges a re-render removed, prunes dead hosts, and drops entries recycled for another game.
    // Runs on every mutation batch, so an entry still in place costs two isConnected checks and nothing else.
    function heal(force) {
        keepFlags();
        syncTitleHide();
        healOwn(force);
        const todo = [];
        for (let i = managed.length - 1; i >= 0; i--) {
            const m = managed[i];
            if (!m.el.isConnected) { detach(m); managed.splice(i, 1); continue; }
            const own = currentId(m.el);
            if (own && own !== m.id) { detach(m); managed.splice(i, 1); continue; }
            if (force || !placedOk(m)) { todo.push(m); continue; }
            if (!filtering()) continue;
            // Never worked out in this mode; or a re-render dropped the card, or rewrote its class
            // list and took our tag with it.
            if (!m.settled || (m.target && (!m.target.isConnected || !m.target.classList.contains('sgai_ai')))) todo.push(m);
            // A card whose edge we couldn't recognise may just not be fully drawn yet: React sale
            // widgets arrive image first, title later. Look again on the next few sweeps.
            else if (!m.sure && (m.rechecks = (m.rechecks || 0) + 1) <= RECHECKS) todo.push(m);
        }
        // Measure every card, then write. Interleaved, each game's class change forced a fresh
        // layout for the next game's measurement: seconds, on a long list after a mode switch.
        const found = todo.map(m => (filtering() ? aiTarget(m) : null));
        todo.forEach((m, i) => { markAI(m, found[i]); placeBadge(m); });
        packSoon();
    }

    // Listing scanner (lazy, via IntersectionObserver)
    // Entries are unobserved as handled, so a throw here is never redelivered and would strand the rest
    // of the batch: mark done first, then guard the work.
    const io = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target, id = el.dataset.sgaiId;
        el.dataset.sgai = 'done';
        if (!validId(id)) return;                              // not an appid we wrote
        try {
            ownEntry(el, id);                                  // the hand-hidden list, in every mode
            // …but no AI lookups in skip. Parked rather than done, so turning listings back on
            // looks these up too (see setMode).
            if (MODE === 'skip') { el.dataset.sgai = 'idle'; return; }
            if (!cacheGet(id)) checkBadge(el, true);           // going to the network: show it
            lookup(id).then(d => {
                checkBadge(el, false);
                // The node went away while we waited: forget it, so it is scanned again if React
                // puts it back. Or it now shows another game: its own scan handles that one.
                if (!el.isConnected) { seen.delete(el); delete el.dataset.sgai; delete el.dataset.sgaiId; return; }
                if (el.dataset.sgaiId !== id) return;
                if (d && d.cancelled) el.dataset.sgai = 'idle';
                else if (d && d.error) { errBadge(el, id); retryLater(el, id); }
                else { clearErr(el, id); if (d && d.ai) capBadge(el, d.text, id, d.name); }
            }).catch(err => { checkBadge(el, false); console.warn('[SteamGameAI] lookup rejected', id, err); });
        } catch (err) { console.warn('[SteamGameAI] scan failed', id, err); }
    }), { rootMargin: ROOT_MARGIN });

    // Scanned nodes, kept off the DOM: cloneNode copies attributes, so a cloned card would arrive
    // "already done". data-sgai is written too, only so the state shows when inspecting.
    const seen = new WeakSet();
    const fresh = el => !seen.has(el);
    const skip = el => { seen.add(el); el.dataset.sgai = 'skip'; delete el.dataset.sgaiId; };
    // Scanned already, but React has since pointed the node at another game: a list that reuses
    // its rows, a queue that advances in place. Scanned again as that game.
    const reused = (el, id) => !!el.dataset.sgaiId && el.dataset.sgaiId !== id;
    const due = (el, id) => fresh(el) || reused(el, id);

    // What a capsule is built from, image or not; a plain text link has none of it.
    const CAPSULE_PARTS = 'div, picture, video, source, svg, [style*="background"]';

    // Yields {el, id} for every unscanned capsule: data-ds-appid capsules, and in React layouts (sale
    // and event pages, hover popups) any <a href=".../app/<id>"> wrapping an <img>.
    function* candidates() {
        // Discovery Queue style "app video" cards have no /app/ link: the id comes from the capsule or
        // trailer URL. Yielded first, so it wins the per-card de-dupe over the smaller capsule link.
        for (const v of document.querySelectorAll('.AppVideoCtn')) {
            if (!fresh(v)) continue;
            const id = widgetAppId(v);
            if (id) yield { el: v, id }; else skip(v);
        }
        for (const el of document.querySelectorAll('[data-ds-appid]')) {
            const id = el.dataset.dsAppid;
            if (!due(el, id)) continue;
            if (el.matches('a[href]') && !hrefApp(el.getAttribute('href')) && !el.querySelector('img')) { skip(el); continue; }   // a button, not a capsule
            if (/^\d+$/.test(id || '')) yield { el, id }; else skip(el);
        }
        for (const a of document.querySelectorAll('a[href*="/app/"]')) {
            if (a.hasAttribute('data-ds-appid')) continue;            // the pass above has it, by its own id
            if (!fresh(a) && !a.dataset.sgaiId) continue;             // written off as a text link
            const id = hrefApp(a.getAttribute('href')), m = id && [, id];
            if (!due(a, m && m[1])) continue;
            if (a.closest('[data-ds-appid]') || a.querySelector('[data-ds-appid]')) { skip(a); continue; }  // data-ds-appid path handles these
            if (m && a.querySelector('img')) yield { el: a, id: m[1] };                // a capsule, not a text link
            // Text-only links (reviews, breadcrumbs) are never capsules and number thousands on a search page,
            // so they are written off. React capsules show the price before the lazy image, so only pure text counts.
            else if (a.textContent.trim() && !a.querySelector(CAPSULE_PARTS)) skip(a);
        }
        // Legacy #global_hover tooltip: no app link or capsule <img>; appid is in the element id.
        for (const h of document.querySelectorAll('[id^="hover_app_"]')) {
            const m = h.id.match(/^hover_app_(\d+)$/);
            if (!due(h, m && m[1])) continue;
            if (m) yield { el: h, id: m[1] }; else skip(h);
        }
        // Expanded sale widget: add the marker on its own line under the short description, where
        // it's easy to spot. The description has no app link: resolve the id from the widget.
        for (const desc of document.querySelectorAll('.StoreSaleWidgetShortDesc')) {
            if (!fresh(desc)) continue;
            const id = widgetAppId(desc);
            if (id) yield { el: desc, id }; else skip(desc);
        }
        // Homepage right-column preview panel: title + trailer, but no app link/appid; the id is
        // only in the screenshot/trailer asset URLs, so resolve it the same way as sale widgets.
        for (const p of document.querySelectorAll('.tab_preview')) {
            if (!fresh(p)) continue;
            const id = widgetAppId(p);
            if (id) yield { el: p, id }; else skip(p);
        }
    }

    // The appid of a box with no data-ds-appid or /app/ link, from the first Steam asset URL nearby. A
    // trailer's poster lives in the movie's own folder (/apps/<movie id>/.../movie_full.jpg), so it is skipped.
    const ASSET = 'img[src*="/apps/"], [data-background-image-url*="/apps/"], [style*="/apps/"], source[src*="/store_trailers/"]';
    const assetUrl = a => a.getAttribute('src') || a.getAttribute('data-background-image-url') || a.getAttribute('style') || '';
    const POSTER = /\/movie[\w.-]*\.(?:jpe?g|png|webp)/i;
    function widgetAppId(node) {
        for (let el = node, i = 0; el && i < 6; el = el.parentElement, i++) {
            const id = [...el.querySelectorAll('a[href*="/app/"]')].map(a => hrefApp(a.getAttribute('href'))).find(Boolean);
            if (id) return id;
            const asset = [...el.querySelectorAll(ASSET)].find(x => !POSTER.test(assetUrl(x)));
            if (asset) {
                const s = assetUrl(asset);
                const m = s.match(/\/apps\/(\d+)\//) || s.match(/\/store_trailers\/(?:steam\/apps\/)?(\d+)\//);
                if (m) return m[1];
            }
        }
        return null;
    }

    function scan() {
        for (const { el, id } of candidates()) {
            if (reused(el, id)) el.querySelector(':scope > .sgai_err')?.remove();   // the last game's
            seen.add(el);
            el.dataset.sgaiId = id;
            el.dataset.sgai = 'pending';
            // A game the user hid goes now, wherever it is on the page. Waiting for it to scroll
            // into view, as the AI lookups do, would leave it sitting there further down the list.
            if (id in hidden) ownEntry(el, id);
            io.observe(el);
        }
    }

    // The observer runs in every mode: it keeps the eye docked and re-asserts dropped badges. Sale pages
    // mutate every frame, so own-node batches are ignored and the rest coalesced, settling to idle when quiet.
    const SETTLE_MS = 250, IDLE_MS = 1000, IDLE_AFTER = 10;
    let timer = 0, lastRun = 0, fruitless = 0;

    // The hide button redraws its icon as it moves between games; that must not read as the page
    // changing, or every pointer move over a listing would set off a full sweep.
    const ourNode = n => n.nodeType === 1 && !!n.closest('.sgai_badge, .sgai_eye, .sgai_hide, .sgai_title_hide, .sgai_eye_follow, .sgai_dialog_back');
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
        // Each step on its own: one that throws must not take the rest down with it, for good.
        for (const step of [
            heal,            // first, so a node React reused for another game is let go of…
            scan,            // …and scanned again here as that game. Runs in every mode.
            ensureEye,
            ensureFollow,
            onNavigate,      // in case the history hook never fired: some sandboxes patch a copy
            readAppPage,     // still waiting on a pushState arrival
            packSoon,        // a carousel that just arrived gets watched from its first slides on
        ]) {
            try { step(); } catch (e) { console.warn('[SteamGameAI] sweep step failed:', step.name, e); }
        }
        fruitless = managed.length === had ? fruitless + 1 : 0;
    }

    function rescan(records) {
        if (timer || !worthLooking(records)) return;
        if (document.hidden) return;                         // nothing to see; visibilitychange rearms
        const wait = fruitless > IDLE_AFTER ? IDLE_MS
                   : (performance.now() - lastRun > SETTLE_MS ? 0 : SETTLE_MS);
        timer = setTimeout(sweep, wait);
    }
    addEventListener('visibilitychange', () => {
        if (document.hidden || !started) return;
        // Settings changed in another tab while this one was in the background.
        try {
            const mode = loadMode();
            if (mode !== MODE) setMode(mode);
            reloadHidden();
        } catch (e) { console.warn('[SteamGameAI] could not re-read settings', e); }
        rescan(null);
    });
    // documentElement, not body: a page that replaces its whole body would otherwise leave the
    // observer bound to a node nothing is attached to any more, and nothing would ever rescan.
    const pageObserver = new MutationObserver(rescan);
    // Prune expired rows once a day, when the page has nothing better to do.
    (window.requestIdleCallback || (fn => setTimeout(fn, 5000)))(() => {
        try { sweepCache(); } catch (e) { console.warn('[SteamGameAI] cache sweep failed', e); }
    });

    // Current app page: badge title + seed cache
    // Seed the cache only from a real store page: the age check and region notices share the URL and
    // read as "no disclosure". Pending until the page's own markup arrives, and never from the previous page.
    let appPageRead = false, staleName = null;
    function readAppPage() {
        if (!APP_PAGE_ID || appPageRead) return;
        try {
            const gated = document.querySelector('#app_agegate, .agegate_birthday_selector, .agegate_text_container');
            const real = document.querySelector('#appHubAppName, .apphub_AppName');
            if (!real || gated || real === staleName) return;
            const d = getDisclosure(document);
            d.name = appName(document);
            cacheSet(APP_PAGE_ID, d);
            if (d.ai) { markDisclosure(); titleBadge(d.text); }
            appPageRead = true;
            syncTitleHide();
        } catch (e) { console.warn('[SteamGameAI] could not read this app page', e); }
    }

    // pushState is the only sign of a new page: re-read what depends on the path and re-assert every
    // badge, since a game's own page decides cards and hiding differently.
    function onNavigate() {
        const now = appIdFromPath();
        if (now === APP_PAGE_ID) return;
        APP_PAGE_ID = now;
        appPageRead = false;
        staleName = document.querySelector('#appHubAppName, .apphub_AppName');
        readAppPage();
        heal(true);
    }
    // Best effort, and deliberately not the only signal: the sweep checks too.
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

    // Eye toggle in Steam's global header
    // One control for every mode, on the page itself, so nothing has to be reached for in the
    // userscript manager's menu.
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
    // Two controls, side by side: the AI one cycles its four modes, the second turns the user's
    // own hidden list on and off (alt-click empties it).
    let eye = null, ownEye = null, follow = null, followAI = null, followOwn = null;

    function syncEye() {
        for (const b of [eye, followAI]) {
            if (!b) continue;
            b.dataset.mode = MODE;
            b.innerHTML = EYE_SVG[EYE[MODE].open ? 'open' : 'shut'];
            b.title = `AI disclosure: ${EYE[MODE].label}\nClick to cycle. Next: ${EYE[nextMode()].label}\n\n${SIGNATURE}`;
        }
    }

    // A game's own page has no card for the pointer's button, so its title gets one. It adds or removes
    // the game for the rest of the store; nothing on this page is hidden by it.
    function syncTitleHide() {
        if (!STYLES_OK || !APP_PAGE_ID) return;
        const t = document.querySelector('#appHubAppName, .apphub_AppName');
        if (!t || t === staleName || document.querySelector('#app_agegate, .agegate_birthday_selector, .agegate_text_container')) return;
        const id = APP_PAGE_ID;
        let b = t.querySelector(':scope > .sgai_title_hide');
        if (!b) {
            b = makeEyeButton('sgai_title_hide', e => {
                e.preventDefault();
                e.stopPropagation();
                toggleHidden(t, b.dataset.id);
            });
            t.appendChild(b);
        }
        const on = id in hidden;
        if (b.dataset.on === String(on) && b.dataset.id === id) return;   // redrawn only when it changes
        b.dataset.on = on;
        b.dataset.id = id;
        b.classList.toggle('sgai_hide_on', on);
        b.innerHTML = EYE_SVG[on ? 'open' : 'shut'];
        b.title = (on ? 'Hidden from store listings. Click to show it again.' : 'Hide this game from store listings') + `\n\n${SIGNATURE}`;
        b.setAttribute('aria-label', on ? 'Show this game in store listings again' : 'Hide this game from store listings');
        b.setAttribute('aria-pressed', String(on));
    }

    function syncOwnButtons() {
        syncTitleHide();
        const n = hiddenCount();
        for (const b of [ownEye, followOwn]) {
            if (!b) continue;
            b.dataset.mode = OWN === 'hide' && n ? 'hide' : 'skip';   // lit only when it is doing something
            b.innerHTML = EYE_SVG[OWN === 'hide' ? 'shut' : 'open'];
            b.title = `Games you hid yourself: ${n} on the list, ${OWN === 'hide' ? 'hidden' : 'shown (faded)'}\n` +
                `Click to ${OWN === 'hide' ? 'show them again' : 'hide them'}. Alt-click to empty the list.\n\n${SIGNATURE}`;
        }
    }

    function makeEyeButton(className, act) {
        const b = document.createElement('div');
        b.className = className;
        b.setAttribute('role', 'button');
        b.setAttribute('tabindex', '0');
        b.addEventListener('click', e => act(e));
        b.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            act(e);
        });
        return b;
    }
    const aiEyeAct = () => setMode(nextMode());
    const ownEyeAct = e => (e.altKey ? unhideAll() : setOwn(OWN === 'hide' ? 'show' : 'hide'));

    // A selector list returns the first match in DOCUMENT order, and #global_header .content is an
    // ancestor of both other hosts and would always win, so the candidates are tried in order.
    const findEyeHost = () => ['#global_action_menu', '#global_actions', '#global_header .content']
        .map(sel => document.querySelector(sel)).find(Boolean);

    // The header is server-rendered, but a React page can re-render around it; sweep() calls this
    // so a dropped button comes back.
    function ensureEye() {
        // Without our stylesheet this div is a full-width block that pushed the store ~900px down and out of
        // the observer's reach. A missing button beats a broken page.
        if (!STYLES_OK) return;
        if (eye && eye.isConnected && ownEye.isConnected) {
            // A React layout can render its header after we gave up and floated the button in the
            // corner. Take the header now rather than sit on top of it for the rest of the session.
            if (!eye.classList.contains('sgai_eye_float') || dockFailed) return;   // the header hid it once
            const late = findEyeHost();
            if (!late) return;
            eye.classList.remove('sgai_eye_float');
            ownEye.classList.remove('sgai_eye_float', 'sgai_eye_float2');
            late.prepend(eye);
            eye.after(ownEye);
            alignEye();
            watchHeader();
            return;
        }
        eye?.remove();                                       // one of the pair survived: start over
        ownEye?.remove();
        eye = makeEyeButton('sgai_eye sgai_eye_dock', aiEyeAct);
        ownEye = makeEyeButton('sgai_eye sgai_own_eye sgai_eye_dock', ownEyeAct);
        lastShift = null;                                    // fresh element, nothing applied yet
        dockEye();
    }

    // Is the button really where a person can see and click it? Steam's header can clip, collapse or
    // cover it, and a button in the DOM but not on screen is no button.
    function eyeVisible() {
        if (!eye || !eye.isConnected) return false;
        const cs = getComputedStyle(eye);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
        const r = eye.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;                       // collapsed or clipped
        // Off the page itself counts as hidden; merely scrolled away does not (the header scrolls with the
        // page), and that can't be judged from here, hence null.
        if (r.bottom + scrollY <= 0 || r.right + scrollX <= 0) return false;
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return !!hit && (hit === eye || eye.contains(hit));                  // or something covers it
    }

    // Prefer the header and fall back to the corner, but only after retries: a header that is merely
    // late looks exactly like one that swallowed the button.
    const DOCK_TRIES = 3, DOCK_RETRY_MS = 500;
    let dockFailed = false, dockTries = 0, dockTimer = 0;
    function dockEye() {
        const host = dockFailed ? null : findEyeHost();
        if (host) {
            eye.classList.remove('sgai_eye_float');
            ownEye.classList.remove('sgai_eye_float', 'sgai_eye_float2');
            host.prepend(eye);
            eye.after(ownEye);
            syncEye();
            syncOwnButtons();
            alignEye();
            watchHeader();
            if (eyeVisible() !== false) { dockTries = 0; return; }   // visible, or scrolled away
            if (++dockTries < DOCK_TRIES) {                  // still settling? look again shortly
                if (!dockTimer) dockTimer = setTimeout(() => { dockTimer = 0; dockEye(); }, DOCK_RETRY_MS);
                return;
            }
            dockFailed = true;                               // the header is real, and it hid us
            console.warn('[SteamGameAI] the header will not show the eye button; moving it to the corner');
        }
        // The corner: stack the pair there, the AI one on top.
        eye.classList.add('sgai_eye_float');
        ownEye.classList.add('sgai_eye_float', 'sgai_eye_float2');
        setEyeShift(0);
        document.body.append(eye, ownEye);
        syncEye();
        syncOwnButtons();
    }

    // The header floats its items from the top, so our taller button hangs below their centre line by
    // an amount that differs signed in or out. Measure a real sibling and nudge with a transform.
    function alignEye() {
        if (!eye || !eye.isConnected || eye.classList.contains('sgai_eye_float')) return;
        setEyeShift(0);                                      // measure untransformed
        const sib = [...eye.parentElement.children].find(n => {
            if (n === eye || n === ownEye) return false;
            const pos = getComputedStyle(n).position;
            if (pos === 'absolute' || pos === 'fixed') return false;   // an open dropdown, not a row item
            return n.getBoundingClientRect().height > 0;
        });
        if (!sib) return;                                    // nothing to line up with
        const mine = eye.getBoundingClientRect(), theirs = sib.getBoundingClientRect();
        if (!mine.height || !theirs.height) return;          // header not laid out yet
        setEyeShift(Math.round((theirs.top + theirs.height / 2) - (mine.top + mine.height / 2)));
    }
    // The header's items resize after we align (avatar, cart count) with no event to tell us: measured
    // 11px off. Re-pointed whenever the pair docks, as that may be a different header.
    let headerRO = null;
    function watchHeader() {
        if (typeof ResizeObserver !== 'function' || !eye?.parentElement) return;
        headerRO = headerRO || new ResizeObserver(() => alignSoon());
        headerRO.disconnect();
        headerRO.observe(eye.parentElement);
    }

    let lastShift = null;
    function setEyeShift(px) {
        if (px === lastShift) return;                        // the common case: nothing moved
        lastShift = px;
        const value = px ? `translateY(${px}px)` : '';
        for (const b of [eye, ownEye]) if (b) styleOf(b, '.sgai_eye_dock').transform = value;
    }

    // The eye that follows you down the page
    // Once the header's eye scrolls away, a second one pins to the top: level with Steam's sticky store
    // menu when there is room beside it, else just under it, below any other pinned bar.
    const EYE_PX = 26, FOLLOW_GAP = 12;
    let followOn = false, followIO = null, watched = null, navEl = null, followFrame = 0;

    function ensureFollow() {
        if (!STYLES_OK || typeof IntersectionObserver !== 'function' || !document.body) return;
        if (!follow) {
            follow = document.createElement('div');
            follow.className = 'sgai_eye_follow';
            followAI = makeEyeButton('sgai_eye', aiEyeAct);
            followOwn = makeEyeButton('sgai_eye sgai_own_eye', ownEyeAct);
            follow.append(followAI, followOwn);
            syncEye();
            syncOwnButtons();
        }
        if (!follow.isConnected) document.body.appendChild(follow);    // a body swap drops it
        // Steam's store menu is React and can arrive after we first placed the pair, which would
        // otherwise leave them parked in the fallback corner until the next scroll.
        if (followOn) placeFollow();
        if (watched === eye) return;
        followIO?.disconnect();
        watched = eye;
        followOn = null;                                    // unknown until the observer reports
        followIO = new IntersectionObserver(es => setFollow(!es[es.length - 1].isIntersecting));
        if (eye) followIO.observe(eye);
    }

    function setFollow(on) {
        on = on && !!eye && eye.isConnected && !eye.classList.contains('sgai_eye_float');
        if (on === followOn) return;
        followOn = on;
        follow.classList.toggle('sgai_on', on);
        if (on) {
            placeFollow();
            addEventListener('scroll', followSoon, { passive: true });
            addEventListener('resize', followSoon);
        } else {
            removeEventListener('scroll', followSoon);
            removeEventListener('resize', followSoon);
        }
    }
    function followSoon() {
        if (followFrame) return;
        followFrame = requestAnimationFrame(() => { followFrame = 0; if (followOn) placeFollow(); });
    }

    // The store menu: the first box around its search field tall enough to be the whole bar.
    function storeNav() {
        const s = ['#store_nav_search_term', 'input[name="term"]'].map(q => document.querySelector(q)).find(Boolean);
        for (let n = s && s.parentElement, i = 0; n && i < 6; n = n.parentElement, i++)
            if (n.getBoundingClientRect().height >= 40) return n;
        return null;
    }

    // Bottom edge of the fixed/sticky thing at (x, y), or null; a zero-height sticky wrapper's
    // overflowing child counts. `own` is the store menu bar we ride beside, not something to dodge.
    function pinnedBottomAt(x, y, own) {
        for (const hit of document.elementsFromPoint(x, y)) {
            if (follow.contains(hit)) continue;
            for (let n = hit, below = null; n && n !== document.body && n !== document.documentElement; below = n, n = n.parentElement) {
                const pos = getComputedStyle(n).position;
                if (pos !== 'fixed' && pos !== 'sticky') continue;
                if (own && n.contains(own)) return null;
                return Math.max(n.getBoundingClientRect().bottom, below ? below.getBoundingClientRect().bottom : 0);
            }
            return null;                                     // the topmost real thing isn't pinned
        }
        return null;
    }

    function placeFollow() {
        if (!follow) return;
        const vw = document.documentElement.clientWidth;
        let left = vw - EYE_PX - FOLLOW_GAP, top = FOLLOW_GAP, beside = false;
        if (!navEl || !navEl.isConnected) navEl = storeNav();
        const r = navEl && navEl.getBoundingClientRect();
        if (r && r.height && r.bottom > 0) {
            if (vw - r.right >= EYE_PX + 2 * FOLLOW_GAP) {  // room beside it: level with it
                left = r.right + FOLLOW_GAP;
                top = Math.max(0, r.top + (r.height - EYE_PX) / 2);
                beside = true;
            } else top = Math.max(FOLLOW_GAP, r.bottom + 8); // no room: just under it
        }
        const bar = pinnedBottomAt(left + EYE_PX / 2, top + EYE_PX / 2, beside ? navEl : null);
        if (bar !== null) top = bar + 8;
        setFollowPos(Math.round(left), Math.round(top));
    }

    let lastPos = '';
    function setFollowPos(left, top) {
        const pos = left + ',' + top;
        if (pos === lastPos) return;
        lastPos = pos;
        const st = styleOf(follow, '.sgai_eye_follow');
        st.left = left + 'px';
        st.top = top + 'px';
    }

    // The avatar and Motiva Sans land after parse and move the header, so re-centre after load and on
    // layout changes. On a cached page `load` may already have fired at document-idle.
    if (document.readyState === 'complete') alignEye(); else addEventListener('load', alignEye);
    // Resize fires continuously while a window edge is dragged; one alignment per frame is plenty.
    let alignFrame = 0;
    const alignSoon = () => {
        if (alignFrame) return;
        alignFrame = requestAnimationFrame(() => { alignFrame = 0; alignEye(); });
    };
    addEventListener('resize', alignSoon);
    try { document.fonts?.ready.then(alignEye); } catch (e) { /* no FontFaceSet */ }

    // Menu
    // Modes live on the eye button; only the cache reset is left with nowhere better to sit.
    if (typeof GM_registerMenuCommand === 'function') {
        // The eye owns this normally, but it stands down when the page blocks our styles, and a
        // user left in hide mode with no visible control has no way back.
        GM_registerMenuCommand(`AI-disclosed games: ${EYE[MODE].label} (click to cycle)`, () => {
            setMode(nextMode());
            alert(`AI-disclosed games: ${EYE[MODE].label}.\n(The menu label updates on the next page load.)`);
        });
        GM_registerMenuCommand(`Show all games you hid (${hiddenCount()})`, unhideAll);
        GM_registerMenuCommand(`Export hidden games (${hiddenCount()})`, () => shareDialog('export'));
        GM_registerMenuCommand('Import hidden games', () => shareDialog('import'));
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

    // Start
    // Everything above ran at document-start so the list repack beats Steam. The rest needs a parsed
    // page: a body to measure styles against, the header, the capsules.
    let started = false;
    function start() {
        if (started) return;
        started = true;
        SHEET = installStyles();
        STYLES_OK = SHEET !== undefined;
        if (!STYLES_OK) console.warn('[SteamGameAI] page styles blocked; badges and the eye are stood down');
        INLINE_STYLES_OK = inlineStylesWork();
        keepFlags();
        new MutationObserver(keepFlags).observe(document.documentElement,
            { attributes: true, attributeFilter: ['data-sgai-mode', 'data-sgai-own'] });
        pageObserver.observe(document.documentElement, { childList: true, subtree: true });
        scan();
        readAppPage();
        ensureEye();
        ensureFollow();
        packSoon();
        prefetchReady = true;                                // what is on screen gets looked up first
        prefetchSoon(2000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
