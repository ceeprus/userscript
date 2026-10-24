// ==UserScript==
// @name         Hide My Email
// @namespace    cee
// @version      2.4
// @description  Masks the email addresses you list on every site: page text, tab title, tooltips, form fields, editors
// @author       ceeprus
// @homepage     https://github.com/ceeprus/userscript
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/privacy/hide-my-email.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/privacy/hide-my-email.user.js
// @supportURL   https://github.com/ceeprus/userscript/issues
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const KEY = "entries";
  const MASK_DOMAIN = "hidden";
  const MIN_LENGTH = 3;

  const ATTRS = new Set(["title", "aria-label", "aria-description", "alt", "placeholder", "label", "data-tooltip", "data-tooltip-text"]);
  const SKIP_PARENTS = new Set(["script", "style", "noscript", "textarea"]);
  const SKIP_INPUT_TYPES = new Set(["hidden", "password", "checkbox", "radio", "file", "image", "range", "color"]);
  const WORD = "[\\p{L}\\p{N}_]";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const sanitize = (v) =>
    Array.isArray(v)
      ? v.filter((e) => e && typeof e.term === "string" && typeof e.alias === "string" && e.term.length >= MIN_LENGTH)
      : [];

  // Only listed terms are hidden: a bare username is often a public handle, and rewriting it breaks pages that read it.
  // Gmail entries ignore dots and +tags, as Gmail does.
  function buildMatcher(entries) {
    const emails = [], words = [];
    for (const { term, alias } of entries) {
      const at = term.lastIndexOf("@");
      if (at < 0) {
        words.push([esc(term), alias]);
        continue;
      }
      const local = term.slice(0, at), domain = term.slice(at + 1);
      const gmail = /^(gmail|googlemail)\.com$/i.test(domain);
      const loc = gmail ? [...local.replace(/\./g, "")].map(esc).join("\\.?") : esc(local);
      const dom = gmail ? "(?:gmail|googlemail)\\.com" : esc(domain);
      emails.push([`(?<![\\p{L}\\p{N}_.+-])(${loc}(?:\\+[\\p{L}\\p{N}_.-]*)?(?:@|%40)${dom})(?![\\p{L}\\p{N}_-])`, `${alias}@${MASK_DOMAIN}`]);
    }
    const all = [...emails, ...words.map(([p, a]) => [`(?<!${WORD})(${p})(?!${WORD})`, a])];
    if (!all.length) return null;
    const source = all.map(([p]) => p).join("|");
    return { re: new RegExp(source, "giu"), test: new RegExp(source, "iu"), aliases: all.map(([, a]) => a) };
  }

  // A label that contains a hidden word would be masked again on every pass, forever.
  function hasLoop(entries) {
    const m = buildMatcher(entries);
    return !!m && m.aliases.some((a) => m.test.test(a));
  }

  let M = null;
  const hits = (s) => M !== null && M.test.test(s);
  const mask = (s) =>
    s.replace(M.re, (...m) => M.aliases[m.slice(1, 1 + M.aliases.length).findIndex((g) => g !== undefined)]);

  let hl = null;
  try {
    hl = new Highlight();
    CSS.highlights.set("hide-my-email", hl);
    GM_addStyle("::highlight(hide-my-email){color:transparent;background-color:#808080}");
  } catch {
    hl = null;
  }
  const editRanges = new WeakMap();

  function markEditable(node) {
    for (const r of editRanges.get(node) || []) hl.delete(r);
    for (const r of hl) if (r.collapsed) hl.delete(r);
    const ranges = [];
    for (const m of M ? node.data.matchAll(M.re) : []) {
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      hl.add(r);
      ranges.push(r);
    }
    if (ranges.length) editRanges.set(node, ranges);
    else editRanges.delete(node);
  }

  // Editable text is what the page sends (a reply's quoted header, a draft), so it is only painted over, never rewritten.
  function maskText(node) {
    const p = node.parentNode;
    if (!p || p.nodeType !== 1 || SKIP_PARENTS.has(p.localName)) return;
    const hit = hits(node.data);
    if (!hit && !editRanges.has(node)) return;
    if (p.isContentEditable) {
      if (hl && node.ownerDocument === document) markEditable(node);
      return;
    }
    if (!hit) return;
    const next = mask(node.data);
    if (next !== node.data) node.data = next;
  }

  function maskAttrs(el) {
    if (!el.hasAttributes()) return;
    for (const a of el.attributes) {
      if (!ATTRS.has(a.name) || !hits(a.value)) continue;
      const next = mask(a.value);
      if (next !== a.value) a.value = next;
    }
  }

  // Field values are what forms submit, so they get blurred instead.
  const blurred = new WeakSet();
  function checkField(el) {
    if (el.localName === "input" && SKIP_INPUT_TYPES.has(el.type)) return;
    const hit = hits(el.value);
    if (hit === blurred.has(el)) return;
    if (hit) {
      blurred.add(el);
      el.style.setProperty("filter", "blur(5px)", "important");
    } else {
      blurred.delete(el);
      el.style.removeProperty("filter");
    }
  }
  const onField = (e) => {
    const t = e.composedPath()[0];
    if (t && (t.localName === "input" || t.localName === "textarea")) checkField(t);
  };

  const hookedFrames = new WeakSet();
  function hookFrame(f) {
    const attach = () => {
      try {
        if (f.contentDocument) watch(f.contentDocument);
      } catch {}
    };
    attach();
    if (!hookedFrames.has(f)) {
      hookedFrames.add(f);
      f.addEventListener("load", attach);
    }
  }

  let panel = null;

  function visit(el) {
    if (el === panel) return;
    maskAttrs(el);
    const tag = el.localName;
    if (tag === "input" || tag === "textarea") checkField(el);
    else if (tag === "iframe" || tag === "frame") hookFrame(el);
    const sr = el.openOrClosedShadowRoot || el.shadowRoot;
    if (sr) watch(sr);
  }

  function scan(root) {
    if (root.nodeType === 3) return maskText(root);
    if (root.nodeType === 1) visit(root);
    else if (root.nodeType !== 9 && root.nodeType !== 11) return;
    const w = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) maskText(n);
      else visit(n);
    }
  }

  const observer = new MutationObserver((records) => {
    if (!M) return;
    for (const r of records) {
      if (r.type === "childList") for (const n of r.addedNodes) scan(n);
      else if (r.type === "characterData") maskText(r.target);
      else if (hits(r.target.getAttribute(r.attributeName) || "")) maskAttrs(r.target);
    }
  });
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] };

  const roots = new Set();
  function watch(root) {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, OBSERVE);
    root.addEventListener("input", onField, true);
    root.addEventListener("change", onField, true);
    scan(root);
  }

  let entries = sanitize(GM_getValue(KEY, []));
  let applied = JSON.stringify(entries);

  function apply(list) {
    entries = list;
    applied = JSON.stringify(list);
    M = buildMatcher(list);
    for (const root of [...roots]) scan(root);
    if (panel && panel.isConnected) panel.render();
  }

  M = buildMatcher(entries);
  watch(document);

  GM_addValueChangeListener(KEY, (_name, _old, value) => {
    const list = sanitize(value);
    if (JSON.stringify(list) !== applied) apply(list);
  });

  setInterval(() => {
    if (document.hidden) return;
    for (const root of roots) {
      if (root.host && !root.host.isConnected) continue;
      for (const el of root.querySelectorAll("input, textarea")) checkField(el);
    }
  }, 500);

  function save(list) {
    apply(list);
    GM_setValue(KEY, list);
  }

  function h(tag, css, props, ...kids) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (props) Object.assign(el, props);
    el.append(...kids);
    return el;
  }

  function addSheet(root, css) {
    try {
      GM_addElement(root, "style", { textContent: css });
      return;
    } catch {}
    root.append(h("style", null, { textContent: css }));
  }

  // Everything needed to read and use the panel is inline (CSSOM), which page CSP cannot block. The sheet only
  // adds focus rings, placeholder color, hover and touch sizes, so a site that refuses it still gets a working panel.
  function buildPanel(opener) {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const c = dark
      ? { bg: "#1f1f1f", fg: "#ececec", muted: "#ababab", field: "#2a2a2a", edge: "#787878", line: "#3a3a3a", danger: "#ff8a80" }
      : { bg: "#ffffff", fg: "#1f1f1f", muted: "#595959", field: "#f4f4f4", edge: "#858585", line: "#e3e3e3", danger: "#b3261e" };
    const font = "font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;";
    const control = `${font}box-sizing:border-box;margin:0;padding:6px 10px;border:1px solid ${c.edge};border-radius:6px;`;
    const fieldCss = `${control}display:block;width:100%;min-width:0;background:${c.field};color:${c.fg};`;
    const btnCss = `${control}cursor:pointer;background:transparent;color:${c.fg};`;
    const labelCss = `${font}display:block;margin:0 0 4px;font-weight:600;color:${c.fg};`;
    const hintCss = `${font}margin:6px 0 0;color:${c.muted};`;

    const host = h("hide-my-email-panel", "all:initial;display:block;position:fixed;top:16px;right:16px;z-index:2147483647;width:min(360px,calc(100vw - 32px))");
    const root = host.attachShadow({ mode: "closed" });
    addSheet(
      root,
      `input::placeholder{color:${c.muted};opacity:1}
      button:focus-visible,input:focus-visible{outline:2px solid ${c.fg};outline-offset:2px}
      button:not(.primary):hover{background:${c.field}!important}
      .primary:hover{opacity:.88}
      .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @media (pointer:coarse){button,input[type=text]{min-height:44px}.close{min-width:44px}}`,
    );

    const termIn = h("input", fieldCss, { id: "hme-term", type: "text", placeholder: "name@example.com", autocomplete: "off", spellcheck: false });
    const aliasIn = h("input", fieldCss, { id: "hme-alias", type: "text", autocomplete: "off", spellcheck: false });
    const hideBtn = h("button", btnCss + `flex:0 0 auto;background:${c.fg};border-color:${c.fg};color:${c.bg};font-weight:600`, { type: "button", className: "primary", textContent: "Hide" });
    const error = h("p", `${font}margin:8px 0 0;color:${c.danger};`, { role: "alert", hidden: true });
    const heading = h("h3", `${font}margin:16px 0 2px;font-weight:600;color:${c.muted};`);
    const list = h("ul", "list-style:none;margin:0;padding:0;");
    const reveal = h("input", `margin:0;width:16px;height:16px;flex:0 0 auto;accent-color:${c.fg};`, { type: "checkbox" });
    const closeBtn = h("button", btnCss + "padding:2px 9px;font-size:18px;line-height:1.2", { type: "button", className: "close", textContent: "×" });
    closeBtn.setAttribute("aria-label", "Close");

    const blurTerm = () => (termIn.style.filter = reveal.checked || !termIn.value ? "" : "blur(4px)");
    termIn.addEventListener("input", blurTerm);

    // Same grey as the editor mask, and the same width for every entry so the bar does not give away the length.
    function masked(term) {
      if (reveal.checked) return h("span", null, { textContent: term });
      const bar = h("span", "display:inline-block;width:4.5em;height:.9em;vertical-align:-1px;border-radius:2px;background:#808080;");
      bar.setAttribute("aria-hidden", "true");
      const at = term.lastIndexOf("@");
      return h("span", null, null, bar, h("span", null, { className: "sr", textContent: "hidden address" }), at < 0 ? "" : term.slice(at));
    }

    host.render = () => {
      blurTerm();
      aliasIn.placeholder = `email${entries.length + 1}`;
      heading.textContent = `Hidden on every site (${entries.length})`;
      heading.hidden = !entries.length;
      list.replaceChildren(
        ...entries.map((e, i) => {
          const remove = h("button", btnCss + "flex:0 0 auto;padding:3px 10px", { type: "button", textContent: "Remove" });
          remove.setAttribute("aria-label", `Remove ${e.alias}`);
          remove.addEventListener("click", () => save(entries.filter((_, k) => k !== i)));
          return h(
            "li",
            `display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid ${c.line};`,
            null,
            h("span", `${font}flex:0 0 auto;max-width:45%;font-weight:600;color:${c.fg};overflow-wrap:anywhere;`, { textContent: e.alias }),
            h("span", `${font}flex:1 1 0;min-width:0;color:${c.muted};overflow-wrap:anywhere;`, null, masked(e.term)),
            remove,
          );
        }),
      );
      if (!entries.length) list.append(h("li", `${font}padding:12px 0 4px;color:${c.muted};`, { textContent: "Nothing hidden yet. Type an address above and press Hide." }));
    };

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
    }

    function add() {
      const terms = termIn.value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      if (!terms.length) return termIn.focus();
      if (terms.some((t) => t.length < MIN_LENGTH)) return fail(`Each entry needs at least ${MIN_LENGTH} characters.`);
      const next = entries.slice();
      for (const term of terms) {
        const alias = (terms.length === 1 && aliasIn.value.trim()) || `email${next.length + 1}`;
        const i = next.findIndex((e) => e.term.toLowerCase() === term.toLowerCase());
        if (i >= 0) next[i] = { term, alias };
        else next.push({ term, alias });
      }
      if (hasLoop(next)) return fail('The "Show it as" text contains one of your hidden words, so it would get hidden too. Use different text.');
      error.hidden = true;
      termIn.value = aliasIn.value = "";
      save(next);
      termIn.focus();
    }

    host.close = () => {
      host.remove();
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
    host.onKey = (e) => {
      if (e.key === "Escape") host.close();
      else if (e.key === "Enter" && (root.activeElement === termIn || root.activeElement === aliasIn)) add();
    };
    hideBtn.addEventListener("click", add);
    reveal.addEventListener("change", host.render);
    closeBtn.addEventListener("click", host.close);

    const title = h("h2", `${font}margin:0;font-size:15px;font-weight:600;color:${c.fg};`, { id: "hme-title", textContent: "Hide My Email" });
    const box = h(
      "div",
      `${font}box-sizing:border-box;max-height:calc(100vh - 32px);overflow:auto;padding:14px 16px 16px;border:1px solid ${c.edge};border-radius:10px;background:${c.bg};color:${c.fg};box-shadow:0 8px 28px rgba(0,0,0,.3);`,
      { role: "dialog" },
      h("div", "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;", null, title, closeBtn),
      h("label", labelCss, { htmlFor: "hme-term", textContent: "Email or word to hide" }),
      termIn,
      h("p", hintCss, { textContent: "Add several at once by separating them with commas." }),
      h(
        "div",
        "display:flex;align-items:flex-end;gap:8px;margin-top:12px;",
        null,
        h("div", "flex:1 1 auto;min-width:0;", null, h("label", labelCss, { htmlFor: "hme-alias", textContent: "Show it as" }), aliasIn),
        hideBtn,
      ),
      error,
      heading,
      list,
      h("label", `${font}display:flex;align-items:center;gap:8px;margin-top:14px;color:${c.fg};cursor:pointer;`, null, reveal, "Show full addresses in this panel"),
      h("p", hintCss, { textContent: "Keep this off while streaming. Removed entries stay masked in open tabs until you reload them." }),
    );
    box.setAttribute("aria-labelledby", "hme-title");
    root.append(box);
    host.render();
    return { host, focus: () => termIn.focus() };
  }

  function togglePanel() {
    if (panel && panel.isConnected) return panel.close();
    const built = buildPanel(document.activeElement);
    panel = built.host;
    document.documentElement.append(panel);
    built.focus();
  }

  // From the page, panel keystrokes come from the host element, not a field, so site shortcut handlers eat them.
  // Registered at document-start, this capture listener runs before any page script and stops them first.
  function guardPanel(e) {
    if (!panel || e.target !== panel) return;
    e.stopImmediatePropagation();
    if (e.type === "keydown") panel.onKey(e);
  }

  if (window.top === window) {
    for (const type of ["keydown", "keypress", "keyup", "focusin", "focusout"]) window.addEventListener(type, guardPanel, true);
    GM_registerMenuCommand("Edit hidden emails", togglePanel);
  }
})();
