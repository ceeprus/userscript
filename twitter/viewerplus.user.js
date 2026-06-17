// ==UserScript==
// @name         Twitter: Profile Viewer+
// @namespace    https://github.com/ceeprus
// @version      1.18
// @description  Adds a themed panel to X/Twitter profiles that hides pinned posts, replies, quote retweets, retweets, plain posts, media posts and text-only posts (each with a live counter), plus compact-media, hide-post-text and hide-media toggles. Settings persist, and the panel can be minimised. Matches your X theme and accent colour.
// @author       Cee
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/twitter/viewerplus.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/twitter/viewerplus.user.js
// ==/UserScript==

/*
 * Inserts a panel above the "You might like" card in the right sidebar of an X/Twitter profile.
 *
 *  - Whole-tweet filters (with live counters): pinned, replies, quote retweets, retweets, posts,
 *    media posts, text-only posts.
 *  - Per-tweet modifiers: compact media, hide post text, hide media.
 *  - Settings persist across sessions; the panel can be minimised; "Reset all" clears everything.
 *
 * The panel copies the sidebar card's background/border and X's Chirp font so it looks native, and
 * the checkboxes follow the user's chosen X accent colour. Everything re-applies on each timeline
 * change, since X virtualises (recycles) tweet nodes as you scroll.
 *
 * Note: tweet classification relies on a few hashed X class names and English UI strings
 * ("Pinned", "reposted", "Replying to"); these may need updating after an X redesign.
 */

