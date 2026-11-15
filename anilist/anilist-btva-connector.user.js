// ==UserScript==
// @name         AniList BTVA Connector
// @namespace    https://github.com/ceeprus
// @version      1.0.13
// @description  Swap a voice actor's AniList roles for their Behind The Voice Actors roles: games, dubs, movies and more
// @icon         https://www.google.com/s2/favicons?sz=64&domain=anilist.co
// @author       ceeprus
// @license      MIT
// @match        https://anilist.co/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @connect      www.behindthevoiceactors.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/anilist/anilist-btva-connector.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/anilist/anilist-btva-connector.user.js
// ==/UserScript==

(function () {
    'use strict';

    // == pure: parse ==
    const MEDIA = ['tv_shows', 'movies', 'games', 'shorts', 'commercials', 'narration'];

    function parseRoles(html, baseUrl) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const roles = [];
        for (const row of doc.querySelectorAll('div.credit_pics_half')) {
            const medium = MEDIA.find(m => row.classList.contains('medium_msn_' + m));
            const head = row.querySelector('a.credit_pic_title');
            if (!medium || !head) continue;
            const b = head.querySelector('b');
            const year = b ? parseInt(b.textContent, 10) || null : null;
            // BTVA appends "(2026 TV Show)"; no-year rows (ads) have no suffix.
            const title = (b ? head.textContent.replace(/\s*\([^()]*\)\s*$/, '') : head.textContent).trim();
            const titleUrl = new URL(head.getAttribute('href'), baseUrl).href;
            for (const c of row.querySelectorAll('a.credit_pic_float')) {
                const img = c.querySelector('img');
                const src = img && (img.getAttribute('data-src') || img.getAttribute('src'));
                roles.push({
                    character: (c.getAttribute('title') || '').trim(),
                    charUrl: new URL(c.getAttribute('href'), baseUrl).href,
                    thumb: src ? new URL(src, baseUrl).href : '',
                    title, titleUrl, year, medium,
                });
            }
        }
        return roles.filter(r => r.character);
    }

    function parseBtvaPage(html, baseUrl) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const vafn = doc.querySelector('#vafn');
        if (!vafn) return null;
        const native = doc.querySelector('h2.red');
        return {
            vafn: vafn.value,
            sdd: (doc.querySelector('#sdd') || {}).value || '',
            name: (doc.querySelector('#page_title') || {}).textContent?.trim() || '',
            native: native ? native.textContent.trim() || null : null,
            roles: parseRoles(html, baseUrl),
        };
    }
    // == end pure: parse ==

    // == pure: match ==
    const fold = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    // AniList keeps long vowels (Shinichirou, Yuuki); BTVA drops them (Shinichiro, Yuki).
    const shortVowels = s => s.replace(/([oO])u/g, '$1').replace(/([uU])u/g, '$1').replace(/([oO])o/g, '$1');
    const slugPart = s => fold(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ /g, '-');

    // Each name part is tried with and without long vowels: Yuuichi Inoue is Yuichi-Inoue on BTVA (Inoue keeps its ou).
    function slugCandidates(name) {
        const named = [name.first, name.last].filter(Boolean);
        const parts = (named.length ? named : [name.full]).map(slugPart).filter(Boolean);
        let combos = [''];
        for (const p of parts) combos = combos.flatMap(c => [...new Set([shortVowels(p), p])].map(v => (c ? c + '-' : '') + v));
        return [...new Set(combos)].filter(Boolean).slice(0, 4);
    }

    function nativeMatches(anilistNative, btvaNative, anilistFull, btvaName) {
        const bare = s => (s || '').replace(/\s+/g, '');
        if (bare(anilistNative) && bare(btvaNative)) return bare(anilistNative) === bare(btvaNative);
        const key = s => shortVowels(slugPart(s)).toLowerCase();
        return !!key(anilistFull) && key(anilistFull) === key(btvaName);
    }
    // == end pure: match ==

    // == pure: view ==
    const MEDIUM_LABEL = { tv_shows: 'Show', movies: 'Movie', games: 'Game', shorts: 'Short', commercials: 'Ad', narration: 'Narr.' };

    // Returns [{year, roles}]; year undefined = one ungrouped block (Title sort). null year = "TBA".
    function viewRoles(roles, tab, sort) {
        const list = roles.filter(r => tab === 'all' || r.medium === tab);
        if (!list.length) return [];
        if (sort === 'title') return [{ year: undefined, roles: [...list].sort((a, b) => a.title.localeCompare(b.title)) }];
        const groups = new Map();
        for (const r of list) {
            if (!groups.has(r.year)) groups.set(r.year, []);
            groups.get(r.year).push(r);
        }
        // AniList lists TBA first under Newest and last under Oldest.
        const rank = y => (y === null ? Infinity : y);
        const years = [...groups.keys()].sort((a, b) => sort === 'oldest' ? rank(a) - rank(b) : rank(b) - rank(a));
        return years.map(year => ({ year, roles: groups.get(year) }));
    }

    // BTVA's tab numbers count titles, not characters.
    function tabCounts(roles) {
        const counts = { all: 0 };
        for (const m of Object.keys(MEDIUM_LABEL)) counts[m] = new Set(roles.filter(r => r.medium === m).map(r => r.titleUrl)).size;
        counts.all = new Set(roles.map(r => r.titleUrl)).size;
        return counts;
    }
    // == end pure: view ==

    // == client ==
    const BTVA = 'https://www.behindthevoiceactors.com/';
    const DAY = 86400000;

    const realDeps = () => ({
        // anonymous:false sends the browser's BTVA cookies, so a solved Cloudflare check (cf_clearance) carries over.
        gmRequest: o => new Promise((resolve, reject) => GM_xmlhttpRequest({
            ...o, anonymous: false, onload: resolve, onerror: reject, ontimeout: reject, timeout: 20000,
        })),
        gmGet: GM_getValue, gmSet: GM_setValue, gmList: GM_listValues, gmDelete: GM_deleteValue, now: Date.now,
    });

    // Normal BTVA pages also load Cloudflare's challenge-platform script, so only the interstitial itself counts.
    const isChallenge = res => res.status === 403 || res.status === 503
        || /<title>Just a moment|cf-chl/i.test(res.responseText || '');

    async function loadBtva(staff, deps = realDeps(), onStep = () => {}) {
        const key = 'btva:' + staff.id;
        const cached = deps.gmGet(key, null);
        if (cached && deps.now() - cached.at < DAY) return cached.notfound ? { state: 'notfound' } : { state: 'ok', url: cached.url, roles: cached.roles };

        // Yesterday's roles beat an error message when BTVA is blocked or down.
        const fail = (r, why) => {
            console.warn('[BTVA Connector]', r.state + ':', why); // the only clue when one browser works and another doesn't
            return cached && cached.roles ? { state: 'ok', url: cached.url, roles: cached.roles } : r;
        };
        const pin = deps.gmGet('btvaPin:' + staff.id, '');
        const urls = pin ? [pin] : slugCandidates(staff.name).map(s => BTVA + s + '/');
        try {
            for (const url of urls) {
                const res = await deps.gmRequest({ method: 'GET', url });
                if (isChallenge(res)) return fail({ state: 'blocked', url }, 'GET ' + res.status + ' ' + url);
                if (res.status === 404) continue;
                if (res.status !== 200) return fail({ state: 'error' }, 'GET ' + res.status + ' ' + url);
                const page = parseBtvaPage(res.responseText, url);
                if (!page) continue;
                if (!pin && !nativeMatches(staff.name.native, page.native, staff.name.full, page.name)) continue;

                onStep('rest');
                // The request BTVA's own page sends on scroll: every role after the newest titles, in one response.
                const rest = await deps.gmRequest({
                    method: 'POST', url: BTVA + 'actors_chars_ga.php',
                    data: new URLSearchParams({ vafn: page.vafn, sdd: page.sdd }).toString(),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    overrideMimeType: 'text/html; charset=windows-1252', // served as ISO-8859-1
                });
                if (isChallenge(rest)) return fail({ state: 'blocked', url }, 'POST ' + rest.status);
                if (rest.status !== 200) return fail({ state: 'error' }, 'POST ' + rest.status);
                const seen = new Set();
                const roles = [...page.roles, ...parseRoles(rest.responseText, url)]
                    .filter(r => !seen.has(r.charUrl) && seen.add(r.charUrl));
                // Userscript managers load every stored value on each page, so drop other VAs' expired caches.
                for (const k of deps.gmList ? deps.gmList() : []) {
                    const v = k.startsWith('btva:') && deps.gmGet(k, null);
                    if (v && !(deps.now() - v.at < DAY)) deps.gmDelete(k);
                }
                deps.gmSet(key, { at: deps.now(), url, roles });
                return { state: 'ok', url, roles };
            }
        } catch (e) {
            return fail({ state: 'error' }, e); // offline, timeout or a parser bug: a Cloudflare refusal arrives as a 403 response
        }
        // A miss costs up to four page requests; remember it so the next click sends none. Fix link clears it.
        deps.gmSet(key, { at: deps.now(), notfound: true });
        return { state: 'notfound' };
    }
    // == end client ==

    // == ui ==
    const TABS = [['all', 'All'], ['tv_shows', 'Shows'], ['movies', 'Movies'], ['games', 'Games'], ['shorts', 'Shorts'], ['commercials', 'Ads'], ['narration', 'Narr.']];
    const SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['title', 'Title']];
    const PIN_RE = /^https:\/\/www\.behindthevoiceactors\.com\/[^/?#\s]+\/?$/;
    // AniList theme colours as "r,g,b" custom properties; fallbacks are its dark theme. The switch copies its sort label (gray-600, hover gray-700, .3s).
    const CSS = `
#btva-switch{flex:none;white-space:nowrap;margin:-6px 0;background:none;border:0;padding:6px 0;font:inherit;font-size:1.3rem;font-weight:600;color:rgb(var(--color-gray-600,116,136,153));cursor:pointer;transition:color .3s}
#btva-switch:hover,#btva-switch:focus-visible{color:rgb(var(--color-gray-700,139,160,178))}
.btva-tabs{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0 0 20px}
.btva-tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:4px 0;min-height:32px;font:inherit;font-size:1.3rem;font-weight:600;color:rgb(var(--color-text-light,139,160,178));cursor:pointer;transition:color .3s}
.btva-tabs button:hover,.btva-tabs button:focus-visible,.btva-tabs button[aria-selected=true]{color:rgb(var(--color-blue,61,180,242))}
.btva-tabs button[aria-selected=true]{border-bottom-color:currentColor}
.btva-tabs small{font-size:1.1rem;font-weight:400;margin-left:4px;font-variant-numeric:tabular-nums}
.btva-note,.btva-foot{font-size:1.4rem;color:rgb(var(--color-text-light,139,160,178));margin:20px 0}
.btva-foot{display:flex;justify-content:flex-end;gap:16px;font-size:1.3rem}
.btva-note a,.btva-foot a,.btva-link{color:rgb(var(--color-blue,61,180,242));background:none;border:0;padding:0;font:inherit;font-weight:600;cursor:pointer}
.btva-note a:hover,.btva-foot a:hover,.btva-link:hover{text-decoration:underline}
#btva-sort .option{cursor:pointer}
#btva-roles{margin-top:80px}
#btva-roles.btva-fallback .grid-wrap{display:grid;grid-template-columns:repeat(auto-fill,146px);gap:28px 30px;justify-content:space-between;margin-bottom:40px}
#btva-roles.btva-fallback .cover{display:block;height:209px;border-radius:4px;overflow:hidden;background:rgb(var(--color-foreground,21,31,46))}
#btva-roles.btva-fallback .cover img{width:100%;height:100%;object-fit:cover}
#btva-roles.btva-fallback .titles{padding-top:8px}
#btva-roles.btva-fallback .titles>.title{font-size:1.4rem;color:rgb(var(--color-text,139,160,178))}
#btva-roles.btva-fallback .role{font-size:1.1rem;margin-left:4px;color:rgb(var(--color-text-lighter,116,136,153))}
#btva-roles.btva-fallback .relation-title{display:block;margin-top:4px;font-size:1.2rem;color:rgb(var(--color-text-lighter,116,136,153))}
#btva-roles.btva-fallback h3.year{font-size:2.2rem;font-weight:800;color:rgb(var(--color-text,139,160,178));margin:22px 0 20px}`;

    // Elements built "like" AniList's carry its data-v-* attributes, so Vue's scoped styles apply to them.
    function like(ref, tag, cls) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (ref) for (const a of ref.attributes) if (a.name.startsWith('data-v-')) el.setAttribute(a.name, '');
        return el;
    }
    const httpsOnly = url => (/^https:\/\//i.test(url || '') ? url : '');
    function setLink(a, url) {
        url = httpsOnly(url);
        if (url) a.href = url; else a.removeAttribute('href');
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    }

    let current = null;
    const thumbs = new Map(); // thumb URL -> promise of its blob URL ('' if that failed too); one fetch per page load

    function mountStaff(staffId, deps) {
        const filters = document.querySelector('.staff-wrap .filters');
        const wrap = filters.closest('.staff-wrap');
        const aniSort = filters.querySelector('.mini-select.sort');
        const aniRoles = () => wrap.querySelector('.character-roles:not(#btva-roles)');
        if (!document.getElementById('btva-style')) {
            const style = document.createElement('style');
            style.id = 'btva-style';
            style.textContent = CSS;
            document.head.append(style);
        }
        const st = { on: false, tab: 'all', sort: 'newest', data: null, staff: null };
        const menuClose = new AbortController();

        const btn = document.createElement('button');
        btn.id = 'btva-switch';
        btn.type = 'button';
        btn.dataset.staff = String(staffId);
        btn.textContent = 'Switch to BTVA';
        filters.prepend(btn);

        let sort;
        if (aniSort) {
            sort = aniSort.cloneNode(true);
            sort.querySelector('.dropdown')?.remove();
        } else {
            sort = like(null, 'div', 'mini-select sort');
            sort.append(like(null, 'span', 'label'));
        }
        sort.id = 'btva-sort';
        sort.tabIndex = 0;
        sort.setAttribute('role', 'button');
        sort.setAttribute('aria-haspopup', 'listbox');
        const sortLabel = sort.querySelector('.label');
        sortLabel.textContent = 'Newest';
        if (aniSort) aniSort.after(sort); else filters.append(sort);

        const panel = like(aniRoles(), 'div', 'character-roles container');
        panel.id = 'btva-roles';
        // AniList's .filters bar has a negative bottom margin and overlays the first roles block; sit where its character list sits.
        const ani = aniRoles(), rolesWrap = wrap.querySelector('.roles-wrap') || wrap;
        if (ani) ani.after(panel); else rolesWrap.prepend(panel);

        function closeMenu() {
            sort.querySelector('.dropdown')?.remove();
            sort.setAttribute('aria-expanded', 'false');
        }
        function openMenu() {
            const dd = like(sortLabel, 'div', 'dropdown');
            dd.setAttribute('role', 'listbox');
            for (const [key, label] of SORTS) {
                const opt = like(sortLabel, 'div', 'option' + (key === st.sort ? ' active' : ''));
                opt.textContent = label;
                opt.tabIndex = 0;
                opt.setAttribute('role', 'option');
                opt.setAttribute('aria-selected', String(key === st.sort));
                opt.addEventListener('click', e => {
                    e.stopPropagation();
                    st.sort = key;
                    sortLabel.textContent = label;
                    closeMenu();
                    render();
                    sort.focus();
                });
                opt.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.click(); } });
                dd.append(opt);
            }
            // AniList's menu fades in through Vue's transition classes; borrow them so ours moves the same way.
            if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
                dd.classList.add('dropdown-animation-enter', 'dropdown-animation-enter-active');
                dd.addEventListener('animationend', () => dd.classList.remove('dropdown-animation-enter', 'dropdown-animation-enter-active'), { once: true });
            }
            sort.append(dd);
            sort.setAttribute('aria-expanded', 'true');
        }
        sort.addEventListener('click', () => (sort.querySelector('.dropdown') ? closeMenu() : openMenu()));
        sort.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!sort.querySelector('.dropdown')) openMenu();
                const opts = [...sort.querySelectorAll('.option')], i = opts.indexOf(e.target);
                const j = i < 0 ? opts.findIndex(o => o.classList.contains('active')) : Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
                return opts[j]?.focus();
            }
            if (e.target !== sort) { if (e.key === 'Escape') { closeMenu(); sort.focus(); } return; }
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort.click(); }
            if (e.key === 'Escape') closeMenu();
        });
        document.addEventListener('click', e => { if (!sort.contains(e.target)) closeMenu(); }, { signal: menuClose.signal });
        // After "Open BTVA" the Cloudflare cookie exists; retry as soon as the user is back on this tab.
        const retryBlocked = () => {
            if (document.hidden || !st.on || st.data?.state !== 'blocked') return;
            st.data = null;
            load();
            render();
        };
        document.addEventListener('visibilitychange', retryBlocked, { signal: menuClose.signal });
        window.addEventListener('focus', retryBlocked, { signal: menuClose.signal });

        function sync() {
            const a = aniRoles();
            if (a) a.style.display = st.on ? 'none' : '';
            if (aniSort) aniSort.style.display = st.on ? 'none' : '';
            sort.style.display = st.on ? '' : 'none';
            panel.style.display = st.on ? '' : 'none';
        }

        function note(...parts) {
            const p = document.createElement('p');
            p.className = 'btva-note';
            p.setAttribute('role', 'status');
            p.append(...parts);
            return p;
        }
        function link(text, url) {
            const a = document.createElement('a');
            setLink(a, url);
            a.textContent = text;
            return a;
        }
        function fixLink() {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btva-link';
            b.textContent = 'Wrong person? Fix link';
            b.addEventListener('click', () => {
                const answer = deps.prompt('Paste this person\'s BTVA page link, like https://www.behindthevoiceactors.com/Shinichiro-Miki/', st.data?.url || '');
                if (answer == null) return;
                const url = answer.trim();
                if (!PIN_RE.test(url)) {
                    panel.querySelector('.btva-warn')?.remove();
                    const warn = note('That isn\'t a BTVA person link. It looks like https://www.behindthevoiceactors.com/Shinichiro-Miki/');
                    warn.classList.add('btva-warn');
                    panel.append(warn);
                    return;
                }
                deps.gmSet('btvaPin:' + staffId, url.endsWith('/') ? url : url + '/');
                deps.gmDelete('btva:' + staffId);
                st.data = null;
                load(); // first: it resets the loading step before the note is drawn
                render();
            });
            return b;
        }

        function card(r, tpl) {
            let c;
            if (tpl) {
                c = tpl.cloneNode(true);
                c.querySelector('.relation-image')?.remove();
            } else {
                c = document.createElement('div');
                c.className = 'role-card';
                c.innerHTML = '<a class="cover"><img class="image"></a><div class="titles"><a class="title"></a><div class="relations"><a class="title relation-title"></a></div></div>';
            }
            const cover = c.querySelector('.cover'), img = cover.querySelector('img');
            setLink(cover, r.charUrl);
            img.referrerPolicy = 'no-referrer';
            img.loading = 'lazy';
            img.alt = '';
            img.className = 'image loaded';
            const src = httpsOnly(r.thumb);
            // Firefox sends no BTVA cookie with page images, so Cloudflare can refuse them; the manager's request carries it.
            if (thumbs.has(src)) thumbs.get(src).then(u => { img.src = u || src; });
            else {
                img.src = src;
                if (src) img.addEventListener('error', () => {
                    if (!thumbs.has(src)) thumbs.set(src, deps.gmRequest({ method: 'GET', url: src, responseType: 'blob' })
                        .then(res => (res.status === 200 && res.response ? URL.createObjectURL(res.response) : ''), () => ''));
                    thumbs.get(src).then(u => { if (u) img.src = u; });
                }, { once: true });
            }
            const name = c.querySelector('.titles > .title');
            const roleTpl = name.querySelector('.role');
            setLink(name, r.charUrl);
            name.replaceChildren(document.createTextNode(' ' + r.character));
            if (st.tab === 'all') {
                const tag = roleTpl || like(name, 'span', 'role');
                tag.textContent = MEDIUM_LABEL[r.medium];
                name.append(tag);
            }
            const rel = c.querySelector('.relation-title');
            setLink(rel, r.titleUrl);
            rel.textContent = r.title;
            rel.title = r.title;
            return c;
        }

        function render() {
            panel.replaceChildren();
            const d = st.data;
            if (!d) return panel.append(note(st.step === 'rest' ? 'Loading more roles…' : 'Loading BTVA roles…'));
            if (d.state === 'error') return panel.append(note('Couldn\'t load BTVA roles. Switch again to retry.'));
            if (d.state === 'blocked') return panel.append(note('BTVA needs one visit before roles can load. ', link('Open BTVA', d.url), ' Roles load when you come back to this tab.'));
            if (d.state === 'notfound') return panel.append(note('No BTVA page found for this person. ', fixLink()));

            const counts = tabCounts(d.roles);
            const tabs = document.createElement('div');
            tabs.className = 'btva-tabs';
            tabs.setAttribute('role', 'tablist');
            for (const [key, label] of TABS) {
                const t = document.createElement('button');
                t.type = 'button';
                t.setAttribute('role', 'tab');
                t.id = 'btva-tab-' + key;
                t.setAttribute('aria-controls', 'btva-tabpanel');
                t.setAttribute('aria-selected', String(key === st.tab));
                t.tabIndex = key === st.tab ? 0 : -1; // one tab stop; arrows move inside the list
                const n = document.createElement('small');
                n.textContent = counts[key];
                t.append(label, ' ', n);
                t.addEventListener('click', () => {
                    st.tab = key;
                    render();
                    panel.querySelector('[role=tab][aria-selected=true]')?.focus();
                });
                tabs.append(t);
            }
            // Arrows, Home and End move and select at once: switching a tab only redraws, it fetches nothing.
            tabs.addEventListener('keydown', e => {
                const i = TABS.findIndex(([key]) => key === st.tab), n = TABS.length;
                const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
                if (next === undefined) return;
                e.preventDefault();
                tabs.children[next].click();
            });
            panel.append(tabs);
            const body = document.createElement('div');
            body.id = 'btva-tabpanel';
            body.setAttribute('role', 'tabpanel');
            body.setAttribute('aria-labelledby', 'btva-tab-' + st.tab);
            panel.append(body);

            const live = aniRoles();
            const cardTpl = live?.querySelector('.role-card') || null;
            const yearTpl = live?.querySelector('h3.year') || null;
            const gridTpl = live?.querySelector('.grid-wrap') || null;
            panel.classList.toggle('btva-fallback', !cardTpl);
            const groups = viewRoles(d.roles, st.tab, st.sort);
            if (!groups.length) body.append(note('No roles in this category.'));
            for (const g of groups) {
                const block = like(yearTpl, 'div');
                if (g.year !== undefined) {
                    const h = like(yearTpl, 'h3', 'year');
                    h.textContent = g.year === null ? 'TBA' : String(g.year);
                    block.append(h);
                }
                const grid = like(gridTpl, 'div', 'grid-wrap');
                for (const r of g.roles) grid.append(card(r, cardTpl));
                block.append(grid);
                body.append(block);
            }
            const foot = document.createElement('div');
            foot.className = 'btva-foot';
            foot.append(link('Open on BTVA', d.url), fixLink());
            panel.append(foot);
        }

        // One request chain at a time, even if the switch is toggled while it runs.
        function load() {
            st.loading ??= fetchRoles().finally(() => { st.loading = null; });
        }
        async function fetchRoles() {
            try {
                if (!st.staff) st.staff = await deps.fetchStaff(staffId);
                st.step = null;
                st.data = await deps.loadBtva(st.staff, undefined, step => {
                    st.step = step;
                    if (panel.isConnected && !st.data) render();
                });
            } catch (e) {
                st.data = { state: 'error' };
            }
            if (panel.isConnected) render();
        }

        btn.addEventListener('click', () => {
            st.on = !st.on;
            btn.textContent = st.on ? 'Switch to AniList' : 'Switch to BTVA';
            closeMenu();
            sync();
            if (!st.on) return;
            if (st.data && st.data.state !== 'ok') st.data = null; // retry after a block or an error; a miss stays cached for 24h (Fix link clears it)
            if (!st.data) load(); // first: it resets the loading step before the note is drawn
            render();
        });
        sync();

        current = {
            staffId: String(staffId), btn, sync,
            unmount() {
                st.on = false;
                sync();
                menuClose.abort();
                btn.remove();
                sort.remove();
                panel.remove();
            },
        };
    }

    async function fetchStaff(id) {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ query: 'query($id:Int){Staff(id:$id){name{first last full native}}}', variables: { id } }),
        });
        const json = await res.json();
        return { id, name: json.data.Staff.name };
    }

    function boot(deps) {
        setInterval(() => {
            const m = location.pathname.match(/^\/staff\/(\d+)/);
            // Vue can rebuild the filters bar (button gone) or reuse it for another staff id.
            if (current && (!m || current.staffId !== m[1] || !current.btn.isConnected)) { current.unmount(); current = null; }
            if (!m) return;
            if (!document.getElementById('btva-switch') && document.querySelector('.staff-wrap .filters')) mountStaff(Number(m[1]), deps);
            else current?.sync(); // Vue may re-create AniList's grid while BTVA mode is on
        }, 250);
    }
    // == end ui ==

    if (typeof GM_xmlhttpRequest === 'function') {
        boot({ loadBtva, fetchStaff, prompt: (msg, def) => window.prompt(msg, def), gmSet: GM_setValue, gmDelete: GM_deleteValue, gmRequest: realDeps().gmRequest });
    }
})();
