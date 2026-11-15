// ==UserScript==
// @name         Hide My Info
// @namespace    ceeprus
// @version      3.1
// @description  Masks the emails, names and addresses you list on every site: page text, tab title, tooltips, form fields, editors
// @author       ceeprus
// @icon         https://raw.githubusercontent.com/ceeprus/userscript/main/assets/ceeprus-64.png
// @homepage     https://github.com/ceeprus/userscript
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/privacy/hide-my-info.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/privacy/hide-my-info.user.js
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
        words.push([esc(term).replace(/\s+/g, "\\s+"), alias]); // any spacing: pages use nbsp and line breaks
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

  // One highlight per document: editors that live in a same-origin frame (TinyMCE, CKEditor) need their own.
  const highlights = new WeakMap(); // document -> Highlight, or null where unsupported
  function highlightFor(doc) {
    if (highlights.has(doc)) return highlights.get(doc);
    let hl = null;
    try {
      const win = doc.defaultView;
      hl = new win.Highlight();
      win.CSS.highlights.set("hide-my-info", hl);
      const css = "::highlight(hide-my-info){color:transparent;background-color:#808080}";
      if (doc === document) GM_addStyle(css);
      else (doc.head || doc.documentElement).append(Object.assign(doc.createElement("style"), { textContent: css }));
    } catch {
      hl = null;
    }
    highlights.set(doc, hl);
    return hl;
  }
  // While you type, the text at the cursor is covered as soon as it is the start of an entry (4 letters, or the whole
  // entry if shorter), so an address being typed never shows in full. Only at the cursor: a finished word that merely
  // starts like an entry ("Spring" for "Springfield") is not hidden once you move on.
  const PREFIX_MIN = 4;
  const squash = (s) => s.toLowerCase().replace(/\s+/g, " ");
  const noDots = (s) => {
    const at = s.indexOf("@");
    return at < 0 ? s.replace(/\./g, "") : s.slice(0, at).replace(/\./g, "") + s.slice(at);
  };
  let prefixTerms = []; // [normalized term, Gmail (dots ignored)]
  function setPrefixTerms(list) {
    prefixTerms = list.map(({ term }) => {
      const gmail = /@(gmail|googlemail)\.com$/i.test(term);
      return [gmail ? noDots(squash(term)) : squash(term), gmail];
    });
  }
  // [start, caret] of the typed text that begins an entry, or null.
  function prefixAt(text, caret) {
    const before = text.slice(0, caret);
    for (const [term, gmail] of prefixTerms) {
      const need = Math.min(PREFIX_MIN, term.length);
      // Dots and doubled spaces make the typed text longer than the entry, hence the 2x window.
      for (let i = Math.max(0, before.length - 2 * term.length); i <= before.length - need; i++) {
        if (i > 0 && /[\p{L}\p{N}_]/u.test(before[i - 1])) continue; // start at a word edge only
        const typed = gmail ? noDots(squash(before.slice(i))) : squash(before.slice(i));
        if (typed.length >= need && term.startsWith(typed)) return [i, caret];
      }
    }
    return null;
  }

  const editRanges = new WeakMap();

  function markEditable(node, hl) {
    for (const r of editRanges.get(node) || []) hl.delete(r);
    for (const r of hl) if (r.collapsed) hl.delete(r);
    const spans = M ? [...node.data.matchAll(M.re)].map((m) => [m.index, m.index + m[0].length]) : [];
    const sel = node.ownerDocument.getSelection();
    const typing = sel && sel.focusNode === node && prefixAt(node.data, sel.focusOffset);
    if (typing) spans.push(typing);
    const ranges = [];
    for (const [start, end] of spans) {
      const r = node.ownerDocument.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
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
    if (p.isContentEditable) {
      if (!hit && !editRanges.has(node) && node.ownerDocument.getSelection()?.focusNode !== node) return;
      const hl = highlightFor(node.ownerDocument);
      if (hl) markEditable(node, hl);
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

  // Field values are what forms submit, so they are never rewritten. Grey bars are drawn over just the hidden
  // part, from an overlay above the page, so the rest of what you type stays readable. Solid bars, not blur:
  // blurred text can be reconstructed.
  const BAR = "#808080";
  // Longhands: the computed "font" shorthand is often empty, which would measure in the wrong font.
  const MIRROR_STYLES = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant", "font-kerning", "font-feature-settings", "font-variation-settings", "letter-spacing", "word-spacing", "text-transform", "text-indent", "text-align", "tab-size", "padding-left", "padding-right", "line-height", "overflow-wrap", "word-break", "direction"];
  const fields = new Map(); // field -> { clip, key, ranges }
  const overlays = new WeakMap(); // document -> { host, root, mirror }
  let gen = 0; // bumped when the list changes, so cached bar positions are redrawn

  function overlayFor(doc) {
    let o = overlays.get(doc);
    if (o && o.host.isConnected) return o;
    const host = doc.createElement("hide-my-info-bars");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;";
    const root = host.attachShadow({ mode: "closed" });
    const mirror = doc.createElement("div");
    mirror.style.cssText = "position:absolute;top:0;left:-99999px;visibility:hidden;box-sizing:content-box;border:0;";
    root.append(mirror);
    doc.documentElement.append(host);
    o = { host, root, mirror };
    overlays.set(doc, o);
    return o;
  }

  // The bars sit in a clip box over the inner area of the field, where a hidden copy of the text puts the matches.
  function drawBars(el) {
    const doc = el.ownerDocument;
    const layer = fields.get(el);
    const o = overlayFor(doc);
    if (layer.clip.parentNode !== o.root) o.root.append(layer.clip);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return (layer.clip.style.display = "none");
    layer.clip.style.cssText = `position:absolute;overflow:hidden;left:${r.left + el.clientLeft}px;top:${r.top + el.clientTop}px;width:${el.clientWidth}px;height:${el.clientHeight}px;`;
    const cs = doc.defaultView.getComputedStyle(el);
    const key = [gen, JSON.stringify(layer.ranges), el.value, el.scrollLeft, el.scrollTop, el.clientWidth, el.clientHeight, cs.fontFamily, cs.fontSize, cs.fontWeight, cs.letterSpacing].join("\n");
    if (key === layer.key) return;
    layer.key = key;
    const area = el.localName === "textarea";
    const m = o.mirror;
    for (const p of MIRROR_STYLES) m.style.setProperty(p, cs.getPropertyValue(p));
    m.style.whiteSpace = area ? "pre-wrap" : "pre";
    const padLeft = parseFloat(cs.paddingLeft), padTop = parseFloat(cs.paddingTop);
    m.style.width = `${el.clientWidth - padLeft - parseFloat(cs.paddingRight)}px`;
    const parts = [];
    let last = 0;
    for (const [start, end] of layer.ranges) {
      if (end <= last) continue;
      const from = Math.max(start, last);
      parts.push(el.value.slice(last, from), Object.assign(doc.createElement("span"), { textContent: el.value.slice(from, end) }));
      last = end;
    }
    parts.push(el.value.slice(last));
    m.replaceChildren(...parts);
    const base = m.getBoundingClientRect();
    const bars = [];
    for (const span of m.querySelectorAll("span"))
      for (const b of span.getClientRects()) {
        // 2px extra on each side covers kerning differences between the copy and the field.
        const x = b.left - base.left - el.scrollLeft - 2;
        const y = area ? padTop + b.top - base.top - el.scrollTop - 1 : 0;
        const height = area ? b.height + 2 : el.clientHeight;
        const bar = doc.createElement("div");
        bar.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${b.width + 4}px;height:${height}px;background:${BAR};border-radius:2px;`;
        bars.push(bar);
      }
    m.replaceChildren();
    layer.clip.replaceChildren(...bars);
  }

  // Runs before every paint while a match is on screen, so scrolling or a layout shift never leaves text uncovered.
  let looping = false;
  function realign() {
    for (const el of [...fields.keys()]) checkField(el); // also catches a dialog opened over the field since last frame
    looping = fields.size > 0;
    if (looping) requestAnimationFrame(realign);
  }

  // A modal dialog or popover sits in the top layer, above any overlay, so a field inside one is covered whole.
  // Same for scaled fields, see checkField.
  const COVER = { background: BAR, color: "transparent", "caret-color": "transparent", "text-shadow": "none", "-webkit-text-security": "disc", "-webkit-text-fill-color": "transparent" };
  const MARK = "data-hide-my-info";
  try {
    GM_addStyle(`[${MARK}]::selection{color:transparent!important;-webkit-text-fill-color:transparent!important;background:transparent!important}`);
  } catch {} // polish only: the inline cover still hides the text
  const covered = new WeakMap(); // field -> its own inline values, put back on uncover
  const inTopLayer = (el) => {
    try {
      return !!el.closest(":modal, :popover-open");
    } catch {
      return false; // selector unsupported means no top layer either
    }
  };
  function setCover(el, on) {
    if (on === covered.has(el)) return;
    if (on) {
      const saved = {};
      for (const [prop, value] of Object.entries(COVER)) {
        const own = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
        el.style.setProperty(prop, value, "important");
        saved[prop] = [...own, el.style.getPropertyValue(prop)]; // as the browser wrote it back, to compare later
      }
      covered.set(el, saved);
      el.setAttribute(MARK, "");
    } else {
      for (const [prop, [value, priority, mine]] of Object.entries(covered.get(el))) {
        if (el.style.getPropertyValue(prop) !== mine) continue; // the site set its own value meanwhile: keep it
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
      covered.delete(el);
      el.removeAttribute(MARK);
    }
  }

  // Full matches, plus the start of an entry being typed at the cursor of the focused field.
  function coverRanges(el) {
    const v = el.value;
    const out = M ? [...v.matchAll(M.re)].map((m) => [m.index, m.index + m[0].length]) : [];
    if (el.getRootNode().activeElement === el) {
      let caret = null;
      try {
        caret = el.selectionEnd; // throws or is null on type=email
      } catch {}
      const typing = prefixAt(v, caret ?? v.length);
      if (typing) out.push(typing);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  function checkField(el) {
    if (el.localName === "input" && SKIP_INPUT_TYPES.has(el.type)) return;
    const ranges = el.isConnected ? coverRanges(el) : [];
    const hit = ranges.length > 0;
    // Scaled or rotated (a popup zoom animation): the text copy cannot line up, so cover the field whole.
    const top = hit && (inTopLayer(el) || Math.abs(el.getBoundingClientRect().width - el.offsetWidth) > 0.5);
    setCover(el, top);
    const bars = hit && !top;
    if (bars !== fields.has(el)) {
      if (bars) fields.set(el, { clip: el.ownerDocument.createElement("div"), key: "", ranges });
      else {
        fields.get(el).clip.remove();
        fields.delete(el);
      }
    }
    if (!bars) return;
    fields.get(el).ranges = ranges;
    drawBars(el); // now, inside the input event, so the typed text is covered before the next paint
    if (!looping) {
      looping = true;
      requestAnimationFrame(realign);
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
    if (el === panel || el.localName === "hide-my-info-bars") return;
    maskAttrs(el);
    const tag = el.localName;
    if (tag === "input" || tag === "textarea") checkField(el);
    else if (tag === "iframe" || tag === "frame") hookFrame(el);
    const sr = el.openOrClosedShadowRoot || el.shadowRoot;
    if (sr) watch(sr);
    else if (tag.includes("-") && !el.matches(":defined")) pendingHosts.add(el);
  }

  // A custom element defined after it was inserted gets its shadow root on upgrade, which no observer reports.
  const pendingHosts = new Set();
  function checkPendingHosts() {
    for (const el of pendingHosts) {
      const sr = el.openOrClosedShadowRoot || el.shadowRoot;
      if (sr) watch(sr);
      if (sr || !el.isConnected || el.matches(":defined")) pendingHosts.delete(el);
    }
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
    setPrefixTerms(list);
    gen++;
    for (const root of [...roots]) scan(root);
    if (panel && panel.isConnected) panel.render();
  }

  M = buildMatcher(entries);
  setPrefixTerms(entries);
  watch(document);

  GM_addValueChangeListener(KEY, (_name, _old, value) => {
    const list = sanitize(value);
    if (JSON.stringify(list) !== applied) apply(list);
  });

  setInterval(() => {
    checkPendingHosts(); // also in hidden tabs, or elements removed meanwhile stay referenced
    if (document.hidden || !M) return;
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

    const host = h("hide-my-info-panel", "all:initial;display:block;user-select:none;-webkit-user-select:none;position:fixed;top:16px;right:16px;z-index:2147483647;width:min(clamp(440px,30vw,560px),calc(100vw - 32px))");
    const root = host.attachShadow({ mode: "closed" });
    addSheet(
      root,
      `input::placeholder{color:${c.muted};opacity:1}
      button:focus-visible,input:focus-visible{outline:2px solid ${c.fg};outline-offset:2px}
      button:not(.primary):not(.armed):hover{background:${c.field}!important}
      .primary:hover{opacity:.88}
      .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @media (pointer:coarse){button,input[type=text]{min-height:44px}.close{min-width:44px}}
      button{transition:transform 90ms ease-out,background-color 150ms ease-out,border-color 150ms ease-out,color 150ms ease-out}
      button:active{transform:scale(.97)}
      .panel{transform-origin:top right;animation:hme-in 180ms cubic-bezier(.22,1,.36,1)}
      @keyframes hme-in{from{opacity:0;transform:scale(.95)}}
      input[aria-invalid=true]{border-color:${c.danger}!important}
      .added{animation:hme-added 600ms ease-out}
      @keyframes hme-added{from{background:${c.field}}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}button:active{transform:none}}`,
    );

    const termIn = h("input", fieldCss, { id: "hme-term", type: "text", placeholder: "name@example.com", autocomplete: "off", spellcheck: false });
    const aliasIn = h("input", fieldCss, { id: "hme-alias", type: "text", autocomplete: "off", spellcheck: false });
    const hideBtn = h("button", btnCss + `flex:0 0 auto;background:${c.fg};border-color:${c.fg};color:${c.bg};font-weight:600`, { type: "button", className: "primary", textContent: "Hide" });
    const error = h("p", `${font}margin:8px 0 0;color:${c.danger};`, { role: "alert", hidden: true });
    const heading = h("h3", `${font}margin:16px 0 2px;font-weight:600;color:${c.muted};`);
    const list = h("div");
    const filterIn = h("input", fieldCss + "margin-top:8px;", { type: "search", placeholder: "Filter by label or text", autocomplete: "off", spellcheck: false });
    filterIn.setAttribute("aria-label", "Filter the list");
    filterIn.addEventListener("input", () => host.render());
    // Remembered across pages so a long list stays folded.
    const folded = GM_getValue("folded", {});
    const isMail = (term) => /@\S/.test(term);
    const reveal = h("input", `margin:0;width:16px;height:16px;flex:0 0 auto;accent-color:${c.fg};`, { type: "checkbox" });
    const closeBtn = h("button", btnCss + "padding:2px 9px;font-size:18px;line-height:1.2", { type: "button", className: "close", textContent: "×" });
    closeBtn.setAttribute("aria-label", "Close");

    // Dots from the first letter on, like a password field (type=password would start password-manager prompts).
    const dots = CSS.supports("-webkit-text-security", "disc");
    // Editing shows the saved text in the clear, since you need to see what you are changing.
    const maskTerm = () => {
      const clear = reveal.checked || editTerm !== null;
      if (dots) termIn.style.setProperty("-webkit-text-security", clear ? "none" : "disc");
      else termIn.style.color = clear ? c.fg : "transparent";
    };
    termIn.addEventListener("input", maskTerm);
    for (const field of [termIn, aliasIn]) field.addEventListener("input", () => field.removeAttribute("aria-invalid"));
    let added = new Set();
    // The term being edited, not its row: another tab can reorder the list meanwhile.
    let editTerm = null;
    const editIndex = () => (editTerm === null ? -1 : entries.findIndex((e) => e.term === editTerm));

    // Same grey as the editor mask, and the same width for every entry so the bar does not give away the length.
    function masked(term) {
      if (reveal.checked) return h("span", null, { textContent: term });
      const bar = h("span", "display:inline-block;width:4.5em;height:.9em;vertical-align:-1px;border-radius:2px;background:#808080;");
      bar.setAttribute("aria-hidden", "true");
      const at = term.lastIndexOf("@");
      return h("span", null, null, bar, h("span", null, { className: "sr", textContent: "hidden text" }), at < 0 ? "" : term.slice(at));
    }

    host.render = () => {
      maskTerm();
      const editing = editIndex();
      if (editing < 0) editTerm = null;
      hideBtn.textContent = editing < 0 ? "Hide" : "Save";
      aliasIn.placeholder = `hidden${entries.length + 1}`;
      heading.textContent = `Hidden on every site (${entries.length})`;
      heading.hidden = filterIn.hidden = !entries.length;
      const q = filterIn.value.trim().toLowerCase();
      const rows = entries.map((e, i) => {
        if (q && !e.alias.toLowerCase().includes(q) && !e.term.toLowerCase().includes(q)) return null;
        const rowBtn = btnCss + "flex:0 0 auto;min-width:5.4em;padding:3px 10px";
        // Two presses instead of confirm(): the first arms the button for 3 s, the second acts.
        const twoPress = (label, aria, armedColor, run) => {
          const btn = h("button", rowBtn, { type: "button", textContent: label });
          btn.setAttribute("aria-label", aria);
          let armed = 0;
          const disarm = () => {
            clearTimeout(armed);
            armed = 0;
            btn.textContent = label;
            btn.className = "";
            btn.setAttribute("aria-label", aria);
            btn.style.background = "transparent";
            btn.style.borderColor = c.edge;
            btn.style.color = c.fg;
          };
          btn.addEventListener("click", () => {
            if (armed) return run();
            btn.textContent = "Confirm";
            btn.className = "armed";
            btn.setAttribute("aria-label", `Confirm: ${aria}`);
            btn.style.background = btn.style.borderColor = armedColor;
            btn.style.color = c.bg;
            armed = setTimeout(disarm, 3000);
          });
          btn.addEventListener("blur", disarm);
          return btn;
        };
        const fill = (term) => {
          editTerm = term;
          termIn.value = term === null ? "" : e.term;
          aliasIn.value = term === null ? "" : e.alias;
          host.render();
          termIn.focus();
        };
        // Edit shows the real text, so opening it takes two presses too; Cancel does not.
        let edit;
        if (i === editing) {
          edit = h("button", rowBtn, { type: "button", textContent: "Cancel" });
          edit.setAttribute("aria-label", `Cancel editing ${e.alias}`);
          edit.addEventListener("click", () => fill(null));
        } else edit = twoPress("Edit", `Edit ${e.alias}`, c.fg, () => fill(e.term));
        const remove = twoPress("Remove", `Remove ${e.alias}`, c.danger, () => {
          if (editing === i) {
            termIn.value = aliasIn.value = "";
            editTerm = null;
          }
          save(entries.filter((_, k) => k !== i));
        });
        return h(
          "li",
          `display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid ${c.line};`,
          added.has(e.term.toLowerCase()) ? { className: "added" } : null,
          h("span", `${font}flex:0 0 auto;max-width:45%;font-weight:600;color:${c.fg};overflow-wrap:anywhere;`, { textContent: e.alias }),
          h("span", `${font}flex:1 1 0;min-width:0;color:${c.muted};overflow-wrap:anywhere;`, null, masked(e.term)),
          edit,
          remove,
        );
      });
      const groups = [
        ["mail", "Emails", (e) => isMail(e.term)],
        ["other", "Names and other", (e) => !isMail(e.term)],
      ];
      list.replaceChildren(
        ...groups.map(([key, label, test]) => {
          const items = rows.filter((r, i) => r && test(entries[i]));
          if (!items.length) return "";
          // While filtering every group is open, and that does not overwrite the saved folding.
          const d = h("details", `border-top:1px solid ${c.line};`, { open: !!q || !folded[key] });
          d.addEventListener("toggle", () => {
            if (q) return;
            folded[key] = !d.open;
            GM_setValue("folded", folded);
          });
          d.append(
            h("summary", `${font}cursor:pointer;padding:8px 0;font-weight:600;color:${c.fg};`, { textContent: `${label} (${items.length})` }),
            h("ul", "list-style:none;margin:0;padding:0;", null, ...items),
          );
          return d;
        }),
      );
      added = new Set();
      if (entries.length && !rows.some(Boolean)) list.append(h("p", `${font}margin:0;padding:12px 0 4px;color:${c.muted};`, { textContent: "Nothing matches that filter." }));
      if (!entries.length) list.append(h("p", `${font}margin:0;padding:12px 0 4px;color:${c.muted};`, { textContent: "Nothing hidden yet. Type something above and press Hide." }));
    };

    function fail(message, field) {
      error.textContent = message;
      error.hidden = false;
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }

    function add() {
      const terms = termIn.value.split(/;+/).map((s) => s.trim()).filter(Boolean);
      if (!terms.length) return termIn.focus();
      if (terms.some((t) => t.length < MIN_LENGTH)) return fail(`Each entry needs at least ${MIN_LENGTH} characters.`, termIn);
      // While editing, the old row is dropped and the saved one goes back to its place.
      const editing = editIndex();
      const next = entries.filter((_, k) => k !== editing);
      for (const term of terms) {
        const alias = (terms.length === 1 && aliasIn.value.trim()) || `hidden${next.length + 1}`;
        const i = next.findIndex((e) => e.term.toLowerCase() === term.toLowerCase());
        if (i >= 0) next[i] = { term, alias };
        else next.push({ term, alias });
      }
      if (editing >= 0 && terms.length === 1) {
        const [row] = next.splice(next.findIndex((e) => e.term.toLowerCase() === terms[0].toLowerCase()), 1);
        next.splice(Math.min(editing, next.length), 0, row);
      }
      if (hasLoop(next)) return fail('The "Show it as" text contains one of your hidden words, so it would get hidden too. Use different text.', aliasIn);
      error.hidden = true;
      termIn.removeAttribute("aria-invalid");
      aliasIn.removeAttribute("aria-invalid");
      termIn.value = aliasIn.value = "";
      added = new Set(terms.map((t) => t.toLowerCase()));
      editTerm = null;
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
    const exportBtn = h("button", btnCss, { type: "button", textContent: "Export list" });
    const importBtn = h("button", btnCss, { type: "button", textContent: "Import list" });
    const fileIn = h("input", null, { type: "file", accept: ".json,application/json", hidden: true });
    const status = h("p", hintCss, { role: "status" });

    // The file holds the hidden text unmasked, so it is only written when asked.
    exportBtn.addEventListener("click", () => {
      if (!entries.length) return (status.textContent = "Nothing to export yet.");
      const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }));
      const a = h("a", null, { href: url, download: "hide-my-info.json" });
      root.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Exported ${entries.length} ${entries.length === 1 ? "entry" : "entries"}. The file shows the real text.`;
    });

    importBtn.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", async () => {
      const file = fileIn.files[0];
      fileIn.value = "";
      if (!file) return;
      let incoming;
      try {
        incoming = sanitize(JSON.parse(await file.text()));
      } catch {
        incoming = [];
      }
      if (!incoming.length) return (status.textContent = "That file has no entries this script can read.");
      const next = entries.slice();
      for (const e of incoming) {
        const i = next.findIndex((x) => x.term.toLowerCase() === e.term.toLowerCase());
        if (i >= 0) next[i] = { term: e.term, alias: e.alias };
        else next.push({ term: e.term, alias: e.alias });
      }
      if (hasLoop(next)) return (status.textContent = "Not imported: a label in that file contains one of the hidden words.");
      added = new Set(incoming.map((e) => e.term.toLowerCase()));
      save(next);
      status.textContent = `Imported ${incoming.length} ${incoming.length === 1 ? "entry" : "entries"}.`;
    });

    hideBtn.addEventListener("click", add);
    reveal.addEventListener("change", host.render);
    closeBtn.addEventListener("click", host.close);

    const title = h("h2", `${font}margin:0;font-size:15px;font-weight:600;color:${c.fg};`, { id: "hme-title", textContent: "Hide My Info" });
    const box = h(
      "div",
      `${font}box-sizing:border-box;max-height:calc(100vh - 32px);overflow:auto;padding:14px 16px 16px;border:1px solid ${c.edge};border-radius:10px;background:${c.bg};color:${c.fg};box-shadow:0 8px 28px rgba(0,0,0,.3);`,
      { role: "dialog", className: "panel" },
      h("div", "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;", null, title, closeBtn),
      h("label", labelCss, { htmlFor: "hme-term", textContent: "Email, name or address to hide" }),
      termIn,
      h("p", hintCss, { textContent: "Add several at once by separating them with ;" }),
      h(
        "div",
        "display:flex;align-items:flex-end;gap:8px;margin-top:12px;",
        null,
        h("div", "flex:1 1 auto;min-width:0;", null, h("label", labelCss, { htmlFor: "hme-alias", textContent: "Show it as" }), aliasIn),
        hideBtn,
      ),
      error,
      h("label", `${font}display:flex;align-items:center;gap:8px;margin-top:14px;color:${c.fg};cursor:pointer;`, null, reveal, "Show hidden text in this panel"),
      h("p", hintCss, { textContent: "Keep this off while streaming. Removed entries stay masked in open tabs until you reload them." }),
      heading,
      filterIn,
      list,
      h("div", `display:flex;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid ${c.line};`, null, exportBtn, importBtn, fileIn),
      status,
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
    GM_registerMenuCommand("Edit hidden info", togglePanel);
  }
})();