(function () {
  'use strict';

  const BOX_ID     = 'cee-vp-box';
  const BODY_ID    = 'cee-vp-body';
  const TITLE_ID   = 'cee-vp-title';
  const TITLE_TEXT = 'Twitter Profile Viewer +';
  const STORE_KEY  = 'cee-vp-state';

  // X sets its font per-element via utility classes, not on a cascading parent, so an inserted
  // <div> falls back to the browser serif default. Apply X's Chirp stack explicitly.
  const FONT_STACK = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  // Leaf media nodes (image / video / link-card); used for both detection and the media modifiers.
  const MEDIA_SEL = '[data-testid="tweetPhoto"], [data-testid="videoComponent"], ' +
                    '[data-testid="card.wrapper"], [data-testid="card.layoutLarge.media"]';
  const COMPACT_MEDIA_MAX = '120px';

  // Whole-tweet filters (shown with a live hidden/total counter).
  const FILTERS = [
    { key: 'pinned',     label: 'Hide Pinned post' },
    { key: 'replies',    label: 'Hide replies' },
    { key: 'quotes',     label: 'Hide quote retweets' },
    { key: 'retweets',   label: 'Hide retweets' },
    { key: 'posts',      label: 'Hide just posts' },
    { key: 'mediaposts', label: 'Hide media posts' },
    { key: 'textonly',   label: 'Hide text-only posts' },
  ];

  // Per-tweet display modifiers (act on parts of every visible tweet, not whole-tweet hiding).
  const MODIFIERS = [
    { key: 'compact',   label: 'Compact posts' },
    { key: 'hideText',  label: 'Hide post text' },
    { key: 'hideMedia', label: 'Hide media' },
  ];

  // Toggle state plus cumulative per-filter id sets so counters don't drop when X recycles nodes.
  const state     = {};
  const seen      = {}; // ids ever classified into a filter
  const hiddenIds = {}; // ids actually hidden while a filter was on
  FILTERS.forEach(f => { state[f.key] = false; seen[f.key] = new Set(); hiddenIds[f.key] = new Set(); });
  MODIFIERS.forEach(m => { state[m.key] = false; });

  let collapsed     = false; // panel minimised
  let activeProfile = null;  // handle of the profile the counters currently belong to
  let textWasActive = false; // whether hide-post-text ran last pass (so we can undo "Show more")

  /* -------------------------------- persistence -------------------------------- */

  function loadState() {
    let saved = null;
    try { if (typeof GM_getValue === 'function') saved = GM_getValue(STORE_KEY, null); } catch (e) {}
    if (!saved || typeof saved !== 'object') return;
    if (saved.toggles) Object.keys(state).forEach(k => {
      if (typeof saved.toggles[k] === 'boolean') state[k] = saved.toggles[k];
    });
    if (typeof saved.collapsed === 'boolean') collapsed = saved.collapsed;
  }

  function saveState() {
    try {
      if (typeof GM_setValue !== 'function') return;
      const toggles = {};
      Object.keys(state).forEach(k => { toggles[k] = state[k]; });
      GM_setValue(STORE_KEY, { toggles, collapsed });
    } catch (e) {}
  }

  /* ------------------------------- locate the sidebar ------------------------------- */

  function findSection() {
    const aside = document.querySelector('aside[aria-label="Who to follow"]');
    if (aside) return aside;
    const headings = document.querySelectorAll('aside[role="complementary"] [role="heading"]');
    for (const h of headings) {
      if (h.textContent.trim() === 'You might like') return h.closest('aside') || h.parentElement;
    }
    return null;
  }

  function findHeadingTextEl(section) {
    const heading = section.querySelector('[role="heading"]');
    return heading ? (heading.querySelector('span') || heading) : null;
  }

  // The rounded sidebar card wrapping the section (first ancestor with a real border-radius).
  function findCard(aside) {
    let el = aside;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      if ((parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) >= 12) return el;
      el = el.parentElement;
    }
    return aside.parentElement ? (aside.parentElement.parentElement || aside.parentElement) : aside;
  }

  /* --------------------------------- build the panel --------------------------------- */

  function buildBox(referenceCard, headingTextEl) {
    const ref = getComputedStyle(referenceCard);

    const box = document.createElement('div');
    box.id = BOX_ID;
    Object.assign(box.style, {
      backgroundColor: ref.backgroundColor,
      border: ref.borderTopWidth + ' solid ' + ref.borderTopColor,
      borderRadius: ref.borderTopLeftRadius,
      fontFamily: FONT_STACK,
      marginBottom: '16px', padding: '12px 16px', boxSizing: 'border-box',
    });

    box.appendChild(buildHeader(headingTextEl));

    const body = document.createElement('div');
    body.id = BODY_ID;
    if (collapsed) body.style.display = 'none';

    const filters = document.createElement('div');
    Object.assign(filters.style, { display: 'flex', flexDirection: 'column', gap: '10px' });
    FILTERS.forEach(f => filters.appendChild(buildRow(f, headingTextEl, true)));
    body.appendChild(filters);

    const sep = document.createElement('div');
    Object.assign(sep.style, { borderTop: '1px solid ' + ref.borderTopColor, margin: '12px 0' });
    body.appendChild(sep);

    const mods = document.createElement('div');
    Object.assign(mods.style, { display: 'flex', flexDirection: 'column', gap: '10px' });
    MODIFIERS.forEach(m => mods.appendChild(buildRow(m, headingTextEl, false)));
    body.appendChild(mods);

    body.appendChild(buildReset());
    box.appendChild(body);
    return box;
  }

  // Header: title + minimise chevron.
  function buildHeader(headingTextEl) {
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: collapsed ? '0' : '12px',
    });

    const title = document.createElement('div');
    title.id = TITLE_ID;
    title.textContent = TITLE_TEXT;
    Object.assign(title.style, { cursor: 'default', userSelect: 'text', WebkitUserSelect: 'text', minWidth: '0' });
    if (headingTextEl) {
      const h = getComputedStyle(headingTextEl);
      Object.assign(title.style, {
        fontFamily: FONT_STACK, fontSize: h.fontSize, fontWeight: h.fontWeight,
        fontStyle: h.fontStyle, lineHeight: h.lineHeight, letterSpacing: h.letterSpacing, color: h.color,
      });
    }

    header.append(title, buildMinimize(header));
    return header;
  }

  function buildMinimize(header) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Minimise panel');
    btn.tabIndex = 0;
    Object.assign(btn.style, {
      flex: '0 0 auto', marginLeft: '8px', padding: '2px', cursor: 'pointer',
      color: '#71767b', display: 'flex', alignItems: 'center',
    });
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" ' +
      'style="transition:transform .15s ease;fill:currentColor">' +
      '<path d="M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41z"/></svg>';
    const svg = btn.firstChild;
    const apply = () => { svg.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)'; };
    apply();

    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      collapsed = !collapsed;
      apply();
      const body = document.getElementById(BODY_ID);
      if (body) body.style.display = collapsed ? 'none' : '';
      header.style.marginBottom = collapsed ? '0' : '12px';
      saveState();
    };
    btn.addEventListener('click', toggle);
    btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') toggle(e); });
    return btn;
  }

  // One toggle row: bold label (+ optional counter) on the left, checkbox on the right.
  function buildRow(item, headingTextEl, withCounter) {
    const themedColor = headingTextEl ? getComputedStyle(headingTextEl).color : '#e7e9ea';

    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      width: '100%', cursor: 'pointer',
    });

    const left = document.createElement('span');
    Object.assign(left.style, { display: 'inline-flex', alignItems: 'baseline', gap: '6px', minWidth: '0' });

    const text = document.createElement('span');
    text.textContent = item.label;
    Object.assign(text.style, {
      fontFamily: FONT_STACK, fontSize: '15px', fontWeight: '700', lineHeight: '20px',
      color: themedColor, userSelect: 'text', WebkitUserSelect: 'text',
    });
    left.append(text);

    if (withCounter) {
      const counter = document.createElement('span');
      counter.dataset.counter = item.key;
      counter.textContent = '(0/0)';
      Object.assign(counter.style, { fontSize: '13px', color: '#71767b', whiteSpace: 'nowrap' });
      left.append(counter);
    }

    row.append(left, buildCheckbox(item.key));
    return row;
  }

  // "Reset all" link styled like an X accent link.
  function buildReset() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '12px';

    const link = document.createElement('span');
    link.textContent = 'Reset all';
    link.setAttribute('role', 'button');
    link.tabIndex = 0;
    Object.assign(link.style, {
      cursor: 'pointer', fontFamily: FONT_STACK, fontSize: '14px', color: accentColors().bg,
    });
    link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
    link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });

    const run = (e) => { e.preventDefault(); e.stopPropagation(); resetAll(); };
    link.addEventListener('click', run);
    link.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') run(e); });

    wrap.appendChild(link);
    return wrap;
  }

  function resetAll() {
    Object.keys(state).forEach(k => { state[k] = false; });
    FILTERS.forEach(f => hiddenIds[f.key].clear());
    saveState();
    const box = document.getElementById(BOX_ID);
    if (box) box.remove();
    ensureBox();
    applyFilters();
  }

  // Readable checkmark colour for a given accent (black on light accents like yellow, else white).
  function contrastOn(color) {
    let r, g, b;
    const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
    else {
      const h = color.replace('#', '').trim();
      if (h.length < 6) return '#fff';
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0f1419' : '#fff';
  }

  // The user's chosen X accent colour. The "Post" button can be white, so read the accent from
  // Control Panel for Twitter's CSS var if present, otherwise from an accent-coloured link.
  function accentColors() {
    let bg = '';
    try { bg = getComputedStyle(document.body).getPropertyValue('--cpft-theme').trim(); } catch (e) {}
    if (!bg) {
      const link = document.querySelector('[data-testid="tweetText"] a[href], a[href*="/hashtag/"]');
      if (link) bg = getComputedStyle(link).color || '';
    }
    if (!bg) bg = '#1d9bf0';
    return { bg, fg: contrastOn(bg) };
  }

  // X-style square checkbox; checked fill uses the live accent colour.
  function buildCheckbox(key) {
    const box = document.createElement('div');
    box.setAttribute('role', 'checkbox');
    box.tabIndex = 0;
    Object.assign(box.style, {
      flex: '0 0 auto', width: '20px', height: '20px', marginLeft: '12px',
      borderRadius: '4px', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'background-color .15s ease, border-color .15s ease',
    });

    const render = () => {
      const accent = accentColors();
      box.setAttribute('aria-checked', String(state[key]));
      box.style.border = '2px solid ' + (state[key] ? accent.bg : '#536471');
      box.style.backgroundColor = state[key] ? accent.bg : 'transparent';
      box.innerHTML = state[key]
        ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
          '<path fill="' + accent.fg + '" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
        : '';
    };
    render();

    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state[key] = !state[key];
      if (!state[key] && hiddenIds[key]) hiddenIds[key].clear(); // filters only; modifiers have none
      render();
      applyFilters();
      saveState();
    };
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') toggle(e); });
    return box;
  }

  /* -------------------------------- classification -------------------------------- */

  // Profile handle from the URL, or null when not on a profile feed.
  function getProfileOwner() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search',
      'compose', 'hashtag', 'bookmarks', 'lists', 'jobs', 'communities', 'tos', 'privacy', 'about']);
    if (reserved.has(seg[0].toLowerCase())) return null;
    if (seg.includes('status')) return null; // single-tweet page, not a feed
    return seg[0];
  }

  // Author handle + status id from a tweet's permalink (handles relative and absolute hrefs).
  function permalinkInfo(article) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return { author: null, id: null };
    const m = (link.getAttribute('href') || '').match(/(?:https?:\/\/[^/]+)?\/([^/]+)\/status\/(\d+)/);
    return m ? { author: m[1].toLowerCase(), id: m[2] } : { author: null, id: null };
  }

  // Classify a timeline cell (which may hold a multi-tweet conversation) -> { id, cats } or null.
  function classify(cell) {
    const articles = Array.from(cell.querySelectorAll('[data-testid="tweet"]'));
    if (!articles.length) return null;

    const owner = (activeProfile || '').toLowerCase();
    const infos = articles.map(a => {
      const { author, id } = permalinkInfo(a);
      const ctx = a.querySelector('[data-testid="socialContext"]');
      const s = ctx ? ctx.textContent.toLowerCase() : '';
      return {
        author, id,
        pinned: /pinned/.test(s),
        retweet: /repost|retweet/.test(s),
        replyingTo: /replying to/i.test(a.textContent),
        quote: !!a.querySelector('div[role="link"] [data-testid="User-Name"]'),
        // X's hashed thread-connector line. anyLine = part of a thread; upLine = continues from
        // above (the reply itself, vs. a parent's down-line). Update these if reply-hiding breaks.
        anyLine: !!a.querySelector('.r-1bnu78o.r-f8sm7e.r-m5arl1'),
        upLine:  !!a.querySelector('.r-1bnu78o.r-f8sm7e.r-m5arl1.r-1p0dtai'),
      };
    });

    const last        = infos[infos.length - 1];
    const multi       = articles.length >= 2;
    const otherAuthor = !!owner && infos.some(x => x.author && x.author !== owner);

    // Reply (counted): continues a thread, says "Replying to", or an in-cell conversation that
    // includes another user's tweet.
    const isReply = infos.some(x => x.upLine || x.replyingTo) || (multi && otherAuthor);
    // Thread context (e.g. the parent tweet shown above a reply in its own cell): hidden with
    // replies but not counted as a reply itself.
    const isThreadPart = infos.some(x => x.anyLine) || isReply;
    const replyContext = isThreadPart && !isReply;

    const isPinned  = infos.some(x => x.pinned);
    const isRetweet = !isThreadPart && infos.some(x => x.retweet);
    const isQuote   = !isThreadPart && last.quote;
    const isPost    = !isPinned && !isRetweet && !isQuote && !isThreadPart;

    // Orthogonal to type: does the cell contain any media?
    const hasMedia = !!cell.querySelector(MEDIA_SEL);

    let id = null;
    for (let i = infos.length - 1; i >= 0; i--) { if (infos[i].id) { id = infos[i].id; break; } }

    return {
      id, replyContext,
      cats: {
        pinned: isPinned, replies: isReply, quotes: isQuote, retweets: isRetweet, posts: isPost,
        mediaposts: hasMedia, textonly: !hasMedia,
      },
    };
  }

  // A "Show more replies" / "Show this thread" expander cell (a conversation link, no tweet).
  function isReplyExpander(cell) {
    if (cell.querySelector('[data-testid="tweet"]')) return false;
    if (cell.querySelector('a[href*="/i/status/"]')) return true;
    return /show\s+(?:more|additional|this)\b[^]*?(?:repl|thread)/i.test(cell.textContent || '');
  }

  /* ----------------------------- per-tweet modifiers ----------------------------- */

  // X reserves media height with a sibling padding-bottom spacer and absolutely positions the
  // image/video over it, so resizing the leaf does nothing. Walk up to the container that owns the
  // spacer (one shared container for a multi-image grid), stopping at the tweet boundary.
  function aspectContainer(mediaEl) {
    let el = mediaEl;
    for (let i = 0; i < 10 && el && el.parentElement; i++) {
      const parent = el.parentElement;
      if (parent.matches && parent.matches('[data-testid="tweet"], article')) break;
      if (parent.querySelector(':scope > div[style*="padding-bottom"]')) return parent;
      el = parent;
    }
    return null;
  }

  function applyTweetMods() {
    document.querySelectorAll('[data-testid="tweet"]').forEach(tweet => {
      // Text
      tweet.querySelectorAll('[data-testid="tweetText"]').forEach(el => {
        el.style.display = state.hideText ? 'none' : '';
      });
      // "Show more" long-text expander is a sibling of tweetText, so hide/restore it too.
      if (state.hideText || textWasActive) {
        tweet.querySelectorAll('span').forEach(sp => {
          if (sp.textContent.trim() !== 'Show more') return;
          let node = sp;
          while (node.parentElement && node.parentElement !== tweet &&
                 node.parentElement.textContent.trim() === 'Show more') node = node.parentElement;
          node.style.display = state.hideText ? 'none' : '';
        });
      }

      // Media (photos, videos, link-card embeds)
      tweet.querySelectorAll(MEDIA_SEL).forEach(el => {
        const target = aspectContainer(el) || el;
        if (target !== el) { el.style.maxHeight = ''; el.style.overflow = ''; } // size the container
        if (state.hideMedia) {
          target.style.display = 'none';
          target.style.maxHeight = ''; target.style.overflow = '';
        } else if (state.compact) {
          target.style.display = '';
          target.style.maxHeight = COMPACT_MEDIA_MAX; target.style.overflow = 'hidden';
        } else {
          target.style.display = '';
          target.style.maxHeight = ''; target.style.overflow = '';
        }
      });
    });
    textWasActive = state.hideText;
  }

  /* --------------------------------- apply / counters --------------------------------- */

  function applyFilters() {
    // Reset cumulative counts when switching to a different profile.
    const owner = getProfileOwner();
    if (owner !== activeProfile) {
      activeProfile = owner;
      FILTERS.forEach(f => { seen[f.key].clear(); hiddenIds[f.key].clear(); });
    }

    document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach(cell => {
      const info = classify(cell);
      if (!info) {
        // Non-tweet cell: hide orphaned "Show more replies" expanders together with replies.
        cell.style.display = (state.replies && isReplyExpander(cell)) ? 'none' : '';
        return;
      }

      let hide = false;
      FILTERS.forEach(f => {
        if (!info.cats[f.key]) return;
        if (info.id) seen[f.key].add(info.id);
        if (state[f.key]) { hide = true; if (info.id) hiddenIds[f.key].add(info.id); }
      });
      if (info.replyContext && state.replies) hide = true; // hide a reply's context tweet with it
      cell.style.display = hide ? 'none' : '';
    });

    const box = document.getElementById(BOX_ID);
    if (box) {
      FILTERS.forEach(f => {
        const el = box.querySelector('[data-counter="' + f.key + '"]');
        if (!el) return;
        const total = seen[f.key].size;
        el.textContent = '(' + (state[f.key] ? hiddenIds[f.key].size : 0) + '/' + total + ')';
      });
    }

    applyTweetMods();
  }

  /* ------------------------------------ wiring ------------------------------------ */

  function ensureBox() {
    if (document.getElementById(BOX_ID)) return;
    const section = findSection();
    if (!section) return;
    const card = findCard(section);
    if (!card || !card.parentNode) return;
    card.parentNode.insertBefore(buildBox(card, findHeadingTextEl(section)), card);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensureBox(); applyFilters(); });
  }

  loadState();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
