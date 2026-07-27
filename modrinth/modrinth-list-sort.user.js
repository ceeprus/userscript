// ==UserScript==
// @name         Modrinth Plus
// @namespace    https://github.com/ceeprus
// @version      1.1
// @description  Better sorting for Modrinth plus a custom-modlist excluder: sort any project list by downloads, dates, name or downloads/day, hide single projects or your whole installed modlist, and auto-load the next page of results
// @icon         https://modrinth.com/favicon.ico
// @author       Cee
// @match        https://modrinth.com/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/modrinth/modrinth-list-sort.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/modrinth/modrinth-list-sort.user.js
// ==/UserScript==

(function () {
  'use strict';

  var API = 'https://api.modrinth.com/v2';
  var CACHE_KEY = 'mrsort-cache';
  var PREF_KEY = 'mrsort-prefs';
  var HIDE_KEY = 'mrsort-hidden';
  var REVEAL_KEY = 'mrsort-reveal';
  var AUTOLOAD_KEY = 'mrsort-autoload';
  var BLOCK_KEY = 'mrsort-blocklist';
  var MODLIST_KEY = 'mrsort-modlist';
  var MODLIST_MODE_KEY = 'mrsort-modlist-mode'; // exclude | only | badge
  var MCVER_KEY = 'mrsort-mcver';
  var LOADER_KEY = 'mrsort-loader';
  var DEPS_KEY = 'mrsort-deps';

  var LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
  // sorted cards get order 1..N, so anything not yet ranked must sit above N,
  // not at the CSS default of 0 (which would float it to the top of the list)
  var UNRANKED_ORDER = 100000;
  var TTL = 6 * 60 * 60 * 1000; // project data is cached 6h, so revisits sort with zero requests
  var MAX_CACHE = 1500;
  var CHUNK = 100;

  // only a bare project root counts as a card link (/mod/foo, not /mod/foo/versions)
  var PATH_RE = /^\/(mod|plugin|datapack|modpack|resourcepack|shader|project)\/([^\/]+)\/?$/;

  // our key -> Modrinth's own ?s= value, used to sort search results across ALL pages
  var SERVER_SORT = { downloads: 'downloads', followers: 'follows', published: 'newest', updated: 'updated' };

  var TYPE_ORDER = ['mod', 'modpack', 'plugin', 'datapack', 'resourcepack', 'shader'];

  var KEYS = [
    { id: 'none', label: 'Default order' },
    { id: 'downloads', label: 'Downloads', num: function (p) { return p.downloads; } },
    { id: 'followers', label: 'Followers', num: function (p) { return p.followers; } },
    { id: 'published', label: 'Date published', num: function (p) { return p.publishedMs; } },
    { id: 'updated', label: 'Date updated', num: function (p) { return p.updatedMs; } },
    { id: 'perday', label: 'Downloads / day', num: function (p) { return p.perDay; } },
    { id: 'gamever', label: 'Latest MC version', num: function (p) { return p.verRank; } },
    // asc: this key reads naturally smallest-first, so it defaults to ascending
    { id: 'title', label: 'Name', asc: true, text: function (p) { return p.title || ''; } }
  ];

  // Modrinth's own follower stat uses this heart, so it doubles as the anchor
  // for placing the hide button beside it.
  var HEART_D = 'M4.318 6.318';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON = {
    eye: ['M2.036 12.322a1 1 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178a1 1 0 0 1 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
    eyeOff: ['M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.774 3.162 10.066 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243'],
    deps: ['M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z']
  };

  function icon(paths, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('width', size || 18);
    svg.setAttribute('height', size || 18);
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function keyDef(id) {
    for (var i = 0; i < KEYS.length; i++) if (KEYS[i].id === id) return KEYS[i];
    return KEYS[0];
  }

  // ---------------------------------------------------------------- storage

  function store(key, val) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; } } catch (e) { /* fall through */ }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode */ }
  }

  function load(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        var v = GM_getValue(key, null);
        if (v !== null && v !== undefined) return v;
        return fallback;
      }
    } catch (e) { /* fall through */ }
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function getPrefs(kind) {
    var all = load(PREF_KEY, {}) || {};
    var p = all[kind] || {};
    return { key: p.key || 'none', dir: p.dir === 1 ? 1 : -1, group: !!p.group };
  }

  function savePrefs(kind, prefs) {
    var all = load(PREF_KEY, {}) || {};
    all[kind] = prefs;
    store(PREF_KEY, all);
  }

  function loadCache() {
    var c = load(CACHE_KEY, {});
    return (c && typeof c === 'object') ? c : {};
  }

  function saveCache(cache) {
    var keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      keys.sort(function (a, b) { return (cache[a].t || 0) - (cache[b].t || 0); });
      for (var i = 0; i < keys.length - MAX_CACHE; i++) delete cache[keys[i]];
    }
    store(CACHE_KEY, cache);
  }

  // hidden projects are global: hide once, gone from every list on the site
  function loadHidden() {
    var h = load(HIDE_KEY, {});
    return (h && typeof h === 'object') ? h : {};
  }

  function isHidden(slug) { return !!state.hidden[slug.toLowerCase()]; }

  function setHidden(slug, on) {
    var k = slug.toLowerCase();
    if (on) state.hidden[k] = 1; else delete state.hidden[k];
    store(HIDE_KEY, state.hidden);
  }

  // ---- blacklist: substring terms that hide any project whose name matches --

  function loadBlock() {
    var b = load(BLOCK_KEY, []);
    return Array.isArray(b) ? b.filter(function (t) { return typeof t === 'string' && t; }) : [];
  }

  function saveBlock() { store(BLOCK_KEY, state.block); }

  // one term, or several at once when a pasted string carries commas
  function addTerms(text) {
    var added = false;
    String(text || '').split(',').forEach(function (raw) {
      var t = raw.trim().toLowerCase();
      if (!t || state.block.indexOf(t) > -1) return;
      state.block.push(t);
      added = true;
    });
    if (added) saveBlock();
    return added;
  }

  function removeTerm(term) {
    var i = state.block.indexOf(term);
    if (i < 0) return false;
    state.block.splice(i, 1);
    saveBlock();
    return true;
  }

  // ---- modlist: paste a whole mod list, hide every entry it names ----------

  function normName(s) {
    s = String(s || '');
    // fold fullwidth/compat forms so visually-identical names compare equal
    if (s.normalize) s = s.normalize('NFKC');
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // "oωo (owo-lib)" -> "oωo": titles and modlist lines both carry
  // parentheticals, so both sides are truncated the same way before comparing
  function baseName(s) {
    return normName(String(s || '').split(/\s+\(|\s+\[/)[0]);
  }

  // Handles every shape an exported mod list takes:
  //   .connector
  //   .connector (.connector)
  //   Accelerated Decay
  //   Accelerated Decay (https://modrinth.com/mod/laX5CckD) by ErrorMikey
  //   AdvancedLootInfo (https://modrinth.com/mod/PEPVViac) [1.12.0] by Yanny (file.jar)
  function parseModlist(text) {
    var names = {}, ids = {}, lines = 0;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var l = line.trim();
      if (!l) return;
      lines++;
      // any Modrinth link on the line contributes an id or slug
      var re = /modrinth\.com\/(?:mod|plugin|datapack|modpack|resourcepack|shader|project)\/([A-Za-z0-9_-]+)/g;
      var m;
      // key lowercased for slug comparison, value original-cased because
      // Modrinth project IDs are case-sensitive in the API
      while ((m = re.exec(l))) ids[m[1].toLowerCase()] = m[1];
      // the name is whatever precedes the first "(" or "[" - never split on
      // " by ", or a mod actually called "Death by Fire" would be truncated
      var name = baseName(l);
      if (name) names[name] = 1;
    });
    return { names: names, ids: ids, lines: lines };
  }

  function loadModlist() {
    var raw = load(MODLIST_KEY, '');
    var parsed = parseModlist(typeof raw === 'string' ? raw : '');
    parsed.raw = typeof raw === 'string' ? raw : '';
    return parsed;
  }

  function setModlist(text) {
    var parsed = parseModlist(text);
    parsed.raw = String(text || '');
    state.modlist = parsed;
    store(MODLIST_KEY, parsed.raw);
    resolveModlist();
  }

  // A line's URL can carry a project ID (laX5CckD) instead of a slug; cards
  // only expose slugs. Resolve ids through the API once (cached 6h) and fold
  // the resolved slug and title into the match sets.
  function resolveModlist() {
    var ml = state.modlist;
    // fetch with the original casing - the API rejects a lowercased ID
    var ids = Object.keys(ml.ids).map(function (k) { return String(ml.ids[k]); });
    if (!ids.length) return;
    fetchData(ids).then(function (data) {
      if (state.modlist !== ml) return; // list replaced while fetching
      var changed = false;
      ids.forEach(function (id) {
        var d = data[id];
        if (!d) return;
        var slug = (d.slug || '').toLowerCase();
        if (slug && !ml.ids[slug]) { ml.ids[slug] = slug; changed = true; }
        [normName(d.title), baseName(d.title)].forEach(function (n) {
          if (n && !ml.names[n]) { ml.names[n] = 1; changed = true; }
        });
      });
      if (changed) refresh();
    }).catch(function () { /* offline: name matching still works */ });
  }

  function modlistSize() {
    return Object.keys(state.modlist.names).length + Object.keys(state.modlist.ids).length;
  }

  // Matches the card's visible name and its slug - not the description, or a
  // term like "xaero" would also hide every mod that merely mentions it.
  function blockedBy(card) {
    var name = ((card.title || '') + ' ' + card.slug).toLowerCase();
    for (var i = 0; i < state.block.length; i++) {
      if (name.indexOf(state.block[i]) > -1) return state.block[i];
    }
    return null;
  }

  // Modlist entries match the whole name, not a substring: a 500-mod list
  // full of short names would otherwise hide half the site.
  function inModlist(card) {
    var ml = state.modlist;
    if (ml.ids[card.slug.toLowerCase()]) return true;
    if (card.title) {
      // full title first, then the title with its own parenthetical stripped -
      // "oωo (owo-lib)" must match a list line that says just "oωo"
      if (ml.names[normName(card.title)]) return true;
      if (ml.names[baseName(card.title)]) return true;
    }
    return false;
  }

  // Why a card is hidden: 'manual' (its eye), a blacklist term, 'modlist'
  // (exclude mode), or 'not-in-modlist' (only-show mode). Null = visible.
  function hideReason(card) {
    if (isHidden(card.slug)) return 'manual';
    var term = blockedBy(card);
    if (term) return term;
    if (state.mlMode === 'exclude' && inModlist(card)) return 'modlist';
    if (state.mlMode === 'only' && modlistSize() > 0 && !inModlist(card)) return 'not-in-modlist';
    return null;
  }

  function cardHidden(card) { return !!hideReason(card); }

  // ---- compat filter: dim projects that don't run on the chosen setup ------

  function compatActive() { return !!(state.mcver || state.loader); }

  // Loader check only judges projects that declare a real mod loader:
  // resource packs ("minecraft"), datapacks, shaders pass through untouched.
  function isCompat(p) {
    if (!p) return true; // unknown stays undimmed
    if (state.mcver && p.game_versions.length && p.game_versions.indexOf(state.mcver) < 0) return false;
    if (state.loader && p.loaders.length) {
      var declares = p.loaders.some(function (l) { return LOADERS.indexOf(l) > -1; });
      if (declares && p.loaders.indexOf(state.loader) < 0) return false;
    }
    return true;
  }

  function counts() {
    var out = { manual: 0, filtered: 0, total: 0 };
    if (!state.list) return out;
    state.list.cards.forEach(function (c) {
      var m = isHidden(c.slug), f = !m && !!blockedBy(c);
      if (m) out.manual++;
      if (f) out.filtered++;
      if (m || f) out.total++;
    });
    return out;
  }

  function hiddenCount() { return counts().total; }

  // ------------------------------------------------------------------- data

  function trim(p) {
    return {
      id: p.id,
      slug: p.slug,
      title: p.title || p.slug,
      downloads: p.downloads || 0,
      followers: p.followers || 0,
      published: p.published || null,
      updated: p.updated || null,
      project_type: p.project_type || '',
      game_versions: p.game_versions || [],
      loaders: p.loaders || []
    };
  }

  function derive(d) {
    var p = {
      title: d.title,
      downloads: d.downloads,
      followers: d.followers,
      project_type: d.project_type,
      publishedMs: d.published ? Date.parse(d.published) : 0,
      updatedMs: d.updated ? Date.parse(d.updated) : 0,
      verRank: verRank(d.game_versions),
      game_versions: d.game_versions || [],
      loaders: d.loaders || []
    };
    var days = Math.max(1, (Date.now() - p.publishedMs) / 86400000);
    p.perDay = p.publishedMs ? p.downloads / days : 0;
    return p;
  }

  // "1.21.4" -> 1021004. Snapshots (24w14a), pre-releases and betas are skipped.
  function verRank(list) {
    var best = -1;
    for (var i = 0; i < (list || []).length; i++) {
      var v = list[i];
      if (!/^\d+(\.\d+)*$/.test(v)) continue;
      var s = v.split('.');
      var n = (+s[0] || 0) * 1e6 + (+s[1] || 0) * 1e3 + (+s[2] || 0);
      if (n > best) best = n;
    }
    return best;
  }

  // Bulk endpoint takes slugs and ids mixed, is CORS-open and needs no auth.
  // Response order is NOT request order, and a renamed project can come back
  // under a different slug, so everything is indexed by both slug and id.
  function fetchData(slugs) {
    var cache = loadCache();
    var now = Date.now();
    var need = [];
    var out = {};

    slugs.forEach(function (s) {
      var hit = cache[s.toLowerCase()];
      if (hit && now - hit.t < TTL) { if (hit.d) out[s] = hit.d; }
      else need.push(s);
    });

    if (!need.length) return Promise.resolve(out);

    var chunks = [];
    for (var i = 0; i < need.length; i += CHUNK) chunks.push(need.slice(i, i + CHUNK));

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var url = API + '/projects?ids=' + encodeURIComponent(JSON.stringify(chunk));
        return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
          if (!r.ok) throw new Error('Modrinth API ' + r.status);
          return r.json();
        }).then(function (arr) {
          arr.forEach(function (p) {
            var d = trim(p);
            if (d.slug) cache[d.slug.toLowerCase()] = { t: now, d: d };
            if (d.id) cache[d.id.toLowerCase()] = { t: now, d: d };
          });
          // anything still unresolved gets a negative entry so it is not refetched every load
          chunk.forEach(function (s) {
            var k = s.toLowerCase();
            if (!cache[k] || now - cache[k].t >= TTL) cache[k] = { t: now, d: null };
          });
        });
      });
    }, Promise.resolve()).then(function () {
      saveCache(cache);
      slugs.forEach(function (s) {
        var hit = cache[s.toLowerCase()];
        if (hit && hit.d) out[s] = hit.d;
      });
      return out;
    });
  }

  // ------------------------------------------------------------ list finding

  function slugOf(a) {
    var u;
    try { u = new URL(a.getAttribute('href'), location.origin); } catch (e) { return null; }
    if (u.host !== location.host) return null;
    var m = u.pathname.match(PATH_RE);
    return m ? { type: m[1], slug: m[2] } : null;
  }

  // Read off the card itself, so the blacklist can filter before (or without)
  // any API call.
  function titleOf(el) {
    var t = el.querySelector('.project-card-title');
    return ((t && t.textContent) || '').trim();
  }

  // Class-independent: group every project link by ancestor, then keep the
  // ancestor holding the most distinct cards. Survives Tailwind class churn.
  function findList(root) {
    root = root || document;
    var all = root.querySelectorAll('a[href]');
    var anchors = [];
    for (var i = 0; i < all.length; i++) {
      var hit = slugOf(all[i]);
      if (hit) anchors.push({ a: all[i], slug: hit.slug, type: hit.type });
    }
    if (anchors.length < 2) return null;

    var groups = new Map();
    for (var j = 0; j < anchors.length; j++) {
      var el = anchors[j].a;
      for (var d = 0; d < 12 && el.parentElement; d++) {
        var par = el.parentElement;
        var g = groups.get(par);
        if (!g) { g = new Map(); groups.set(par, g); }
        if (!g.has(el)) g.set(el, anchors[j]);
        el = par;
      }
    }

    var best = null;
    groups.forEach(function (g, par) {
      if (g.size < 2) return;
      var score = g.size * (g.size / Math.max(1, par.children.length));
      if (!best || score > best.score) best = { container: par, map: g, score: score };
    });
    if (!best) return null;

    var cards = [];
    var kids = best.container.children;
    for (var k = 0; k < kids.length; k++) {
      var s = best.map.get(kids[k]);
      if (s) cards.push({ el: kids[k], slug: s.slug, type: s.type, title: titleOf(kids[k]), index: cards.length });
    }
    // Real card lists only - loose project links scattered through a page
    // (a project's own nav, "related projects") don't qualify.
    if (cards.length < 4) return null;
    var titled = cards.filter(function (c) { return !!c.title; }).length;
    if (titled < cards.length * 0.6) return null;
    return { container: best.container, cards: cards };
  }

  // --------------------------------------------------------------- ordering

  // Cards are never moved. The container is a flex column, so a CSS `order`
  // stamp reorders visually while Vue's keyed DOM stays exactly as it was.
  function canUseOrder(container) {
    return /flex|grid/.test(getComputedStyle(container).display);
  }

  function applyOrder(list, sorted) {
    if (canUseOrder(list.container)) {
      sorted.forEach(function (item, i) { item.el.style.order = String(i + 1); });
    } else {
      var frag = document.createDocumentFragment();
      sorted.forEach(function (item) { frag.appendChild(item.el); });
      list.container.appendChild(frag);
    }
  }

  function clearOrder(list) {
    if (!list) return;
    list.cards.forEach(function (c) { c.el.style.removeProperty('order'); });
  }

  function typeRank(p) {
    var i = TYPE_ORDER.indexOf(p.project_type);
    return i < 0 ? TYPE_ORDER.length : i;
  }

  function sortCards(cards, data, prefs, keyActive, needData) {
    var def = keyDef(prefs.key);
    var entries = cards.map(function (c) {
      var d = data[c.slug];
      return {
        el: c.el,
        index: c.index,
        hidden: cardHidden(c),
        // without project data nothing is "unresolved" - the slug is all we used
        missing: needData ? !d : false,
        p: d ? derive(d) : { title: '', downloads: 0, followers: 0, publishedMs: 0, updatedMs: 0, perDay: 0, verRank: -1, project_type: '' }
      };
    });

    entries.sort(function (a, b) {
      // revealed-but-hidden projects sink below everything else
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      if (prefs.group) {
        var t = typeRank(a.p) - typeRank(b.p);
        if (t) return t;
      }
      // projects we could not resolve keep their relative order at the end
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      if (keyActive && !a.missing) {
        var r;
        if (def.text) {
          r = def.text(a.p).localeCompare(def.text(b.p), undefined, { sensitivity: 'base', numeric: true });
        } else if (def.num) {
          var av = def.num(a.p), bv = def.num(b.p);
          r = av === bv ? 0 : (av < bv ? -1 : 1);
        } else r = 0;
        r *= prefs.dir;
        if (r) return r;
      }
      return a.index - b.index;
    });
    return entries;
  }

  // ------------------------------------------------------------------ pages

  function pageKind() {
    var p = location.pathname;
    // a project's own page is never a list, so nothing is attached there
    if (PATH_RE.test(p) || /^\/(mod|plugin|datapack|modpack|resourcepack|shader|project)\//.test(p)) return 'project';
    if (/^\/collection\//.test(p)) return 'collection';
    if (/^\/user\//.test(p)) return 'user';
    if (/^\/organization\//.test(p)) return 'organization';
    if (/^\/dashboard\/follows/.test(p)) return 'follows';
    if (/^\/(discover|search|mods|modpacks|plugins|resourcepacks|shaders|datapacks)(\/|$)/.test(p)) return 'search';
    return 'other';
  }

  function currentServerSort() {
    try { return new URL(location.href).searchParams.get('s') || ''; } catch (e) { return ''; }
  }

  function goServerSort(value) {
    var u = new URL(location.href);
    u.searchParams.set('s', value);
    u.searchParams.delete('page'); // sorting differently means starting at page 1
    u.searchParams.delete('o');
    location.href = u.toString();
  }

  // --------------------------------------------------------------------- UI

  var CSS = [
    // Custom tags: Vue's hydration adopts a foreign element when the tag at a
    // child index matches its vnode. No Modrinth vnode is ever an <mrsort-*>
    // tag, so these elements can never be adopted.
    'mrsort-bar,mrsort-card,mrsort-sentinel-box{display:block}',
    'mrsort-pill-box{display:inline-block}',
    'mrsort-tip{display:none;position:absolute;z-index:9999;min-width:180px;max-width:260px;background:var(--color-raised-bg,#27292e);color:var(--color-base,#b0bac5);border:1px solid var(--color-button-bg,#34363c);border-radius:.75rem;padding:.5rem .75rem;font-size:.8125rem;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,.35)}',
    '.mrsort-tip-head{font-weight:600;color:var(--color-contrast,#fff)}',
    '.mrsort-card-incompat{opacity:.4;filter:grayscale(.5)}',
    '.mrsort-depbtn{background:none;border:0;margin:0;padding:.15rem;line-height:0;color:var(--color-secondary,#96a2b0);cursor:pointer;opacity:.5;pointer-events:auto;transition:opacity .12s ease}',
    '.mrsort-depbtn:hover{opacity:1;color:var(--color-brand,#1bd96a)}',
    '.mrsort-depbtn svg{pointer-events:none}',
    '.mrsort-owned{display:inline-flex;align-items:center;justify-content:center;width:1.15rem;height:1.15rem;border-radius:9999px;background:var(--color-brand,#1bd96a);color:var(--color-accent-contrast,#04180f);font-size:.75rem;font-weight:700;pointer-events:none}',
    '.mrsort-mlmodes label{display:flex;align-items:center;gap:.25rem;font-size:.8125rem;cursor:pointer}',
    '.mrsort{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:0 0 .75rem;font-size:.875rem;color:var(--color-base,#b0bac5)}',
    // matches Modrinth's own dropdown pills: #34363c, 12px radius, 8x16 pad, 600 weight
    '.mrsort select,.mrsort button{background:var(--color-button-bg,#34363c);color:var(--color-button-text,#b0bac5);border:1px solid var(--color-button-border,transparent);border-radius:.75rem;padding:.5rem 1rem;font:inherit;font-weight:600;line-height:1.25;cursor:pointer;transition:filter .2s}',
    '.mrsort select:hover,.mrsort button:hover:not(:disabled){filter:brightness(115%)}',
    '.mrsort select:hover,.mrsort button:hover{background:var(--color-button-bg-hover,var(--color-button-bg,#34363c));color:var(--color-button-text-hover,var(--color-button-text,#b0bac5))}',
    '.mrsort button.mrsort-dir{min-width:2.4rem}',
    '.mrsort button.mrsort-eye{display:flex;align-items:center;gap:.35rem}',
    '.mrsort button.mrsort-eye[data-on="1"]{color:var(--color-brand,#1bd96a);border-color:var(--color-brand,#1bd96a)}',
    '.mrsort button.mrsort-unhide-all{background:none;border-color:var(--color-divider,#34363c)}',
    '.mrsort label{display:flex;align-items:center;gap:.35rem;cursor:pointer;user-select:none}',
    '.mrsort .mrsort-status{margin-left:auto;color:var(--color-secondary,#96a2b0);font-size:.8125rem}',
    '.mrsort .mrsort-status[data-warn="1"]{color:var(--color-orange,#e5a44d)}',
    // card contents sit under a full-card overlay link, so the button opts back into pointer events
    '.mrsort-hide{background:none;border:0;margin:0;padding:.15rem;line-height:0;color:var(--color-secondary,#96a2b0);cursor:pointer;opacity:.5;pointer-events:auto;transition:opacity .12s ease,color .12s ease}',
    '.mrsort-hide:hover{opacity:1;color:var(--color-red,#e77373)}',
    // the icon never takes the press: a mousedown target that gets replaced
    // mid-click makes Chrome drop the click entirely
    '.mrsort-hide svg,.mrsort button svg{pointer-events:none}',
    '.mrsort-hide--float{position:absolute;top:.5rem;right:.5rem;z-index:2}',
    '.mrsort-filter{display:flex;align-items:center;gap:.25rem;flex-wrap:wrap;background:var(--color-button-bg,#34363c);border-radius:var(--radius-md,.75rem);padding:.15rem .35rem;max-width:28rem}',
    '.mrsort-chips{display:flex;align-items:center;gap:.25rem;flex-wrap:wrap}',
    '.mrsort-chip{display:inline-flex;align-items:center;gap:.25rem;background:var(--color-button-bg,#34363c);color:var(--color-contrast,#fff);border-radius:999px;padding:.15rem .25rem .15rem .6rem;font-size:.8125rem;line-height:1.5}',
    // A real circle, sized square, so it matches the chip's rounded end instead
    // of sitting in it as a rounded rectangle.
    '.mrsort .mrsort-chip-x{display:inline-flex;align-items:center;justify-content:center;width:1.15rem;height:1.15rem;flex:0 0 auto;background:transparent;border:0;border-radius:9999px;padding:0;margin:0;color:var(--color-secondary,#96a2b0);font-size:.9rem;line-height:1;cursor:pointer}',
    '.mrsort .mrsort-chip-x:hover{background:var(--color-raised-bg,#27292e);color:var(--color-contrast,#fff)}',
    '.mrsort-filter-input{background:none;border:0;outline:none;color:var(--color-contrast,#fff);font:inherit;padding:.25rem;min-width:6rem;flex:1}',
    '.mrsort-hide:disabled{cursor:default}',
    '.mrsort-side-body .mrsort-filter{width:100%;box-sizing:border-box}',
    '.mrsort-modlist{display:flex;flex-direction:column;gap:.5rem}',
    '.mrsort-modlist-input{width:100%;box-sizing:border-box;background:var(--color-button-bg,#34363c);color:var(--color-contrast,#fff);border:1px solid var(--color-button-border,transparent);border-radius:var(--radius-md,.75rem);padding:.5rem .6rem;font:inherit;font-size:.8125rem;line-height:1.4;resize:vertical;outline:none}',
    '.mrsort-modlist-row{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}',
    '.mrsort-btn{background:var(--color-button-bg,#34363c);color:var(--color-button-text,#b0bac5);border:0;border-radius:var(--radius-md,.75rem);padding:.35rem .7rem;font:inherit;font-size:.8125rem;font-weight:600;cursor:pointer}',
    '.mrsort-btn:hover{background:var(--color-button-bg-hover,var(--color-button-bg,#34363c))}',
    '.mrsort-btn-primary{background:var(--color-brand,#1bd96a);color:var(--color-accent-contrast,#04180f)}',
    '.mrsort-btn-primary:hover{background:var(--color-brand-highlight,var(--color-brand,#1bd96a))}',
    '.mrsort-modlist-note{color:var(--color-secondary,#96a2b0);font-size:.75rem;margin-left:auto}',
    // toolbar pill + native-look switch (40x20, 12px knob, brand green when on)
    '.mrsort-pill-wrap{position:relative;display:inline-block;min-width:max-content}',
    '.mrsort-pill{cursor:pointer;display:flex;align-items:center;gap:.625rem;min-height:1.25rem;border-radius:.75rem;background:var(--color-button-bg,#34363c);padding:.5rem 1rem;font-weight:600;color:var(--color-base,#b0bac5);user-select:none;transition:filter .2s}',
    '.mrsort-pill:hover{filter:brightness(115%)}',
    '.mrsort-switch{display:inline-flex;align-items:center;width:40px;height:20px;flex:0 0 auto;border-radius:9999px;background:var(--color-bg,#16181c);padding:4px;box-sizing:border-box;transition:background .2s}',
    '.mrsort-switch-knob{width:12px;height:12px;border-radius:9999px;background:var(--color-secondary,#9fa4b3);transition:transform .2s,background .2s}',
    '.mrsort-pill[data-on="1"] .mrsort-switch{background:var(--color-brand,#1bd96a)}',
    '.mrsort-pill[data-on="1"] .mrsort-switch-knob{transform:translateX(20px);background:var(--color-accent-contrast,#fff)}',
    '.mrsort-sentinel{width:fit-content;margin:.75rem auto;padding:.5rem 1rem;border-radius:.75rem;background:var(--color-button-bg,#34363c);color:var(--color-base,#b0bac5);font-weight:600;font-size:.875rem;text-align:center;transition:filter .2s}',
    '.mrsort-sentinel:hover{filter:brightness(115%)}',
    '.mrsort-sentinel:empty{background:none;padding:.75rem 0;min-height:1.25rem}',
    '.mrsort-card-hidden{display:none!important}',
    '.mrsort-card-dim{opacity:.4}',
    '.mrsort-card-dim .mrsort-hide{opacity:1;color:var(--color-brand,#1bd96a)}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('mrsort-css')) return;
    var s = document.createElement('style');
    s.id = 'mrsort-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildBar() {
    var bar = document.createElement('mrsort-bar');
    bar.className = 'mrsort';
    bar.setAttribute('data-mrsort', '1');

    var label = document.createElement('span');
    label.textContent = 'Sort:';

    var select = document.createElement('select');
    select.className = 'mrsort-key';
    KEYS.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.label;
      select.appendChild(o);
    });

    var dir = document.createElement('button');
    dir.className = 'mrsort-dir';
    dir.type = 'button';

    var groupWrap = document.createElement('label');
    var group = document.createElement('input');
    group.type = 'checkbox';
    group.className = 'mrsort-group';
    groupWrap.appendChild(group);
    groupWrap.appendChild(document.createTextNode('Group by type'));

    var mcver = document.createElement('select');
    mcver.className = 'mrsort-mcver';
    mcver.title = 'Dim projects that don\'t support this Minecraft version';
    var loader = document.createElement('select');
    loader.className = 'mrsort-loader';
    loader.title = 'Dim projects that don\'t support this loader';
    var lo = document.createElement('option');
    lo.value = '';
    lo.textContent = 'Any loader';
    loader.appendChild(lo);
    LOADERS.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l;
      o.textContent = l.charAt(0).toUpperCase() + l.slice(1);
      loader.appendChild(o);
    });
    mcver.addEventListener('change', function () {
      state.mcver = mcver.value;
      store(MCVER_KEY, state.mcver);
      refresh();
    });
    loader.addEventListener('change', function () {
      state.loader = loader.value;
      store(LOADER_KEY, state.loader);
      refresh();
    });

    var autoWrap = document.createElement('label');
    autoWrap.className = 'mrsort-auto';
    var auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.className = 'mrsort-auto-input';
    autoWrap.appendChild(auto);
    autoWrap.appendChild(document.createTextNode('Auto-load pages'));
    auto.addEventListener('change', function () { setAutoload(auto.checked); });

    var eye = document.createElement('button');
    eye.className = 'mrsort-eye';
    eye.type = 'button';
    eye.setAttribute('data-on', '0');
    eye.appendChild(icon(ICON.eyeOff));
    var eyeCount = document.createElement('span');
    eyeCount.className = 'mrsort-eye-count';
    eye.appendChild(eyeCount);

    var unhide = document.createElement('button');
    unhide.className = 'mrsort-unhide-all';
    unhide.type = 'button';
    unhide.textContent = 'Unhide all';

    var status = document.createElement('span');
    status.className = 'mrsort-status';

    bar.appendChild(label);
    bar.appendChild(select);
    bar.appendChild(dir);
    bar.appendChild(mcver);
    bar.appendChild(loader);
    bar.appendChild(groupWrap);
    bar.appendChild(autoWrap);
    bar.appendChild(eye);
    bar.appendChild(unhide);
    bar.appendChild(status);

    select.addEventListener('change', function () {
      // a new key starts in its own natural direction rather than inheriting
      // the previous key's arrow
      if (select.value !== state.prefs.key) state.prefs.dir = keyDef(select.value).asc ? 1 : -1;
      onChange();
    });
    dir.addEventListener('click', function () {
      state.prefs.dir = state.prefs.dir === 1 ? -1 : 1;
      onChange();
    });
    group.addEventListener('change', onChange);
    eye.addEventListener('click', function () {
      state.reveal = !state.reveal;
      store(REVEAL_KEY, state.reveal);
      refresh();
    });
    unhide.addEventListener('click', function () {
      state.hidden = {};
      store(HIDE_KEY, state.hidden);
      refresh();
    });

    return bar;
  }

  function paintBar() {
    if (!state.bar) return;
    var def = keyDef(state.prefs.key);
    state.bar.querySelector('.mrsort-key').value = state.prefs.key;
    state.bar.querySelector('.mrsort-group').checked = state.prefs.group;

    var dir = state.bar.querySelector('.mrsort-dir');
    var asc = state.prefs.dir === 1;
    dir.textContent = asc ? '↑' : '↓';
    dir.disabled = state.prefs.key === 'none';
    dir.style.opacity = dir.disabled ? '.5' : '';
    dir.title = def.text
      ? (asc ? 'A to Z' : 'Z to A')
      : (asc ? 'Lowest first' : 'Highest first');

    var n = hiddenCount();
    var eye = state.bar.querySelector('.mrsort-eye');
    var on = state.reveal ? '1' : '0';
    // only swap the icon when the state really changed - rebuilding it under
    // the cursor mid-press would make the browser drop the click
    if (eye.getAttribute('data-on') !== on) {
      eye.setAttribute('data-on', on);
      var oldIcon = eye.querySelector('svg');
      if (oldIcon) eye.removeChild(oldIcon);
      eye.insertBefore(icon(state.reveal ? ICON.eye : ICON.eyeOff), eye.firstChild);
    }
    eye.querySelector('.mrsort-eye-count').textContent = n ? String(n) : '';
    eye.title = state.reveal ? 'Hidden projects are shown - click to hide them again' : 'Show hidden projects';

    state.bar.querySelector('.mrsort-unhide-all').style.display =
      (state.reveal && Object.keys(state.hidden).length) ? '' : 'none';

    paintMcver();
    state.bar.querySelector('.mrsort-loader').value = state.loader;

    // the toolbar pill replaces the bar checkbox whenever the toolbar exists
    var pillPlaced = ensureAutoPill();
    var autoWrap = state.bar.querySelector('.mrsort-auto');
    autoWrap.style.display = (canPaginate() && !pillPlaced) ? '' : 'none';
    autoWrap.querySelector('.mrsort-auto-input').checked = state.scroll.enabled;

    ensureFilterHost();
    paintChips();
    paintModlist();
  }

  // Tag-style exclude box: type a word, press Enter or type a comma, and it
  // becomes a chip that hides every project whose name contains it.
  function buildFilter() {
    if (state.filterEl) return state.filterEl;

    var filter = document.createElement('div');
    filter.className = 'mrsort-filter';
    var chips = document.createElement('span');
    chips.className = 'mrsort-chips';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'mrsort-filter-input';
    input.placeholder = 'Exclude…';
    input.title = 'Hide projects whose name contains these words. Enter or comma to add.';
    filter.appendChild(chips);
    filter.appendChild(input);

    function commit() {
      var added = addTerms(input.value);
      input.value = '';
      if (added) refresh(); else paintBar();
      return added;
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !input.value && state.block.length) {
        removeTerm(state.block[state.block.length - 1]);
        refresh();
      }
    });
    input.addEventListener('input', function () {
      if (input.value.indexOf(',') > -1) commit(); // comma commits, same as Enter
    });
    input.addEventListener('blur', function () { if (input.value.trim()) commit(); });

    state.filterEl = filter;
    return filter;
  }

  // Paste an exported mod list; every project it names gets hidden at once.
  function buildModlist() {
    if (state.modlistEl) return state.modlistEl;

    var wrap = document.createElement('div');
    wrap.className = 'mrsort-modlist';

    var area = document.createElement('textarea');
    area.className = 'mrsort-modlist-input';
    area.rows = 6;
    area.spellcheck = false;
    area.placeholder = 'Paste your mod list, one per line:\n\nAccelerated Decay\nAdvancedLootInfo (https://modrinth.com/mod/PEPVViac) [1.12.0] by Yanny';
    area.value = state.modlist.raw || '';

    var row = document.createElement('div');
    row.className = 'mrsort-modlist-row';
    var apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'mrsort-btn mrsort-btn-primary';
    apply.textContent = 'Exclude these';
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'mrsort-btn';
    clear.textContent = 'Clear';
    var note = document.createElement('span');
    note.className = 'mrsort-modlist-note';
    row.appendChild(apply);
    row.appendChild(clear);
    row.appendChild(note);

    apply.addEventListener('click', function () { setModlist(area.value); refresh(); });
    clear.addEventListener('click', function () { area.value = ''; setModlist(''); refresh(); });

    // what the matched entries do: hidden, the only ones shown, or badged
    var modes = document.createElement('div');
    modes.className = 'mrsort-modlist-row mrsort-mlmodes';
    [['exclude', 'Exclude'], ['only', 'Only show'], ['badge', 'Badge']].forEach(function (m) {
      var lab = document.createElement('label');
      var r = document.createElement('input');
      r.type = 'radio';
      r.name = 'mrsort-mlmode';
      r.value = m[0];
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.mlMode = m[0];
        store(MODLIST_MODE_KEY, m[0]);
        refresh();
      });
      lab.appendChild(r);
      lab.appendChild(document.createTextNode(m[1]));
      modes.appendChild(lab);
    });

    // page export + settings backup/restore
    var tools = document.createElement('div');
    tools.className = 'mrsort-modlist-row';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mrsort-btn';
    copy.textContent = 'Copy page list';
    copy.title = 'Copy every visible project on this page as a modlist';
    copy.addEventListener('click', function () { exportPageList(note); });
    var backup = document.createElement('button');
    backup.type = 'button';
    backup.className = 'mrsort-btn';
    backup.textContent = 'Backup';
    backup.title = 'Download all Modrinth Plus settings as a file';
    backup.addEventListener('click', exportSettings);
    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'mrsort-btn';
    restore.textContent = 'Restore';
    restore.title = 'Load settings from a backup file';
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.style.display = 'none';
    restore.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) importSettings(file.files[0], note);
      file.value = '';
    });
    tools.appendChild(copy);
    tools.appendChild(backup);
    tools.appendChild(restore);
    tools.appendChild(file);

    wrap.appendChild(area);
    wrap.appendChild(row);
    wrap.appendChild(modes);
    wrap.appendChild(tools);
    state.modlistEl = wrap;
    state.modlistNote = note;
    state.modlistArea = area;
    return wrap;
  }

  function paintModlist() {
    if (!state.modlistNote) return;
    var n = modlistSize();
    state.modlistNote.textContent = n ? n + ' entries active' : '';
    if (state.modlistEl) {
      var r = state.modlistEl.querySelector('input[name=mrsort-mlmode][value="' + state.mlMode + '"]');
      if (r && !r.checked) r.checked = true;
    }
  }

  // ---- export / backup -----------------------------------------------------

  function downloadText(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // Visible cards only, in current visual order, in the same format the
  // excluder parses - one collection can feed another's modlist.
  function exportPageList(note) {
    if (!state.list) return;
    var rows = state.list.cards
      .filter(function (c) { return !cardHidden(c); })
      .sort(function (a, b) { return (+a.el.style.order || 0) - (+b.el.style.order || 0); })
      .map(function (c) { return (c.title || c.slug) + ' (https://modrinth.com/' + c.type + '/' + c.slug + ')'; });
    var text = rows.join('\n');
    var done = function () { if (note) note.textContent = 'Copied ' + rows.length + ' projects'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { downloadText('modrinth-list.txt', text); done(); });
    } else {
      downloadText('modrinth-list.txt', text);
      done();
    }
  }

  var SETTINGS_KEYS = [PREF_KEY, HIDE_KEY, REVEAL_KEY, AUTOLOAD_KEY, BLOCK_KEY, MODLIST_KEY, MODLIST_MODE_KEY, MCVER_KEY, LOADER_KEY];

  function exportSettings() {
    var out = { app: 'modrinth-plus', version: 1 };
    SETTINGS_KEYS.forEach(function (k) { out[k] = load(k, null); });
    downloadText('modrinth-plus-settings.json', JSON.stringify(out, null, 2), 'application/json');
  }

  function importSettings(file, note) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
      if (!data || data.app !== 'modrinth-plus') {
        if (note) note.textContent = 'Not a Modrinth Plus backup';
        return;
      }
      SETTINGS_KEYS.forEach(function (k) {
        if (data[k] !== null && data[k] !== undefined) store(k, data[k]);
      });
      // reload every piece of state the file can carry
      state.hidden = loadHidden();
      state.block = loadBlock();
      state.modlist = loadModlist();
      state.reveal = load(REVEAL_KEY, false) === true;
      state.mlMode = (function (m) { return m === 'only' || m === 'badge' ? m : 'exclude'; })(load(MODLIST_MODE_KEY, 'exclude'));
      state.mcver = String(load(MCVER_KEY, '') || '');
      state.loader = String(load(LOADER_KEY, '') || '');
      state.scroll.enabled = load(AUTOLOAD_KEY, true) !== false;
      state.prefs = getPrefs(state.kind);
      if (state.modlistArea) state.modlistArea.value = state.modlist.raw || '';
      resolveModlist();
      if (note) note.textContent = 'Settings restored';
      refresh();
    };
    reader.readAsText(file);
  }

  // The filter sidebar's own cards, so ours can sit among them
  function sidebarSlot() {
    var cards = document.querySelectorAll('aside div[class*="card-shadow"]');
    if (cards.length < 2) return null;
    var slot = cards[cards.length - 1].parentElement;
    return (slot && slot.children.length >= 2) ? slot : null;
  }

  // Same skeleton Modrinth's own filter cards use: a header button with a
  // chevron that rotates, over an accordion body.
  function sideCard(title, content) {
    var card = document.createElement('mrsort-card');
    card.className = 'card-shadow rounded-2xl bg-surface-3 border border-solid border-surface-4 mrsort-side-card';

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'button-animation flex flex-col gap-1 px-4 py-3 w-full bg-transparent cursor-pointer border-none';
    var row = document.createElement('div');
    row.className = 'flex items-center gap-1 w-full text-contrast';
    var h3 = document.createElement('h3');
    h3.className = 'm-0 text-lg font-semibold';
    h3.textContent = title;
    var chev = document.createElementNS(SVG_NS, 'svg');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.setAttribute('fill', 'none');
    chev.setAttribute('width', '24');
    chev.setAttribute('height', '24');
    chev.setAttribute('class', 'ml-auto size-5 transition-transform duration-300 shrink-0 text-primary rotate-180');
    var cp = document.createElementNS(SVG_NS, 'path');
    cp.setAttribute('stroke', 'currentColor');
    cp.setAttribute('stroke-linecap', 'round');
    cp.setAttribute('stroke-linejoin', 'round');
    cp.setAttribute('stroke-width', '2');
    cp.setAttribute('d', 'm19 9-7 7-7-7');
    chev.appendChild(cp);
    row.appendChild(h3);
    row.appendChild(chev);
    head.appendChild(row);

    var body = document.createElement('div');
    body.className = 'mb-4 mx-3 mrsort-side-body';
    body.appendChild(content);

    head.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      chev.setAttribute('class', chev.getAttribute('class').replace(' rotate-180', '') + (open ? '' : ' rotate-180'));
    });

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  // Lives beside Advanced and License when that sidebar exists, and falls back
  // into the sort bar on pages that have no filter sidebar (collections, users).
  function ensureFilterHost() {
    var filter = buildFilter();
    var modlist = buildModlist();
    var slot = sidebarSlot();

    if (!slot) {
      [state.filterCard, state.modlistCard].forEach(function (c) {
        if (c && c.parentElement) c.parentElement.removeChild(c);
      });
      if (state.bar && filter.parentElement !== state.bar) {
        state.bar.insertBefore(filter, state.bar.querySelector('.mrsort-eye'));
      }
      if (state.bar && modlist.parentElement !== state.bar) {
        state.bar.insertBefore(modlist, state.bar.querySelector('.mrsort-eye'));
      }
      return;
    }

    if (!state.filterCard) state.filterCard = sideCard('Exclude by name', filter);
    if (!state.modlistCard) state.modlistCard = sideCard('Exclude a modlist', modlist);
    // navigating bar-fallback pages steals the widgets out of the cards, so
    // put them back before re-attaching the cards
    var fb = state.filterCard.querySelector('.mrsort-side-body');
    if (filter.parentElement !== fb) fb.appendChild(filter);
    var mb = state.modlistCard.querySelector('.mrsort-side-body');
    if (modlist.parentElement !== mb) mb.appendChild(modlist);
    if (state.filterCard.parentElement !== slot) slot.appendChild(state.filterCard);
    if (state.modlistCard.parentElement !== slot) slot.appendChild(state.modlistCard);
  }

  // Rebuilt only when the term list actually changes - the same idempotency
  // the icons need, so typing never destroys a node mid-click.
  function paintChips() {
    if (!state.filterEl) return;
    var wrap = state.filterEl.querySelector('.mrsort-chips');
    var want = state.block.join(',');
    if (wrap.getAttribute('data-terms') === want) return;
    wrap.setAttribute('data-terms', want);
    wrap.textContent = '';
    state.block.forEach(function (term) {
      var chip = document.createElement('span');
      chip.className = 'mrsort-chip';
      chip.appendChild(document.createTextNode(term));
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'mrsort-chip-x';
      x.textContent = '×';
      x.title = 'Remove "' + term + '"';
      x.addEventListener('click', function () { removeTerm(term); refresh(); });
      chip.appendChild(x);
      wrap.appendChild(chip);
    });
  }

  // Version dropdown fills from the versions the current cards actually
  // declare (release-shaped only), so it never lists snapshots or versions
  // nothing on the page supports. Rebuilt only when that set changes.
  function paintMcver() {
    var sel = state.bar.querySelector('.mrsort-mcver');
    var vers = {};
    if (state.mcver) vers[state.mcver] = 1;
    if (state.list) {
      var cache = loadCache();
      state.list.cards.forEach(function (c) {
        var hit = cache[c.slug.toLowerCase()];
        var gv = hit && hit.d && hit.d.game_versions || [];
        for (var i = 0; i < gv.length; i++) if (/^\d+(\.\d+)*$/.test(gv[i])) vers[gv[i]] = 1;
      });
    }
    var sorted = Object.keys(vers).sort(function (a, b) { return verRank([b]) - verRank([a]); });
    var key = sorted.join(',');
    if (sel.getAttribute('data-vers') !== key) {
      sel.setAttribute('data-vers', key);
      sel.textContent = '';
      var any = document.createElement('option');
      any.value = '';
      any.textContent = 'Any MC version';
      sel.appendChild(any);
      sorted.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });
    }
    sel.value = state.mcver;
    if (sel.value !== state.mcver) sel.value = ''; // stored version absent from this page
  }

  function setStatus(text, warn) {
    if (!state.bar) return;
    var el = state.bar.querySelector('.mrsort-status');
    el.textContent = text || '';
    if (warn) el.setAttribute('data-warn', '1'); else el.removeAttribute('data-warn');
  }

  // If Vue ever adopted one of our elements (hydration got there after we
  // inserted, on a page saved mid-load, etc.) its children are no longer ours.
  // Surrender the element - strip our identity so our CSS stops applying and
  // findList can treat it as the list it now is - and rebuild fresh.
  function healStomped() {
    if (state.bar && (!state.bar.querySelector('.mrsort-key') || state.bar.querySelector('.project-card-title'))) {
      state.bar.classList.remove('mrsort');
      state.bar.removeAttribute('data-mrsort');
      state.bar = null;
    }
    if (state.filterCard && !state.filterCard.querySelector('.mrsort-side-body')) state.filterCard = null;
    if (state.modlistCard && !state.modlistCard.querySelector('.mrsort-side-body')) state.modlistCard = null;
    if (state.autoPill && !state.autoPill.querySelector('.mrsort-switch')) {
      if (state.autoPill.parentElement) state.autoPill.parentElement.removeChild(state.autoPill);
      state.autoPill = null;
    }
    if (state.filterEl && state.filterEl.querySelector('.project-card-title')) state.filterEl = null;
    if (state.modlistEl && state.modlistEl.querySelector('.project-card-title')) state.modlistEl = null;
  }

  function ensureBar(list) {
    injectCss();
    healStomped();
    if (state.bar && state.bar.isConnected && state.bar.nextElementSibling === list.container) return;
    if (state.bar && state.bar.parentElement) state.bar.parentElement.removeChild(state.bar);
    if (!state.bar) state.bar = buildBar();
    list.container.parentElement.insertBefore(state.bar, list.container);
    paintBar();
  }

  // ----------------------------------------------------------- card buttons

  // The follower heart is the anchor: its chip's parent row is the little
  // stat strip at the card's top right. Appending lands after the Vue
  // fragment's closing anchor, so Vue's own diff is untouched.
  function actionRow(cardEl) {
    var svgs = cardEl.querySelectorAll('svg path');
    for (var i = 0; i < svgs.length; i++) {
      var d = svgs[i].getAttribute('d') || '';
      if (d.indexOf(HEART_D) === 0) {
        var chip = svgs[i].closest('div');
        if (chip && chip.parentElement) return chip.parentElement;
      }
    }
    var stats = cardEl.querySelector('[class*="card-list__stats"]');
    if (stats && stats.firstElementChild) return stats.firstElementChild;
    return null;
  }

  function decorate() {
    if (!state.list) return;
    state.list.cards.forEach(function (c) {
      var btn = c.el.querySelector('.mrsort-hide');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mrsort-hide';
        // Tailwind opt-in that re-enables clicks inside the overlay-linked card
        btn.classList.add('smart-clickable:allow-pointer-events');
        // Read the slug off the button at click time. Binding it in this
        // closure would keep pointing at whatever project the card held when
        // the button was built, which breaks the moment a card element is
        // reused for a different project.
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var slug = btn.getAttribute('data-slug');
          if (!slug) return;
          setHidden(slug, !isHidden(slug));
          refresh();
        });
        var row = actionRow(c.el);
        if (row) {
          row.appendChild(btn);
        } else {
          if (getComputedStyle(c.el).position === 'static') c.el.style.position = 'relative';
          btn.classList.add('mrsort-hide--float');
          c.el.appendChild(btn);
        }
      }
      if (btn.getAttribute('data-slug') !== c.slug) btn.setAttribute('data-slug', c.slug);

      // Idempotent: touching the DOM here feeds our own MutationObserver, so
      // the icon is rebuilt only when this card's hidden state actually flips.
      var reason = hideReason(c);
      var manual = reason === 'manual';
      if (btn.getAttribute('data-hidden') !== String(reason)) {
        btn.setAttribute('data-hidden', String(reason));
        // A filter outranks the per-card toggle, so say so rather than
        // offering a button that visibly does nothing.
        btn.disabled = !!reason && !manual;
        btn.title = reason === 'modlist' ? 'Hidden by your modlist'
          : reason === 'not-in-modlist' ? 'Hidden: not in your modlist (only-show mode)'
            : reason && !manual ? 'Hidden by filter "' + reason + '"'
              : (manual ? 'Unhide this project' : 'Hide this project');
        btn.textContent = '';
        btn.appendChild(icon(reason ? ICON.eye : ICON.eyeOff));
      }

      // deps button, before the hide button
      var dbtn = c.el.querySelector('.mrsort-depbtn');
      if (!dbtn) {
        dbtn = document.createElement('button');
        dbtn.type = 'button';
        dbtn.className = 'mrsort-depbtn';
        dbtn.classList.add('smart-clickable:allow-pointer-events');
        dbtn.title = 'Show dependencies';
        dbtn.appendChild(icon(ICON.deps));
        dbtn.addEventListener('mouseenter', function () { depsShow(dbtn); });
        dbtn.addEventListener('mouseleave', depsHideSoon);
        dbtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); depsShow(dbtn); });
        btn.parentElement.insertBefore(dbtn, btn);
      }
      if (dbtn.getAttribute('data-slug') !== c.slug) dbtn.setAttribute('data-slug', c.slug);

      // "in your modlist" badge (badge mode only)
      var owned = state.mlMode === 'badge' && inModlist(c);
      var chip = c.el.querySelector('.mrsort-owned');
      if (owned && !chip) {
        chip = document.createElement('span');
        chip.className = 'mrsort-owned';
        chip.textContent = '✓';
        chip.title = 'In your modlist';
        btn.parentElement.insertBefore(chip, dbtn);
      } else if (!owned && chip) {
        chip.parentElement.removeChild(chip);
      }
    });
  }

  // ---- dependency tooltip --------------------------------------------------

  var depsTimer = null;

  function depsTip() {
    if (!state.depsTip) {
      var tip = document.createElement('mrsort-tip');
      tip.className = 'mrsort-tip';
      tip.addEventListener('mouseenter', function () { clearTimeout(depsTimer); });
      tip.addEventListener('mouseleave', depsHideSoon);
      document.body.appendChild(tip);
      state.depsTip = tip;
    }
    return state.depsTip;
  }

  function depsHideSoon() {
    clearTimeout(depsTimer);
    depsTimer = setTimeout(function () {
      if (state.depsTip) state.depsTip.style.display = 'none';
    }, 250);
  }

  function depsShow(btn) {
    clearTimeout(depsTimer);
    var slug = btn.getAttribute('data-slug');
    if (!slug) return;
    var tip = depsTip();
    var r = btn.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = Math.max(8, Math.min(window.innerWidth - 280, r.left - 240)) + 'px';
    tip.style.top = (r.bottom + window.scrollY + 6) + 'px';
    tip.setAttribute('data-slug', slug);
    tip.textContent = 'Loading dependencies…';

    var cache = load(DEPS_KEY, {}) || {};
    var hit = cache[slug];
    if (hit && Date.now() - hit.t < TTL) { depsRender(tip, slug, hit.list); return; }

    fetch(API + '/project/' + encodeURIComponent(slug) + '/dependencies', { headers: { Accept: 'application/json' } })
      .then(function (r2) { if (!r2.ok) throw new Error('HTTP ' + r2.status); return r2.json(); })
      .then(function (d) {
        var list = (d.projects || []).map(function (p) { return p.title || p.slug; }).filter(Boolean);
        cache = load(DEPS_KEY, {}) || {};
        cache[slug] = { t: Date.now(), list: list };
        var keys = Object.keys(cache);
        if (keys.length > 200) {
          keys.sort(function (a, b) { return (cache[a].t || 0) - (cache[b].t || 0); });
          for (var i = 0; i < keys.length - 200; i++) delete cache[keys[i]];
        }
        store(DEPS_KEY, cache);
        if (tip.getAttribute('data-slug') === slug) depsRender(tip, slug, list);
      })
      .catch(function () {
        if (tip.getAttribute('data-slug') === slug) tip.textContent = 'Could not load dependencies';
      });
  }

  function depsRender(tip, slug, list) {
    tip.textContent = '';
    var head = document.createElement('div');
    head.className = 'mrsort-tip-head';
    head.textContent = list.length ? 'Dependencies (' + list.length + ')' : 'No dependencies';
    tip.appendChild(head);
    list.slice(0, 10).forEach(function (name) {
      var row = document.createElement('div');
      row.textContent = name;
      tip.appendChild(row);
    });
    if (list.length > 10) {
      var more = document.createElement('div');
      more.className = 'mrsort-tip-head';
      more.textContent = '+' + (list.length - 10) + ' more';
      tip.appendChild(more);
    }
  }

  function applyVisibility() {
    if (!state.list) return;
    state.list.cards.forEach(function (c) {
      var hidden = cardHidden(c);
      c.el.classList.toggle('mrsort-card-hidden', hidden && !state.reveal);
      c.el.classList.toggle('mrsort-card-dim', hidden && state.reveal);
    });
    decorate();
  }

  // -------------------------------------------------------- infinite scroll

  // Pages loaded without the user scrolling. Filters can keep the sentinel on
  // screen forever, so this stops a runaway; scrolling clears it.
  var BURST_PAGES = 5;

  function canPaginate() {
    return state.kind === 'search';
  }

  function setAutoload(on) {
    state.scroll.enabled = !!on;
    store(AUTOLOAD_KEY, state.scroll.enabled);
    if (state.list) { ensureSentinel(state.list); loadNext(); }
    paintBar();
  }

  // Modrinth's own toolbar row ("Sort by" / "View" pills above the results)
  function toolbarSlot() {
    var leaves = document.querySelectorAll('span.font-semibold');
    for (var i = 0; i < leaves.length; i++) {
      if (/^Sort by/.test(leaves[i].textContent)) {
        var row = leaves[i].closest('.flex.flex-wrap.items-center');
        if (row && /View/.test(row.textContent)) return row;
      }
    }
    return null;
  }

  // "Auto-load" pill sitting beside Sort by and View, styled like them, with
  // the same toggle switch Modrinth's filters use
  function buildAutoPill() {
    if (state.autoPill) return state.autoPill;
    var wrap = document.createElement('mrsort-pill-box');
    wrap.className = 'mrsort-pill-wrap';
    var pill = document.createElement('span');
    pill.className = 'mrsort-pill';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.title = 'Load the next page of results as you scroll';
    var label = document.createElement('span');
    label.textContent = 'Auto-load';
    var sw = document.createElement('span');
    sw.className = 'mrsort-switch';
    var knob = document.createElement('span');
    knob.className = 'mrsort-switch-knob';
    sw.appendChild(knob);
    pill.appendChild(label);
    pill.appendChild(sw);
    wrap.appendChild(pill);
    pill.addEventListener('click', function () { setAutoload(!state.scroll.enabled); });
    pill.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAutoload(!state.scroll.enabled); }
    });
    state.autoPill = wrap;
    return wrap;
  }

  // Prefers the toolbar; the bar checkbox is the fallback when Modrinth's
  // toolbar is missing (layout change, odd page).
  function ensureAutoPill() {
    var row = canPaginate() ? toolbarSlot() : null;
    var pill = buildAutoPill();
    if (!row) {
      if (pill.parentElement) pill.parentElement.removeChild(pill);
      return false;
    }
    if (pill.parentElement !== row) {
      // after the View pill when present, otherwise at the row's end
      var after = row.children.length > 1 ? row.children[1].nextSibling : null;
      row.insertBefore(pill, after);
    }
    pill.firstChild.setAttribute('data-on', state.scroll.enabled ? '1' : '0');
    return true;
  }

  function pageParam() {
    var n = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
    return (isFinite(n) && n > 0) ? n : 1;
  }

  function pageUrl(n) {
    var u = new URL(location.href);
    u.searchParams.set('page', String(n));
    return u.toString();
  }

  // Modrinth's pager is buttons, not links, so the last page is read off the
  // numeric labels. Overshooting is harmless: that page returns nothing new
  // and we stop anyway.
  function lastPage(root) {
    var best = 0;
    var nodes = (root || document).querySelectorAll('button,a');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').trim();
      if (/^\d{1,6}$/.test(t) && +t > best) best = +t;
    }
    return best || null;
  }

  function scrollReset() {
    var sc = state.scroll;
    sc.added.forEach(function (el) { if (el.parentElement) el.parentElement.removeChild(el); });
    sc.added = [];
    sc.next = pageParam() + 1;
    sc.last = null;
    sc.loading = false;
    sc.done = false;
    sc.fails = 0;
    sc.burst = 0;
  }

  function paintSentinel() {
    var sc = state.scroll;
    if (!sc.el) return;
    var text = '';
    if (sc.loading) text = 'Loading page ' + sc.next + '…';
    else if (sc.done) text = 'End of results';
    else if (sc.burst >= BURST_PAGES) text = 'Click or scroll to load more';
    else text = 'Load more';
    if (sc.el.textContent !== text) sc.el.textContent = text;
    sc.el.style.cursor = sc.done || sc.loading ? 'default' : 'pointer';
  }

  function ensureSentinel(list) {
    var sc = state.scroll;
    if (!canPaginate() || !sc.enabled) {
      if (sc.el && sc.el.parentElement) sc.el.parentElement.removeChild(sc.el);
      return;
    }
    if (!sc.el) {
      sc.el = document.createElement('mrsort-sentinel-box');
      sc.el.className = 'mrsort-sentinel';
      // a plain click always works, even where observers and scroll events do not
      sc.el.addEventListener('click', function () {
        sc.burst = 0;
        sc.fails = 0;
        loadNext();
      });
    }
    if (!sc.el.isConnected || sc.el.previousElementSibling !== list.container) {
      list.container.parentElement.insertBefore(sc.el, list.container.nextSibling);
    }
    if (!sc.io) {
      sc.io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { loadNext(); break; }
        }
      }, { rootMargin: '800px 0px' });
    }
    sc.io.observe(sc.el);
    paintSentinel();
  }

  function nearViewport(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    var h = window.innerHeight || document.documentElement.clientHeight || 0;
    return r.top <= h + 800 && r.bottom >= -800;
  }

  // The IntersectionObserver is the primary trigger. This timer check is the
  // backstop: observers and rAF are tied to the rendering lifecycle and go
  // quiet in throttled or non-compositing tabs, where a plain rect test does not.
  function autoLoadTick() {
    var sc = state.scroll;
    if (sc.enabled && !sc.loading && !sc.done && nearViewport(sc.el)) loadNext();
  }

  function loadNext() {
    var sc = state.scroll;
    if (!sc.enabled || sc.loading || !state.list || !canPaginate()) return;
    if (sc.done || sc.burst >= BURST_PAGES) { paintSentinel(); return; }
    if (sc.last && sc.next > sc.last) { sc.done = true; paintSentinel(); return; }

    var page = sc.next;
    var fromUrl = location.href; // a navigation mid-flight invalidates the result
    sc.loading = true;
    paintSentinel();

    fetch(pageUrl(page), { headers: { Accept: 'text/html' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        if (location.href !== fromUrl || !state.list) return;

        var doc = new DOMParser().parseFromString(html, 'text/html');
        var found = findList(doc);
        // one unreadable response is not the end of the results
        if (!found) { sc.fails++; if (sc.fails >= 3) sc.done = true; return; }
        if (!sc.last) sc.last = lastPage(doc);

        var seen = {};
        state.list.cards.forEach(function (c) { seen[c.slug.toLowerCase()] = 1; });

        var added = 0;
        found.cards.forEach(function (c) {
          var k = c.slug.toLowerCase();
          if (seen[k]) return; // results shift between fetches, so pages overlap
          seen[k] = 1;
          var node = document.importNode(c.el, true);
          node.setAttribute('data-mrsort-added', '1'); // so teardown can always find it
          // park below every ranked card until the next sort pass ranks it
          node.style.order = String(UNRANKED_ORDER + added);
          state.list.container.appendChild(node);
          sc.added.push(node);
          added++;
        });

        sc.next = page + 1;
        sc.burst++;
        sc.fails = 0;
        if (!added) sc.done = true; // nothing new left to show
        scan(); // decorate and sort the arrivals
      })
      .catch(function () {
        sc.fails++;
        if (sc.fails >= 3) sc.done = true;
      })
      .then(function () {
        sc.loading = false;
        paintSentinel();
      });
  }

  // Every control routes through here so a click landing right after a route
  // change (list momentarily null) still takes effect via a fresh scan.
  function refresh() {
    if (!state.list) { scan(); return; } // scan() repaints and applies itself
    paintBar();
    applyVisibility();
    apply();
  }

  // ------------------------------------------------------------------- flow

  var state = {
    list: null, bar: null, prefs: null, kind: null, ranks: null, run: 0,
    hidden: loadHidden(), reveal: load(REVEAL_KEY, false) === true, block: loadBlock(),
    modlist: { names: {}, ids: {}, lines: 0, raw: '' },
    mlMode: (function (m) { return m === 'only' || m === 'badge' ? m : 'exclude'; })(load(MODLIST_MODE_KEY, 'exclude')),
    mcver: String(load(MCVER_KEY, '') || ''), loader: String(load(LOADER_KEY, '') || ''),
    scroll: {
      enabled: load(AUTOLOAD_KEY, true) !== false,
      el: null, io: null, added: [],
      next: 1, last: null, loading: false, done: false, fails: 0, burst: 0
    }
  };

  state.modlist = loadModlist();
  resolveModlist();

  function readBar() {
    return {
      key: state.bar.querySelector('.mrsort-key').value,
      dir: state.prefs.dir,
      group: state.bar.querySelector('.mrsort-group').checked
    };
  }

  function onChange() {
    if (!state.bar || !state.list) return;
    state.prefs = readBar();
    savePrefs(state.kind, state.prefs);
    paintBar();

    // On search, a key Modrinth itself supports (in its own descending
    // direction) is handed back to the server so the sort covers every page.
    if (state.kind === 'search') {
      var mapped = SERVER_SORT[state.prefs.key];
      if (mapped && state.prefs.dir === -1 && currentServerSort() !== mapped) {
        setStatus('Reloading sorted…');
        goServerSort(mapped);
        return;
      }
    }
    apply();
  }

  function statusBits(extra, warn) {
    var c = counts();
    var bits = extra.slice();
    if (c.manual) bits.push(c.manual + ' hidden');
    if (c.filtered) bits.push(c.filtered + ' filtered');
    if (c.total && state.reveal) bits.push('shown');
    setStatus(bits.join(' · '), warn);
  }

  function apply() {
    var list = state.list;
    var prefs = state.prefs;
    if (!list || !prefs) return;
    var token = ++state.run;

    var serverHandled = state.kind === 'search' &&
      SERVER_SORT[prefs.key] && prefs.dir === -1 && currentServerSort() === SERVER_SORT[prefs.key];

    var keyActive = prefs.key !== 'none' && !serverHandled;
    // with nothing to compute, hidden cards still need pushing to the bottom
    var needsOrder = keyActive || prefs.group || (state.reveal && hiddenCount() > 0);
    // Sinking hidden cards only needs their slug, so project data is fetched
    // only when a sort key, grouping or the compat filter actually requires it.
    var needData = keyActive || prefs.group || compatActive();

    if (!needsOrder && !needData) {
      state.ranks = null;
      clearOrder(list);
      list.cards.forEach(function (c) { c.el.classList.remove('mrsort-card-incompat'); });
      statusBits(serverHandled ? ['Sorted by Modrinth across all pages'] : []);
      return;
    }

    var slugs = list.cards.map(function (c) { return c.slug; });

    if (needData) setStatus('Loading…');
    var ready = needData ? fetchData(slugs) : Promise.resolve({});
    ready.then(function (data) {
      if (token !== state.run || state.list !== list) return;

      if (needsOrder) {
        var sorted = sortCards(list.cards, data, prefs, keyActive, keyActive || prefs.group);
        applyOrder(list, sorted);
        // keyed by element, not slug: appended pages can repeat a project, and
        // two cards sharing a slug would otherwise get the same order stamp
        state.ranks = new Map();
        sorted.forEach(function (item, i) { state.ranks.set(item.el, i + 1); });
      } else {
        state.ranks = null;
        clearOrder(list);
      }

      // compat dimming - marks cards, never reorders them
      var incompat = 0;
      list.cards.forEach(function (c) {
        var d = data[c.slug];
        var bad = compatActive() && d ? !isCompat(derive(d)) : false;
        if (bad && !cardHidden(c)) incompat++;
        c.el.classList.toggle('mrsort-card-incompat', bad);
      });

      var visibleN = list.cards.filter(function (c) { return !cardHidden(c); }).length;
      var missing = 0;
      if (keyActive) list.cards.forEach(function (c) { if (!data[c.slug] && !cardHidden(c)) missing++; });
      var pageOnly = state.kind === 'search' && keyActive;
      var bits = [];
      if (keyActive) bits.push('Sorted ' + (visibleN - missing));
      else if (prefs.group) bits.push('Grouped ' + visibleN);
      if (serverHandled) bits.push('key handled by Modrinth');
      if (missing) bits.push(missing + ' unresolved');
      if (incompat) bits.push(incompat + ' incompatible');
      if (pageOnly) bits.push('this page only');
      statusBits(bits, pageOnly);
    }).catch(function (err) {
      if (token !== state.run || state.list !== list) return;
      state.ranks = null;
      clearOrder(list);
      setStatus('Sort data unavailable (' + err.message + ')', true);
    });
  }

  // Vue can replace card nodes on its own re-renders, which drops the inline
  // order stamp. Re-stamp from the last ranking instead of refetching.
  function reapply() {
    if (!state.list) return;
    if (state.ranks && canUseOrder(state.list.container)) {
      state.list.cards.forEach(function (c) {
        // a card with no rank yet (just appended) parks below the ranked ones
        var rank = state.ranks.get(c.el) || UNRANKED_ORDER;
        if (c.el.style.order !== String(rank)) c.el.style.order = String(rank);
      });
    }
    applyVisibility();
  }

  function sameList(a, b) {
    if (!a || !b || a.container !== b.container) return false;
    if (a.cards.length !== b.cards.length) return false;
    for (var i = 0; i < a.cards.length; i++) if (a.cards[i].el !== b.cards[i].el) return false;
    return true;
  }

  // Pull every node of ours out of the page before Vue renders a different
  // route, so none of them sit inside a container Vue is about to patch.
  function teardown() {
    if (state.depsTip) state.depsTip.style.display = 'none';
    [state.bar, state.filterCard, state.modlistCard, state.autoPill, state.scroll.el].forEach(function (el) {
      if (el && el.parentElement) el.parentElement.removeChild(el);
    });
    // any imported card, including ones our bookkeeping lost track of
    var strays = document.querySelectorAll('[data-mrsort-added]');
    for (var i = 0; i < strays.length; i++) {
      if (strays[i].parentElement) strays[i].parentElement.removeChild(strays[i]);
    }
    state.list = null;
    state.ranks = null;
  }

  function scan() {
    if (pageKind() === 'project') { state.kind = 'project'; teardown(); return; }

    var found = findList();
    if (!found) {
      teardown();
      return;
    }

    if (sameList(found, state.list)) {
      ensureBar(state.list);
      ensureSentinel(state.list);
      ensureAutoPill(); // Vue re-renders can rebuild the toolbar and orphan the pill
      ensureFilterHost();
      reapply();
      return;
    }

    var kind = pageKind();
    var freshPage = kind !== state.kind || !state.list;
    state.kind = kind;
    state.list = found;
    state.ranks = null;
    state.prefs = state.prefs && !freshPage ? state.prefs : getPrefs(kind);

    ensureBar(found);

    // reflect Modrinth's own sort param in the dropdown on search pages
    if (kind === 'search') {
      var s = currentServerSort();
      if (s) {
        for (var id in SERVER_SORT) {
          if (SERVER_SORT[id] === s) { state.prefs = { key: id, dir: -1, group: state.prefs.group }; break; }
        }
      }
    }

    paintBar();
    ensureSentinel(found);
    applyVisibility();
    apply();
  }

  var scanTimer = null;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay || 200);
  }

  var lastUrl = location.href;
  function watchUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // Detach before the new route renders, not after: our nodes must not be
    // sitting in a container Vue is about to patch.
    scrollReset();
    teardown();
    scheduleScan(250);
  }

  // Our own DOM writes must not trigger a scan, or decorate() -> mutation ->
  // scan -> decorate() spins several times a second forever.
  function ourNode(n) {
    return !!(n && n.nodeType === 1 && n.closest &&
      n.closest('.mrsort,.mrsort-hide,.mrsort-sentinel,.mrsort-tip,.mrsort-depbtn'));
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      if (!ourNode(records[i].target)) { scheduleScan(250); return; }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // real scrolling clears the burst limit, so auto-loading resumes
  window.addEventListener('scroll', function () {
    if (state.scroll.burst) { state.scroll.burst = 0; paintSentinel(); }
  }, { passive: true });

  window.addEventListener('popstate', watchUrl);
  setInterval(function () {
    watchUrl(); // Nuxt routes via pushState, which fires no event
    autoLoadTick();
  }, 400);
  scrollReset();
  scheduleScan(0);
})();
