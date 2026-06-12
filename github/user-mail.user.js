// ==UserScript==
// @name         GitHub Commit Email Revealer
// @namespace    https://github.com/
// @version      5.0.1
// @description  Shows all commit author emails in a popup next to Browse Files, with live status indicator
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @author       cee
// @match        https://github.com/*/*/commit/*
// @grant        GM_xmlhttpRequest
// @connect      github.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/github/user-mail.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/github/user-mail.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (!location.pathname.match(/^\/[^/]+\/[^/]+\/commit\/[0-9a-f]+\/?$/i)) return;

  const patchUrl = location.href.replace(/\/?(\?.*)?$/, '.patch');

  // ── Status states ─────────────────────────────────────────────────────────
  // Each state: { icon, label, color, bg, border, spin }
  const STATES = {
    waiting: {
      icon: '⋯', label: 'waiting…',
      color: '#8b949e', bg: 'rgba(139,148,158,.1)', border: 'rgba(139,148,158,.25)',
      spin: false,
    },
    fetching: {
      icon: '↻', label: 'fetching .patch…',
      color: '#d29922', bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.3)',
      spin: true,
    },
    parsing: {
      icon: '↻', label: 'parsing…',
      color: '#d29922', bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.3)',
      spin: true,
    },
    ready: {
      icon: '✉', label: null, // label set dynamically
      color: '#58a6ff', bg: 'rgba(88,166,255,.1)', border: 'rgba(88,166,255,.3)',
      spin: false,
    },
    noreply: {
      icon: '✉', label: null,
      color: '#768390', bg: 'rgba(118,131,144,.12)', border: 'rgba(118,131,144,.3)',
      spin: false,
    },
    error: {
      icon: '✕', label: 'failed',
      color: '#f85149', bg: 'rgba(248,81,73,.1)', border: 'rgba(248,81,73,.3)',
      spin: false,
    },
  };

  // ── Pill element ──────────────────────────────────────────────────────────

  let pillEl    = null;
  let iconEl    = null;
  let labelEl   = null;
  let spinFrame = null;
  let popup     = null;
  let isOpen    = false;
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

    pillEl.style.color       = s.color;
    pillEl.style.background  = s.bg;
    pillEl.style.border      = `1px solid ${s.border}`;
    pillEl.style.cursor      = (stateKey === 'ready' || stateKey === 'noreply') ? 'pointer' : 'default';
    pillEl.title             = stateKey === 'fetching' ? patchUrl
                             : stateKey === 'error'    ? 'Could not load .patch file'
                             : stateKey === 'ready'    ? 'Click to show email(s)'
                             : '';

    iconEl.textContent = s.icon;

    // Spin animation for loading states
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

    // Hover
    pillEl.onmouseenter = currentEntries.length
      ? () => pillEl.style.background = stateKey === 'noreply'
          ? 'rgba(118,131,144,.2)' : 'rgba(88,166,255,.18)'
      : null;
    pillEl.onmouseleave = () => pillEl.style.background = s.bg;
  }

  // ── Popup ─────────────────────────────────────────────────────────────────

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
    isOpen = false;
  }

  function openPopup(entries, anchor) {
    closePopup();
    isOpen = true;

    popup = document.createElement('div');
    popup.style.cssText = `
      position: absolute; z-index: 999999;
      min-width: 280px; max-width: 420px;
      background: #161b22; border: 1px solid #30363d;
      border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.6);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; overflow: hidden;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 14px 8px; border-bottom: 1px solid #21262d;
      display: flex; justify-content: space-between; align-items: center;
    `;
    header.innerHTML = `
      <span style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">
        ${entries.length} Email${entries.length > 1 ? 's' : ''} found
      </span>
      <a href="${patchUrl}" target="_blank"
         style="color:#58a6ff;font-size:11px;text-decoration:none;">
        view .patch ↗
      </a>`;
    popup.appendChild(header);

    // Rows
    entries.forEach(({ name, email, role }, i) => {
      const isNoreply = email.includes('noreply.github.com');
      const row = document.createElement('div');
      row.style.cssText = `
        padding: 10px 14px;
        ${i < entries.length - 1 ? 'border-bottom: 1px solid #21262d;' : ''}
        cursor: ${isNoreply ? 'default' : 'pointer'};
        transition: background .1s;
      `;
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="overflow:hidden;min-width:0;">
            <div style="color:#8b949e;font-size:11px;margin-bottom:3px;">${esc(role)}</div>
            <div style="color:#e6edf3;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
            <div style="color:${isNoreply ? '#768390' : '#58a6ff'};font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;margin-top:2px;word-break:break-all;">${esc(email)}</div>
          </div>
          ${!isNoreply ? `<button style="flex-shrink:0;background:#21262d;border:1px solid #30363d;border-radius:5px;color:#c9d1d9;padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;">Copy</button>` : ''}
        </div>`;

      if (!isNoreply) {
        const btn = row.querySelector('button');
        const doCopy = () => {
          navigator.clipboard.writeText(email).then(() => {
            btn.textContent = '✓ Copied';
            btn.style.color = '#3fb950';
            setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = '#c9d1d9'; }, 1500);
          });
        };
        btn.addEventListener('click', e => { e.stopPropagation(); doCopy(); });
        row.addEventListener('click', doCopy);
        row.onmouseenter = () => row.style.background = '#1c2128';
        row.onmouseleave = () => row.style.background = '';
      }

      popup.appendChild(row);
    });

    document.body.appendChild(popup);

    // Position below pill
    const rect = anchor.getBoundingClientRect();
    popup.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
    popup.style.left = (rect.left   + window.scrollX)     + 'px';

    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8)
        popup.style.left = (window.innerWidth - pr.width - 8 + window.scrollX) + 'px';
    });
  }

  // ── Parse patch text ──────────────────────────────────────────────────────

  function parseEmails(text) {
    const entries = [];
    const seen = new Set();
    const add = (name, email, role) => {
      if (!email || seen.has(email)) return;
      seen.add(email);
      entries.push({ name, email, role });
    };
    const from = text.match(/^From:\s*(.+?)\s*<([^>]+)>/m);
    if (from) add(from[1].trim(), from[2].trim(), 'Author');
    const coRe = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>/gim;
    let m;
    while ((m = coRe.exec(text)) !== null) add(m[1].trim(), m[2].trim(), 'Co-author');
    return entries;
  }

  // ── Inject pill ───────────────────────────────────────────────────────────

  function tryInject(attempts) {
    if (attempts > 30) return;

    const actionsBar = document.querySelector(
      '[data-component="PH_Actions"] .d-flex,' +
      '.prc-PageHeader-Actions-wawWm .d-flex,' +
      '[class*="commit-header-actions"] .d-flex'
    );

    if (!actionsBar) {
      setTimeout(() => tryInject(attempts + 1), 200);
      return;
    }

    if (actionsBar.querySelector('[data-email-pill]')) return;

    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'display:inline-flex;align-items:center;';
    createPill();
    wrapper.appendChild(pillEl);
    actionsBar.insertBefore(wrapper, actionsBar.firstChild);

    // ── Now start the fetch pipeline with status updates ──────────────────

    applyState('waiting', 'waiting…');

    // Small delay so the user sees "waiting" before fetch fires
    setTimeout(() => {
      applyState('fetching');

      GM_xmlhttpRequest({
        method: 'GET',
        url: patchUrl,
        onload(res) {
          applyState('parsing');

          // Give the parsing state a visible moment
          setTimeout(() => {
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
          applyState('error');
        },
      });
    }, 150); // waiting flash duration
  }

  // ── Close on outside click / Escape ──────────────────────────────────────

  document.addEventListener('click', (e) => {
    if (isOpen && popup && !popup.contains(e.target) && e.target !== pillEl)
      closePopup();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closePopup();
  });

  // ── Go ────────────────────────────────────────────────────────────────────

  tryInject(0);

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
