// ==UserScript==
// @name         GitHub Commit Email Revealer
// @namespace    https://github.com/
// @version      5.2.0
// @description  Shows all commit author emails in a popup next to Browse Files, with live status indicator
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @author       cee
// @match        https://github.com/*
// @grant        GM_xmlhttpRequest
// @connect      github.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/github/user-mail.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/github/user-mail.user.js
// ==/UserScript==

(function () {
  'use strict';

  const COMMIT_RE = /^\/[^/]+\/[^/]+\/commit\/[0-9a-f]+\/?$/i;

  let patchUrl = '';

  // GitHub's Primer tokens follow the light/dark theme; the fallbacks are the old dark values.
  const STATES = {
    waiting: {
      icon: '⋯', label: 'waiting…',
      color: 'var(--fgColor-muted, #8b949e)',
      bg: 'var(--bgColor-neutral-muted, rgba(139,148,158,.1))',
      border: 'var(--borderColor-neutral-muted, rgba(139,148,158,.25))',
      spin: false,
    },
    fetching: {
      icon: '↻', label: 'fetching .patch…',
      color: 'var(--fgColor-attention, #d29922)',
      bg: 'var(--bgColor-attention-muted, rgba(210,153,34,.1))',
      border: 'var(--borderColor-attention-muted, rgba(210,153,34,.3))',
      spin: true,
    },
    parsing: {
      icon: '↻', label: 'parsing…',
      color: 'var(--fgColor-attention, #d29922)',
      bg: 'var(--bgColor-attention-muted, rgba(210,153,34,.1))',
      border: 'var(--borderColor-attention-muted, rgba(210,153,34,.3))',
      spin: true,
    },
    ready: {
      icon: '✉', label: null, // label set dynamically
      color: 'var(--fgColor-accent, #58a6ff)',
      bg: 'var(--bgColor-accent-muted, rgba(88,166,255,.1))',
      border: 'var(--borderColor-accent-muted, rgba(88,166,255,.3))',
      spin: false,
    },
    noreply: {
      icon: '✉', label: null,
      color: 'var(--fgColor-muted, #8b949e)',
      bg: 'var(--bgColor-neutral-muted, rgba(118,131,144,.12))',
      border: 'var(--borderColor-neutral-muted, rgba(118,131,144,.3))',
      spin: false,
    },
    error: {
      icon: '✕', label: 'failed',
      color: 'var(--fgColor-danger, #f85149)',
      bg: 'var(--bgColor-danger-muted, rgba(248,81,73,.1))',
      border: 'var(--borderColor-danger-muted, rgba(248,81,73,.3))',
      spin: false,
    },
  };

  let pillEl    = null;
  let iconEl    = null;
  let labelEl   = null;
  let spinFrame = null;
  let popup     = null;
  let isOpen    = false;
  let injecting = false;
  let currentEntries = [];

  function createPill() {
    pillEl = document.createElement('button');
    pillEl.type = 'button';
    pillEl.dataset.emailPill = '1';
    pillEl.style.cssText = `
      display: inline-flex; align-items: center; gap: 5px;
      padding: 0 10px; height: 28px; border-radius: 6px;
      font: 12px/1 ui-monospace, 'Cascadia Code', monospace;
      cursor: default; white-space: nowrap; vertical-align: middle;
      transition: background .15s, color .15s, border-color .15s;
    `;

    iconEl = document.createElement('span');
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.style.cssText = 'opacity:.8; font-style:normal; display:inline-block; transition:transform .1s;';

    labelEl = document.createElement('span');

    pillEl.appendChild(iconEl);
    pillEl.appendChild(labelEl);

    pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentEntries.length) return;
      if (isOpen) { closePopup(); return; }
      openPopup(currentEntries, pillEl);
    });

    return pillEl;
  }

  function applyState(stateKey, labelOverride) {
    const s = STATES[stateKey];
    const clickable = stateKey === 'ready' || stateKey === 'noreply';

    pillEl.style.color       = s.color;
    pillEl.style.background  = s.bg;
    pillEl.style.border      = `1px solid ${s.border}`;
    pillEl.style.cursor      = clickable ? 'pointer' : 'default';
    pillEl.title             = stateKey === 'fetching' ? patchUrl
                             : stateKey === 'error'    ? 'Could not load .patch file'
                             : clickable               ? 'Click to show email(s)'
                             : '';
    pillEl.setAttribute('aria-haspopup', clickable ? 'dialog' : 'false');
    pillEl.setAttribute('aria-expanded', 'false');

    iconEl.textContent = s.icon;

    if (spinFrame) cancelAnimationFrame(spinFrame);
    if (s.spin) {
      let angle = 0;
      const spin = () => {
        angle = (angle + 4) % 360;
        iconEl.style.transform = `rotate(${angle}deg)`;
        spinFrame = requestAnimationFrame(spin);
      };
      spinFrame = requestAnimationFrame(spin);
    } else {
      iconEl.style.transform = '';
    }

    labelEl.textContent = labelOverride ?? s.label ?? '';

    pillEl.onmouseenter = currentEntries.length
      ? () => pillEl.style.background = stateKey === 'noreply'
          ? 'rgba(118,131,144,.2)' : 'rgba(88,166,255,.18)'
      : null;
    pillEl.onmouseleave = () => pillEl.style.background = s.bg;
  }

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
    isOpen = false;
    if (pillEl) pillEl.setAttribute('aria-expanded', 'false');
  }

  function copyRow(email, btn) {
    const done = (text, color) => {
      if (!btn) return;
      btn.textContent = text;
      btn.style.color = color;
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.style.color = 'var(--button-default-fgColor-rest, #c9d1d9)';
      }, 1500);
    };
    navigator.clipboard.writeText(email).then(
      () => done('✓ Copied', 'var(--fgColor-success, #3fb950)'),
      () => done('Copy failed', 'var(--fgColor-danger, #f85149)'),
    );
  }

  function openPopup(entries, anchor) {
    closePopup();
    isOpen = true;
    anchor.setAttribute('aria-expanded', 'true');

    popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Commit emails');
    popup.style.cssText = `
      position: absolute; z-index: 999999;
      min-width: 280px; max-width: 420px;
      background: var(--overlay-bgColor, #161b22); border: 1px solid var(--borderColor-default, #30363d);
      border-radius: 8px; box-shadow: var(--shadow-floating-large, 0 8px 32px rgba(0,0,0,.6));
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 14px 8px; border-bottom: 1px solid var(--borderColor-muted, #21262d);
      display: flex; justify-content: space-between; align-items: center;
    `;
    header.innerHTML = `
      <span style="color:var(--fgColor-muted, #8b949e);font-size:12px;font-weight:600;">
        ${entries.length} email${entries.length > 1 ? 's' : ''} found
      </span>
      <a href="${patchUrl}" target="_blank" rel="noopener"
         style="color:var(--fgColor-accent, #58a6ff);font-size:12px;text-decoration:none;">
        view .patch ↗
      </a>`;
    popup.appendChild(header);

    entries.forEach(({ name, email, role }, i) => {
      const isNoreply = email.includes('noreply.github.com');
      const row = document.createElement('div');
      row.style.cssText = `
        padding: 10px 14px;
        ${i < entries.length - 1 ? 'border-bottom: 1px solid var(--borderColor-muted, #21262d);' : ''}
        cursor: ${isNoreply ? 'default' : 'pointer'};
        transition: background .1s;
      `;
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="overflow:hidden;min-width:0;">
            <div style="color:var(--fgColor-muted, #8b949e);font-size:11px;margin-bottom:3px;">${esc(role)}</div>
            <div style="color:var(--fgColor-default, #e6edf3);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
            <div style="color:${isNoreply ? 'var(--fgColor-muted, #8b949e)' : 'var(--fgColor-accent, #58a6ff)'};font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;margin-top:2px;word-break:break-all;">${esc(email)}</div>
          </div>
          ${!isNoreply ? `<button type="button" aria-label="Copy ${esc(email)}" style="flex-shrink:0;background:var(--button-default-bgColor-rest, #21262d);border:1px solid var(--button-default-borderColor-rest, #30363d);border-radius:5px;color:var(--button-default-fgColor-rest, #c9d1d9);padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;">Copy</button>` : ''}
        </div>`;

      if (!isNoreply) {
        const btn = row.querySelector('button');
        btn.addEventListener('click', e => { e.stopPropagation(); copyRow(email, btn); });
        row.addEventListener('click', () => copyRow(email, btn));
        row.onmouseenter = () => row.style.background = 'var(--bgColor-muted, #1c2128)';
        row.onmouseleave = () => row.style.background = '';
      }

      popup.appendChild(row);
    });

    document.body.appendChild(popup);

    const rect = anchor.getBoundingClientRect();
    popup.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
    popup.style.left = (rect.left   + window.scrollX)     + 'px';

    requestAnimationFrame(() => {
      if (!popup) return;
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8)
        popup.style.left = (window.innerWidth - pr.width - 8 + window.scrollX) + 'px';
    });

    // The popup sits at the end of <body>, so keyboard users are taken into it.
    const first = popup.querySelector('button') || popup.querySelector('a');
    if (first) first.focus({ preventScroll: true });
  }

  // RFC 2047 encoded words: format-patch writes non-ASCII names as =?UTF-8?q?...?=
  function decodeWords(s) {
    const WORD = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
    return s
      .replace(/(\?=)\s+(?==\?[^?]+\?[bq]\?)/gi, '$1') // space between encoded words is not text
      .replace(WORD, (whole, charset, enc, text) => {
        try {
          const raw = enc.toLowerCase() === 'b'
            ? atob(text)
            : text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
          return new TextDecoder(charset).decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
        } catch (e) {
          return whole;
        }
      });
  }

  const cleanName = (s) => decodeWords(s.trim()).replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');

  function parseEmails(text) {
    const entries = [];
    const seen = new Set();
    const add = (name, email, role) => {
      if (!email || seen.has(email.toLowerCase())) return;
      seen.add(email.toLowerCase());
      entries.push({ name, email, role });
    };
    // Header block only, with folded lines joined: long encoded names wrap onto the next line.
    const head = text.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
    const from = head.match(/^From:\s*(.+?)\s*<([^>]+)>/m);
    if (from) add(cleanName(from[1]), from[2].trim(), 'Author');
    const coRe = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>/gim;
    let m;
    while ((m = coRe.exec(text)) !== null) add(cleanName(m[1]), m[2].trim(), 'Co-author');
    return entries;
  }

  // `url` pins each attempt to one commit: a navigation mid-way abandons it.
  function tryInject(attempts, url) {
    if (url !== patchUrl) return;
    if (attempts > 30) { injecting = false; return; }

    const actionsBar = document.querySelector(
      '[data-component="PH_Actions"] .d-flex,' +
      '.prc-PageHeader-Actions-wawWm .d-flex,' +
      '[class*="commit-header-actions"] .d-flex'
    );

    if (!actionsBar) {
      setTimeout(() => tryInject(attempts + 1, url), 200);
      return;
    }

    injecting = false;
    if (actionsBar.querySelector('[data-email-pill]')) return;

    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'display:inline-flex;align-items:center;';
    const pill = createPill();
    wrapper.appendChild(pill);
    actionsBar.insertBefore(wrapper, actionsBar.firstChild);

    // A response for a commit we already left must not land on the new pill.
    const stale = () => url !== patchUrl || pill !== pillEl;

    applyState('waiting', 'waiting…');

    // Small delay so the user sees "waiting" before fetch fires
    setTimeout(() => {
      if (stale()) return;
      applyState('fetching');

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(res) {
          if (stale()) return;
          applyState('parsing');

          setTimeout(() => {
            if (stale()) return;
            if (res.status !== 200) {
              applyState('error');
              return;
            }

            const entries = parseEmails(res.responseText);

            if (!entries.length) {
              applyState('error');
              labelEl.textContent = 'no email found';
              return;
            }

            currentEntries = entries;
            const allNoreply = entries.every(e => e.email.includes('noreply.github.com'));
            const first = entries[0];
            const truncated = first.email.length > 22
              ? first.email.slice(0, 20) + '…' : first.email;
            const extra = entries.length > 1 ? ` +${entries.length - 1}` : '';

            applyState(allNoreply ? 'noreply' : 'ready', truncated + extra);
          }, 300); // parsing flash duration
        },
        onerror() {
          if (!stale()) applyState('error');
        },
      });
    }, 150); // waiting flash duration
  }

  document.addEventListener('click', (e) => {
    if (isOpen && popup && !popup.contains(e.target) &&
        (!pillEl || !pillEl.contains(e.target)))
      closePopup();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen) return;
    const inside = popup && popup.contains(document.activeElement);
    closePopup();
    if (inside && pillEl) pillEl.focus();
  });

  // Boot on the first load and on every soft navigation, resetting per-commit state.
  function boot() {
    if (!COMMIT_RE.test(location.pathname)) return;

    const url = location.origin + location.pathname.replace(/\/$/, '') + '.patch';
    if (url === patchUrl && pillEl && pillEl.isConnected) return;

    closePopup();
    if (spinFrame) { cancelAnimationFrame(spinFrame); spinFrame = null; }
    if (pillEl) { (pillEl.parentElement || pillEl).remove(); pillEl = null; }
    currentEntries = [];
    patchUrl = url;
    injecting = true;
    tryInject(0, url);
  }

  boot();
  document.addEventListener('turbo:load', boot);
  document.addEventListener('turbo:render', boot);

  // React pages (commit lists, the commit view) navigate without Turbo events, and a
  // re-render can drop the pill from a header React keeps. Both show up here.
  let lastPath = location.pathname;
  setInterval(() => {
    const moved = location.pathname !== lastPath;
    lastPath = location.pathname;
    const dropped = !injecting && pillEl && !pillEl.isConnected && COMMIT_RE.test(location.pathname);
    if (moved || dropped) boot();
  }, 500);

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
