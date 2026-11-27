// ==UserScript==
// @name         Hide My Info
// @namespace    ceeprus
// @version      3.3.1
// @description  Masks the emails, names and addresses you list on every site (page text, tab title, tooltips, form fields, editors) and images you pick
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

  // "Partial" emails keep their first letter and domain: m•••@gmail.com.
  const partialOf = (term) => {
    const at = term.lastIndexOf("@");
    return `${[...term][0]}•••${term.slice(at)}`;
  };
  // The same text in other letter case is the same entry: replace it in place, else add at the end.
  const upsert = (list, e) => {
    const i = list.findIndex((x) => x.term.toLowerCase() === e.term.toLowerCase());
    if (i >= 0) list[i] = entryOf(e);
    else list.push(entryOf(e));
  };
  const entryOf = (e) => (e.partial === true && e.term.includes("@") ? { term: e.term, alias: e.alias, partial: true } : { term: e.term, alias: e.alias });

  // Near misses: an address one typo away from an entry (jnae@example.com, jane@exmaple.com) still gives it away,
  // so it is hidden too. Emails only: names one letter off are too often other real words.
  const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
  function normEmail(e) {
    const t = e.replace(/[İIı]/g, "i").toLowerCase();
    const at = t.lastIndexOf("@");
    let local = t.slice(0, at).replace(/\+.*/, "");
    let domain = t.slice(at + 1).replace(/^googlemail\.com$/, "gmail.com");
    if (domain === "gmail.com") local = local.replace(/\./g, "");
    return `${local}@${domain}`;
  }
  // One insert, delete, swap of neighbours or changed letter, nothing more.
  function oneOff(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }
  // [start, end, label, entry term] of near misses in s.
  function nearSpans(s) {
    if (!M || !M.near.length || !s.includes("@")) return [];
    const out = [];
    for (const m of s.matchAll(EMAIL)) {
      if (M.test.test(m[0])) continue;
      const n = normEmail(m[0]);
      const hit = M.near.find(([t]) => n.length > 5 && oneOff(n, t));
      if (hit) out.push([m.index, m.index + m[0].length, hit[1], hit[2]]);
    }
    return out;
  }

  // Turkish dotted and dotless i have no case pair in JS, so "cihan" would miss "CİHAN" and "cıhan": match all four.
  const anyI = (p) => p.replace(/[iIıİ]/g, "[iIıİ]");

  // Only listed terms are hidden: a bare username is often a public handle, and rewriting it breaks pages that read it.
  // Gmail entries ignore dots and +tags, as Gmail does.
  function buildMatcher(entries) {
    const emails = [], words = [], near = [];
    for (const { term, alias, partial } of entries) {
      const at = term.lastIndexOf("@");
      if (at < 0) {
        words.push([anyI(esc(term)).replace(/\s+/g, "\\s+"), alias, term]); // any spacing: pages use nbsp and line breaks
        continue;
      }
      const local = term.slice(0, at), domain = term.slice(at + 1);
      const gmail = /^(gmail|googlemail)\.com$/i.test(domain);
      const loc = anyI(gmail ? [...local.replace(/\./g, "")].map(esc).join("\\.?") : esc(local));
      const dom = gmail ? "(?:gmail|googlemail)\\.com" : esc(domain);
      near.push([normEmail(term), partial ? partialOf(term) : `${alias}@${MASK_DOMAIN}`, term]);
      emails.push([`(?<![\\p{L}\\p{N}_.+-])(${loc}(?:\\+[\\p{L}\\p{N}_.-]*)?(?:@|%40)${dom})(?![\\p{L}\\p{N}_-])`, partial ? partialOf(term) : `${alias}@${MASK_DOMAIN}`, term]);
    }
    const all = [...emails, ...words.map(([p, a, t]) => [`(?<!${WORD})(${p})(?!${WORD})`, a, t])];
    if (!all.length) return null;
    const source = all.map(([p]) => p).join("|");
    return { re: new RegExp(source, "giu"), test: new RegExp(source, "iu"), aliases: all.map(([, a]) => a), terms: all.map(([, , t]) => t), near };
  }

  // A label that contains a hidden word would be masked again on every pass, forever.
  function hasLoop(entries) {
    const m = buildMatcher(entries);
    return !!m && m.aliases.some((a) => m.test.test(a));
  }

  // "hidden3" when hidden1 and hidden2 are taken: the first free number, so labels never repeat.
  const freeLabel = (prefix, used) => {
    let n = 1;
    while (used.includes(prefix + n)) n++;
    return prefix + n;
  };

  let M = null;
  const hits = (s) => M !== null && (M.test.test(s) || nearSpans(s).length > 0);
  const mask = (s) => {
    const out = s.replace(M.re, (...m) => M.aliases[m.slice(1, 1 + M.aliases.length).findIndex((g) => g !== undefined)]);
    let at = 0, res = "";
    for (const [a, b, label] of nearSpans(out)) {
      res += out.slice(at, a) + label;
      at = b;
    }
    return res + out.slice(at);
  };
  // The entry behind each match in s, one per match.
  const termsIn = (s) => [...[...s.matchAll(M.re)].map((m) => M.terms[m.slice(1, 1 + M.terms.length).findIndex((g) => g !== undefined)]), ...nearSpans(s).map((x) => x[3])];
  // [start, end] of exact matches, plus [start, end, true] of near misses.
  const spansIn = (s) => [...[...s.matchAll(M.re)].map((m) => [m.index, m.index + m[0].length]), ...nearSpans(s).map(([a, b]) => [a, b, true])];

  // Settings, shared by every site. "sites" never hide; "always" keep hiding even while paused everywhere.
  const SETTINGS = "settings";
  const DEFAULTS = { paused: false, sites: [], always: [], fields: true, style: "box", peek: true };
  const readSettings = (v) => {
    const o = v && typeof v === "object" ? v : {};
    return {
      paused: o.paused === true,
      sites: Array.isArray(o.sites) ? o.sites.filter((x) => typeof x === "string") : [],
      always: Array.isArray(o.always) ? o.always.filter((x) => typeof x === "string") : [],
      fields: o.fields !== false,
      peek: o.peek !== false,
      hold: o.hold === true,
      style: o.style === "blur" ? "blur" : "box",
    };
  };
  let settings = readSettings(GM_getValue(SETTINGS, DEFAULTS));
  // A frame on another host (a sign-in iframe) follows the page it sits in, so pausing the site pauses it too.
  const topHost = (() => {
    if (window.top === window) return location.hostname;
    try {
      return window.top.location.hostname;
    } catch {}
    try {
      const a = location.ancestorOrigins;
      if (a && a.length) return new URL(a[a.length - 1]).hostname;
      if (document.referrer) return new URL(document.referrer).hostname;
    } catch {}
    return location.hostname;
  })();
  const onSite = (list) => list.includes(topHost) || list.includes(location.hostname);
  const siteMode = () => (onSite(settings.always) ? "always" : onSite(settings.sites) ? "never" : "default");
  const active = () => siteMode() === "always" || (siteMode() === "default" && !settings.paused);
  const modeFor = (mode) => {
    const other = (x) => x !== topHost;
    return { sites: [...settings.sites.filter(other), ...(mode === "never" ? [topHost] : [])], always: [...settings.always.filter(other), ...(mode === "always" ? [topHost] : [])] };
  };
  const hlName = () => (settings.style === "blur" ? "hide-my-info-blur" : "hide-my-info");

  // One highlight per document: editors that live in a same-origin frame (TinyMCE, CKEditor) need their own.
  const highlights = new WeakMap(); // document -> Highlight, or null where unsupported
  function nameHighlight(doc) {
    const hl = highlights.get(doc);
    if (!hl) return;
    const reg = doc.defaultView.CSS.highlights;
    reg.delete("hide-my-info");
    reg.delete("hide-my-info-blur");
    reg.set(hlName(), hl);
  }
  function highlightFor(doc) {
    if (highlights.has(doc)) return highlights.get(doc);
    let hl = null;
    try {
      const win = doc.defaultView;
      hl = new win.Highlight();
      win.CSS.highlights.set(hlName(), hl);
      // Highlights cannot blur, so "blur" is a soft grey shadow in place of transparent text.
      const css = "::highlight(hide-my-info){color:transparent;background-color:#808080}::highlight(hide-my-info-blur){color:transparent;text-shadow:0 0 7px #808080}";
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
  const squash = (s) => s.replace(/[İIı]/g, "i").toLowerCase().replace(/\s+/g, " "); // one char each, so indexes hold
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
  let typingNode = null; // editor text that carries a typing cover, redrawn when the cursor moves

  function markEditable(node, hl) {
    for (const r of editRanges.get(node) || []) hl.delete(r);
    for (const r of hl) if (r.collapsed) hl.delete(r);
    const on = M && settings.fields && node !== peekNode;
    const spans = on ? spansIn(node.data) : [];
    const sel = node.ownerDocument.getSelection();
    const typing = on && sel && sel.focusNode === node && prefixAt(node.data, sel.focusOffset);
    if (typing) spans.push(typing);
    if (typing) typingNode = node;
    else if (typingNode === node) typingNode = null;
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
    const found = termsIn(node.data); // read before the rewrite: afterwards only the labels are left
    const next = mask(node.data);
    if (next !== node.data) {
      node.data = next;
      maskedCount.set(node, [found, next]);
    }
  }

  // What is hidden on this page right now, for the panel: entry term or image -> where (text nodes, elements,
  // editor ranges). Things removed from the page drop out.
  // Text or attribute node -> [entry terms rewritten in it, one per match; the text written]. Pages reuse nodes for
  // other text, so a node counts only while it still holds what was written.
  const maskedCount = new Map();
  const stillMasked = (node, written) => (node.nodeType === 2 ? node.ownerElement : node)?.isConnected && node.nodeValue === written;
  function onPage() {
    const by = new Map();
    const put = (key, at) => key !== undefined && (by.get(key) || by.set(key, []).get(key)).push(at);
    for (const [node, [terms, written]] of maskedCount) if (stillMasked(node, written)) for (const t of terms) put(t, node.nodeType === 2 ? node.ownerElement : node);
    const inFields = new Set(fields.keys());
    for (const root of roots) {
      if (root.nodeType === 9 && !root.defaultView) continue;
      for (const el of root.querySelectorAll(`[${MARK}]`)) inFields.add(el);
      // Editor text is only painted over, so its ranges still hold the real text.
      if (M && root.nodeType === 9) for (const r of highlights.get(root) || []) for (const t of termsIn(r.toString())) put(t, r);
      if (imageSel) for (const m of images) if (m.site === topHost) for (const el of root.querySelectorAll(selectorsFor(m).join(","))) put(m, el);
    }
    if (M) for (const el of inFields) for (const t of termsIn(el.value)) put(t, el);
    // A link whose label attribute and text both held the address is one place on the page, not two.
    for (const [key, list] of by) by.set(key, list.filter((at) => at.nodeType !== 1 || !list.some((o) => o.nodeType === 3 && at.contains(o))));
    return by;
  }

  function maskAttrs(el) {
    if (!el.hasAttributes()) return;
    for (const a of el.attributes) {
      if (!ATTRS.has(a.name) || !hits(a.value)) continue;
      const found = termsIn(a.value);
      const next = mask(a.value);
      if (next !== a.value) a.value = next;
      maskedCount.set(a, [found, next]); // per attribute, so a later hit in another one adds instead of replacing
    }
  }

  // Field values are what forms submit, so they are never rewritten. Grey bars are drawn over just the hidden
  // part, from an overlay above the page, so the rest of what you type stays readable. Solid bars, not blur:
  // blurred text can be reconstructed.
  const BAR = "#808080";
  // A near miss is usually your own typo: the dashed edge says "check the spelling here".
  const NEAR_EDGE = "outline:2px dashed #e8a33d;outline-offset:1px;";
  // Blur keeps the shape of the text, so a typo is easier to spot; it is weaker than the box, tools can sharpen it.
  const barLook = () => (settings.style === "blur" ? "backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);background:rgba(128,128,128,.12);" : `background:${BAR};`);
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
    const key = [gen, settings.style, JSON.stringify(layer.ranges), el.value, el.scrollLeft, el.scrollTop, el.clientWidth, el.clientHeight, cs.fontFamily, cs.fontSize, cs.fontWeight, cs.letterSpacing].join("\n");
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
    for (const [start, end, near] of layer.ranges) {
      if (end <= last) continue;
      const from = Math.max(start, last);
      parts.push(el.value.slice(last, from), Object.assign(doc.createElement("span"), { textContent: el.value.slice(from, end), className: near ? "near" : "" }));
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
        bar.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${b.width + 4}px;height:${height}px;${barLook()}border-radius:2px;${span.className ? NEAR_EDGE : ""}`;
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
  const COVERS = {
    // Text only, so the field edge stays sharp. The shadow takes the field text color, read before covering.
    blur: (el) => ({ color: "transparent", "-webkit-text-fill-color": "transparent", "caret-color": "transparent", "text-shadow": `0 0 7px ${el.ownerDocument.defaultView.getComputedStyle(el).color}` }),
    box: { background: BAR, color: "transparent", "caret-color": "transparent", "text-shadow": "none", "-webkit-text-security": "disc", "-webkit-text-fill-color": "transparent" },
  };
  const MARK = "data-hide-my-info";
  try {
    GM_addStyle(`[${MARK}]::selection{color:transparent!important;-webkit-text-fill-color:transparent!important;background:transparent!important}`);
  } catch {} // polish only: the inline cover still hides the text
  const covered = new WeakMap(); // field -> its own inline values, put back on uncover
  const coverStyle = new WeakMap(); // field -> style it was covered with
  const inTopLayer = (el) => {
    try {
      return !!el.closest(":modal, :popover-open");
    } catch {
      return false; // selector unsupported means no top layer either
    }
  };
  function setCover(el, on) {
    if (on && covered.has(el) && coverStyle.get(el) !== settings.style) setCover(el, false); // style changed: redo
    if (on === covered.has(el)) return;
    if (on) {
      const saved = {};
      coverStyle.set(el, settings.style);
      for (const [prop, value] of Object.entries(settings.style === "blur" ? COVERS.blur(el) : COVERS.box)) {
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
    const out = M ? spansIn(v) : [];
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
    const ranges = settings.fields && !peeking.has(el) && el.isConnected && el.ownerDocument.defaultView ? coverRanges(el) : []; // a removed frame's document stays "connected" with no window
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
  // Peek: a click on a cover shows what is under it until the pointer leaves the field or editor (or focus does).
  // Fields and editors only; page text was rewritten to the label, so there is nothing under it to show.
  const peeking = new WeakSet(); // fields shown right now
  let peekNode = null; // editor text shown right now
  function untilLeft(el, done) {
    const end = () => {
      el.removeEventListener("pointerleave", end);
      el.removeEventListener("blur", end);
      done();
    };
    el.addEventListener("pointerleave", end);
    el.addEventListener("blur", end);
  }
  const inside = (rects, x, y) => rects.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  function onPeek(e) {
    if (!settings.peek || !M) return;
    const t = e.composedPath()[0];
    if (t && (t.localName === "input" || t.localName === "textarea")) {
      const bars = fields.has(t) ? [...fields.get(t).clip.children].map((b) => b.getBoundingClientRect()) : [];
      if (peeking.has(t) || !(covered.has(t) || inside(bars, e.clientX, e.clientY))) return;
      peeking.add(t);
      checkField(t);
      untilLeft(t, () => {
        peeking.delete(t);
        checkField(t);
      });
      return;
    }
    // In an editor the click has already put the caret where you clicked.
    const sel = (t && t.ownerDocument || document).getSelection();
    const node = sel && sel.focusNode;
    if (!node || node.nodeType !== 3 || node === peekNode || !node.parentNode?.isContentEditable) return;
    const off = sel.focusOffset;
    if (!(editRanges.get(node) || []).some((r) => r.startOffset <= off && off <= r.endOffset)) return;
    let host = node.parentElement;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    const prev = peekNode;
    peekNode = node;
    if (prev) maskText(prev);
    maskText(node);
    untilLeft(host, () => {
      if (peekNode !== node) return;
      peekNode = null;
      maskText(node);
    });
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
    else if (tag.includes("-") && !el.matches(":defined")) {
      pendingHosts.add(el);
      if (!awaited.has(tag)) {
        awaited.add(tag);
        try {
          el.ownerDocument.defaultView.customElements.whenDefined(tag).then(checkPendingHosts);
        } catch {} // the 500 ms timer still catches it
      }
    }
  }

  // A custom element defined after it was inserted gets its shadow root on upgrade, which no observer reports.
  const pendingHosts = new Set();
  const awaited = new Set(); // tag names with a whenDefined hook
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
    // A cursor move without typing changes no text, so nothing else would take the typing cover off.
    if (root.nodeType === 9) {
      root.addEventListener("selectionchange", () => typingNode && maskText(typingNode));
      root.addEventListener("click", onPeek, true); // composed, so clicks inside shadow roots arrive here too
    }
    scan(root);
    sheetOn(root);
  }

  let entries = sanitize(GM_getValue(KEY, []));
  let applied = JSON.stringify(entries);

  // Images you picked on a page, only ever covered on the site you picked them on. "one": that exact image (same
  // address, ?size included). "all": every size of it there, matched by address without the ?query.
  // A stylesheet covers them, so an image is covered before it is ever drawn.
  const IMAGES = "images";
  const readImages = (v) =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x.label === "string" && typeof x.url === "string" && /^https?:\/\//.test(x.url) && URL.canParse(x.url) && typeof x.site === "string") // a bad address would stop the script on that site
          .map((x) => (x.scope === "one" && typeof x.attr === "string" && x.attr ? x : { ...x, scope: "all" }))
      : [];
  // The path must end where the address does, or "/u/123" would also catch "/u/1234".
  const ENDS = { src: ["", "?", "#"], srcset: ["", "?", " "], style: ["?", ")", '"', "'"], href: ["", "?", "#"] };
  const endsWith = (sel, attr, path) => ENDS[attr].map((end) => (end ? `${sel}[${attr}*=${JSON.stringify(path + end)}]` : `${sel}[${attr}$=${JSON.stringify(path)}]`));
  let images = readImages(GM_getValue(IMAGES, []));
  let imageSel = "", imageCssText = "";
  const imageSheets = new Map(); // window -> its constructed sheet
  let imageFallback = null;
  function selectorsFor({ url, scope, attr, kind }) {
    if (scope === "one") {
      const v = JSON.stringify(attr);
      return [kind === "bg" ? `[style*=${v}]` : kind === "image" ? `image[href=${v}]` : `img[src=${v}]`];
    }
    const u = new URL(url);
    const path = u.pathname.length >= 8 ? u.pathname : u.origin + u.pathname; // a short path alone would catch other images
    return [...endsWith("img", "src", path), ...endsWith("img", "srcset", path), ...endsWith("", "style", path), ...endsWith("image", "href", path)];
  }
  // Box: a filled background turns the see-through parts of an avatar grey too, so its outline does not show.
  const imageLook = () =>
    settings.style === "blur"
      ? { filter: "blur(16px)", "clip-path": "inset(0)" }
      : { filter: "brightness(0) invert(.5)", "clip-path": "inset(0)", "background-color": "#000" }; // invert(.5) of black is the bar grey
  function buildImageCss() {
    imageSel = active() ? images.filter((m) => m.site === topHost).flatMap(selectorsFor).join(",") : "";
    imageCssText = imageSel ? `:is(${imageSel}){${Object.entries(imageLook()).map(([k, v]) => `${k}:${v}!important`).join(";")}}` : "";
  }
  // Shadow roots do not see document styles, so each root adopts the sheet.
  function sheetOn(root) {
    if (!imageCssText) {
      // Adopted sheets were emptied by updateImages; the backup style has to go by hand.
      if (root === document && imageFallback?.remove) imageFallback.remove();
      if (root === document) imageFallback = null;
      return;
    }
    try {
      const win = (root.ownerDocument || root).defaultView;
      if (!win) return;
      let sheet = imageSheets.get(win);
      if (!sheet) {
        sheet = new win.CSSStyleSheet();
        sheet.replaceSync(imageCssText);
        imageSheets.set(win, sheet);
      }
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      // shortcut: without constructed sheets only the top document gets the style, upgrade if a manager blocks them
      if (root !== document) return;
      if (imageFallback && imageFallback.remove) imageFallback.remove();
      imageFallback = imageCssText ? GM_addStyle(imageCssText) : null;
    }
  }
  function updateImages() {
    buildImageCss();
    for (const sheet of imageSheets.values()) sheet.replaceSync(imageCssText);
    for (const root of roots) sheetOn(root);
  }
  buildImageCss();

  // Paused, nothing new is masked and covers come off; text already rewritten on the page comes back on reload.
  function refresh() {
    const on = active();
    M = on ? buildMatcher(entries) : null;
    setPrefixTerms(on ? entries : []);
    gen++;
    for (const root of [...roots]) {
      if (root.nodeType === 9 && root.defaultView) nameHighlight(root);
      scan(root);
    }
    updateImages();
    if (panel && panel.isConnected) panel.render();
  }

  function apply(list) {
    entries = list;
    applied = JSON.stringify(list);
    refresh();
  }

  function setSettings(next) {
    settings = readSettings({ ...settings, ...next });
    GM_setValue(SETTINGS, settings);
    refresh();
  }

  M = active() ? buildMatcher(entries) : null;
  setPrefixTerms(active() ? entries : []);
  // Optional: keep the page blank until the parser is done and everything was checked once, so nothing can flash.
  // At most 400 ms; if the page's CSP blocks the style, the page just shows as usual.
  if (settings.hold && M) {
    const hold = document.createElement("style");
    hold.textContent = "html{visibility:hidden!important}";
    // At document-start <html> may not exist yet; a style put on the document itself would become its root.
    const put = () => (document.head || document.documentElement).append(hold);
    if (document.documentElement) put();
    else
      new MutationObserver((_, mo) => {
        if (!document.documentElement) return;
        mo.disconnect();
        put();
      }).observe(document, { childList: true });
    const release = () => hold.remove();
    document.addEventListener("DOMContentLoaded", release, { once: true });
    setTimeout(release, 400);
  }
  watch(document);

  GM_addValueChangeListener(SETTINGS, (_name, _old, value) => {
    const next = readSettings(value);
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    refresh();
  });
  GM_addValueChangeListener(IMAGES, (_name, _old, value) => {
    images = readImages(value);
    updateImages();
    if (panel && panel.isConnected) panel.render();
  });
  GM_addValueChangeListener(KEY, (_name, _old, value) => {
    const list = sanitize(value);
    if (JSON.stringify(list) !== applied) apply(list);
  });

  setInterval(() => {
    // Also in hidden tabs and while paused, or removed parts of a long-open page stay in memory.
    checkPendingHosts();
    for (const [node, [, written]] of maskedCount) if (!stillMasked(node, written)) maskedCount.delete(node);
    // A frame document that was reloaded or removed, or a shadow root whose element left the page. If the element
    // comes back, visit() watches its root again.
    for (const root of roots) if (root.nodeType === 9 ? !root.defaultView : !root.host.isConnected) roots.delete(root);
    if (panel && panel.isConnected) panel.count();
    if (document.hidden || !M) return;
    for (const root of roots) for (const el of root.querySelectorAll("input, textarea")) checkField(el);
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
    // Row actions repeat on every row, so they are icons; the label stays as the tooltip and accessible name.
    const ICON = { Edit: ["M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"], Remove: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 11v6", "M14 11v6"], Confirm: ["M5 12.5l4.5 4.5L19 7.5"] }; // Confirm keeps the size, so the row never moves under the pointer
    const face = (btn, label) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "16"], ["height", "16"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
      svg.style.cssText = "display:block;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;";
      for (const p of ICON[label]) {
        const e = document.createElementNS("http://www.w3.org/2000/svg", "path");
        e.setAttribute("d", p);
        svg.append(e);
      }
      btn.replaceChildren(svg);
      btn.title = label;
      btn.style.minWidth = "32px";
      btn.style.padding = "5px 7px";
    };
    const labelCss = `${font}display:block;margin:0 0 4px;font-weight:600;color:${c.fg};`;
    const hintCss = `${font}margin:6px 0 0;color:${c.muted};`;

    const host = h("hide-my-info-panel", "all:initial;display:block;user-select:none;-webkit-user-select:none;position:fixed;top:16px;right:16px;z-index:2147483647;width:min(clamp(440px,30vw,560px),calc(100vw - 32px))");
    const root = host.attachShadow({ mode: "closed" });
    addSheet(
      root,
      `input::placeholder{color:${c.muted};opacity:1}
      button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid ${c.fg};outline-offset:2px}
      @media (hover:hover) and (pointer:fine){button:not(.primary):not(.armed):hover{background:${c.field}!important}.primary:hover{opacity:.88}select:hover{border-color:${c.fg}!important}.seg:hover input:not(:checked)+span{background:${c.field}!important}.row:not(.dim):not(:has(:disabled)):hover{background:${c.field}}}
      select,.seg span{transition:background-color 150ms ease,border-color 150ms ease}
      p:empty{display:none}
      select{cursor:pointer}
      :disabled,label:has(:disabled){cursor:not-allowed!important}
      .row{border-radius:4px;margin-inline:-4px;padding-inline:4px!important}
      .dim,.dim legend,.dim .row{color:${c.muted}!important}
      .seg:has(input:focus-visible) span{outline:2px solid ${c.fg};outline-offset:1px}
      .seg{min-height:24px}
      .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @media (pointer:coarse){button,input[type=text],input[type=search],select,.row,summary{min-height:44px}.close{min-width:44px}}
      button{transition:transform 140ms ease-out,background-color 150ms ease,border-color 150ms ease,color 150ms ease}
      button:active{transform:scale(.97)}
      .panel{transform-origin:top right;animation:hme-in 180ms cubic-bezier(.22,1,.36,1)}
      @keyframes hme-in{from{opacity:0;transform:scale(.95)}}
      input[aria-invalid=true]{border-color:${c.danger}!important}
      .shake{animation:hme-shake 200ms ease-out}
      @keyframes hme-shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
      .added{animation:hme-added 600ms ease-out}
      @keyframes hme-added{from{background:${c.field}}}
      @keyframes hme-fade{from{opacity:0}}
      @media (prefers-reduced-motion:reduce){.panel{animation-name:hme-fade}.shake{animation:none}button{transition-property:background-color,border-color,color}button:active{transform:none}}`,
    );

    const termIn = h("input", fieldCss, { id: "hme-term", type: "text", placeholder: "name@example.com; Jane Doe", autocomplete: "off", spellcheck: false });
    const aliasIn = h("input", fieldCss, { id: "hme-alias", type: "text", autocomplete: "off", spellcheck: false });
    const hideBtn = h("button", btnCss + `flex:0 0 auto;background:${c.fg};border-color:${c.fg};color:${c.bg};font-weight:600`, { type: "button", className: "primary", textContent: "Hide" });
    const error = h("p", `${font}margin:8px 0 0;color:${c.danger};`, { role: "alert", hidden: true });
    const heading = h("h3", `${font}margin:0;font-weight:600;color:${c.fg};`);
    // Display order only; matching does not depend on it.
    const sortSel = h("select", `${font}margin:0;padding:2px 6px;border:1px solid ${c.edge};border-radius:6px;background:${c.field};color:${c.fg};`, null,
      h("option", null, { value: "own", textContent: "Your order" }), h("option", null, { value: "az", textContent: "A-Z" }));
    sortSel.value = GM_getValue("sort", "own") === "az" ? "az" : "own";
    sortSel.addEventListener("change", () => {
      GM_setValue("sort", sortSel.value);
      host.render();
    });
    let removed = null, undoTimer = 0;
    const undoText = h("span", `${font}flex:1 1 auto;color:${c.fg};`);
    undoText.setAttribute("aria-live", "polite");
    const undoBtn = h("button", btnCss + "flex:0 0 auto;padding:3px 10px;", { type: "button", textContent: "Undo" });
    const undoBar = h("div", `display:none;align-items:center;gap:10px;margin-top:8px;padding:6px 8px 6px 12px;border:1px solid ${c.edge};border-radius:6px;`, null, undoText, undoBtn);
    undoBtn.addEventListener("click", () => {
      clearTimeout(undoTimer);
      undoBar.style.display = "none";
      if (!removed || entries.some((e) => e.term.toLowerCase() === removed.entry.term.toLowerCase())) return;
      const next = entries.slice();
      next.splice(Math.min(removed.index, next.length), 0, removed.entry);
      added = new Set([removed.entry.term.toLowerCase()]);
      removed = null;
      save(next);
    });
    const rulesList = h("ul", "list-style:none;margin:0;padding:0;");
    const rulesBox = h("div", "margin-top:10px;", null, h("p", `${font}margin:0 0 2px;font-weight:600;color:${c.fg};`, { textContent: "Site rules" }), rulesList);
    const headRow = h("div", "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:16px 0 2px;", null, heading,
      h("label", `${font}display:flex;align-items:center;gap:6px;color:${c.muted};cursor:pointer;`, null, "Sort", sortSel));
    // Move an entry before or after another one, then keep focus on its grip for the next arrow press.
    let focusGrip = null;
    function moveEntry(term, target, after) {
      if (term === target) return;
      const row = entries.find((e) => e.term === term);
      const next = entries.filter((e) => e.term !== term);
      next.splice(next.findIndex((e) => e.term === target) + (after ? 1 : 0), 0, row);
      focusGrip = term;
      save(next);
    }
    // Neighbour in the same group, so arrows never jump between Emails and Names.
    function stepEntry(grip, dir) {
      const li = grip.closest("li");
      const other = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
      if (other) moveEntry(li.term, other.term, dir > 0);
    }
    const list = h("div");
    const filterIn = h("input", fieldCss + "flex:1 1 auto;min-width:0;", { id: "hme-filter", type: "search", autocomplete: "off", spellcheck: false });
    const filterRow = h("div", "display:flex;align-items:center;gap:8px;margin-top:8px;", null,
      h("label", `${font}flex:0 0 auto;color:${c.muted};`, { htmlFor: "hme-filter", textContent: "Filter" }), filterIn);
    filterIn.addEventListener("input", () => host.render());
    // Remembered across pages so a long list stays folded.
    const folded = GM_getValue("folded", {});
    const isMail = (term) => /@\S/.test(term);
    const reveal = h("input", `margin:1px 0 0;width:16px;height:16px;flex:0 0 auto;accent-color:${c.fg};`, { type: "checkbox" });
    const toggleCss = `${font}display:flex;align-items:flex-start;padding:3px 0;box-sizing:border-box;gap:8px;min-height:24px;margin-top:6px;color:${c.fg};cursor:pointer;`;
    const boxCss = `margin:1px 0 0;width:16px;height:16px;flex:0 0 auto;accent-color:${c.fg};`;
    const toggle = (type, text, onChange, props) => {
      const input = h("input", boxCss, { type, ...props });
      input.addEventListener("change", onChange);
      return [input, h("label", toggleCss, { className: "row" }, input, text)];
    };
    // Default follows "Pause everywhere"; Always ignores it; Never stops hiding here.
    const countText = h("span", "flex:0 0 auto;margin-left:auto;font-variant-numeric:tabular-nums;");
    // Each row counts how often its entry or image is hidden here. Hovering the row (or focusing the count) outlines
    // where on the page; clicking the count scrolls to the next one.
    const badges = new Map(); // entry term or image -> its count button, rebuilt on every render
    const cycle = new Map(); // entry term or image -> index of the one scrolled to last
    let hitsNow = new Map();
    const marks = h("div", "position:fixed;inset:0;pointer-events:none;");
    let whereKey = null;
    const rectsOf = (at) => {
      const node = at.startContainer || at;
      if ((node.ownerDocument || node) !== document) return []; // inside a frame: other coordinates
      if (at.nodeType === 3) {
        const r = document.createRange();
        r.selectNodeContents(at);
        return [...r.getClientRects()];
      }
      return at.nodeType === 1 ? [at.getBoundingClientRect()] : [...at.getClientRects()];
    };
    function drawWhere() {
      const boxes = [];
      for (const at of (whereKey !== null && hitsNow.get(whereKey)) || [])
        for (const r of rectsOf(at))
          if (r.width && r.height && boxes.length < 200)
            boxes.push(h("div", `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;outline:2px solid #e8a33d;border-radius:3px;`));
      marks.replaceChildren(...boxes);
    }
    const showWhere = (key) => {
      whereKey = key;
      drawWhere();
    };
    const followWhere = () => whereKey !== null && drawWhere();
    window.addEventListener("scroll", followWhere, { capture: true, passive: true });
    host.count = () => {
      hitsNow = onPage();
      let n = 0;
      for (const list of hitsNow.values()) n += list.length;
      countText.textContent = `${n} hidden here`;
      for (const [key, b] of badges) {
        const k = hitsNow.get(key)?.length || 0;
        b.hidden = !k;
        b.textContent = `×${k}`;
        b.setAttribute("aria-label", `Hidden ${k} ${k === 1 ? "time" : "times"} on this page, show it`);
      }
      drawWhere();
    };
    const badge = (key) => {
      const b = h("button", btnCss + `flex:0 0 auto;min-height:24px;padding:0 8px;border-radius:999px;border-color:${c.line};color:${c.muted};font-size:12px;font-variant-numeric:tabular-nums;`, { type: "button", hidden: true, title: "Show on the page" });
      b.addEventListener("focus", () => showWhere(key));
      b.addEventListener("blur", () => showWhere(null));
      b.addEventListener("click", () => {
        host.count();
        const list = (hitsNow.get(key) || []).filter((at) => rectsOf(at).length);
        if (!list.length) return;
        const i = ((cycle.get(key) ?? -1) + 1) % list.length;
        cycle.set(key, i);
        const at = list[i];
        const el = at.nodeType === 1 ? at : (at.startContainer || at).parentElement;
        el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        showWhere(key);
      });
      badges.set(key, b);
      return b;
    };
    const hoverRow = (li, key) => {
      li.addEventListener("mouseenter", () => showWhere(key));
      li.addEventListener("mouseleave", () => showWhere(root.activeElement === badges.get(key) ? key : null));
      return li;
    };
    const segs = [["default", "Default"], ["always", "Always hide"], ["never", "Never hide"]].map(([mode, text]) => {
      const input = h("input", null, { type: "radio", name: "hme-site", value: mode, className: "sr" });
      input.addEventListener("change", () => setSettings(modeFor(mode)));
      const face = h("span", `${font}display:block;padding:3px 10px;border-radius:5px;white-space:nowrap;`, { textContent: text });
      return [input, face, h("label", "display:block;cursor:pointer;flex:1 1 auto;text-align:center;", { className: "seg" }, input, face)];
    });
    const siteRow = h(
      "fieldset",
      "all:unset;display:block;",
      null,
      h("legend", `${font}display:flex;gap:8px;padding:0;margin:0 0 4px;color:${c.muted};width:100%;`, null,
        h("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;", { textContent: `On ${topHost}`, title: topHost }),
        countText,
      ),
      h("div", `display:flex;gap:2px;padding:2px;border:1px solid ${c.edge};border-radius:7px;`, null, ...segs.map(([, , l]) => l)),
    );
    const [allBox, allRow] = toggle("checkbox", "Pause everywhere", () => setSettings({ paused: allBox.checked }));
    const pausedTag = h("span", `${font}flex:0 0 auto;padding:0 7px;border:1px solid ${c.danger};border-radius:999px;font-size:12px;font-weight:600;color:${c.danger};`, { textContent: "Paused", title: "Reload pages to unhide text" });
    const [fieldsBox, fieldsRow] = toggle("checkbox", "Cover fields and editors", () => setSettings({ fields: fieldsBox.checked }));
    const [peekBox, peekRow] = toggle("checkbox", "Click a cover to peek", () => setSettings({ peek: peekBox.checked }));
    const [holdBox, holdRow] = toggle("checkbox", "Hold pages blank until checked", () => setSettings({ hold: holdBox.checked }));
    const [partialBox, partialRow] = toggle("checkbox", "Keep first letter and domain (m•••@gmail.com)", () => host.render());
    const [boxRadio, boxRow] = toggle("radio", "Grey box", () => setSettings({ style: "box" }), { name: "hme-style" });
    const [blurRadio, blurRow] = toggle("radio", "Blur (weaker)", () => setSettings({ style: "blur" }), { name: "hme-style" });
    for (const row of [boxRow, blurRow]) row.style.marginTop = "0";
    const styleGroup = h(
      "fieldset",
      "all:unset;display:flex;flex-wrap:wrap;align-items:center;gap:0 18px;margin-top:6px;",
      null,
      h("legend", `${font}float:left;padding:0;margin:0 4px 0 0;color:${c.fg};`, { textContent: "Cover with" }),
      boxRow,
      blurRow,
    );
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
      badges.clear();
      maskTerm();
      for (const [input, face] of segs) {
        input.checked = input.value === siteMode();
        face.style.background = input.checked ? c.fg : "transparent";
        face.style.color = input.checked ? c.bg : c.fg;
      }
      allRow.classList.toggle("dim", siteMode() !== "default"); // Always and Never ignore it here
      allBox.checked = settings.paused;
      pausedTag.hidden = active();
      fieldsBox.checked = settings.fields;
      boxRadio.checked = settings.style === "box";
      blurRadio.checked = settings.style === "blur";
      peekBox.checked = settings.peek;
      holdBox.checked = settings.hold;
      boxRadio.disabled = blurRadio.disabled = peekBox.disabled = !settings.fields;
      peekRow.classList.toggle("dim", !settings.fields);
      settingsBox.open = folded.settings === false; // folded until you open it once
      styleGroup.classList.toggle("dim", !settings.fields);
      const editing = editIndex();
      if (editing < 0) editTerm = null;
      hideBtn.textContent = editing < 0 ? "Hide" : "Save";
      aliasIn.placeholder = freeLabel("hidden", entries.map((e) => e.alias));
      heading.textContent = `Hidden (${entries.length + images.length})`;
      headRow.style.display = entries.length || images.length ? "flex" : "none";
      const rules = [...settings.always.map((x) => [x, "always", "Always hide"]), ...settings.sites.map((x) => [x, "never", "Never hide"])];
      rulesBox.style.display = rules.length ? "block" : "none";
      rulesList.replaceChildren(
        ...rules.map(([site, mode, text]) => {
          const del = h("button", btnCss + "flex:0 0 auto;", { type: "button" });
          face(del, "Remove");
          del.setAttribute("aria-label", `Remove the rule for ${site}`);
          del.addEventListener("click", () => setSettings(mode === "always" ? { always: settings.always.filter((x) => x !== site) } : { sites: settings.sites.filter((x) => x !== site) }));
          return h(
            "li",
            `display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid ${c.line};`,
            null,
            h("span", `${font}flex:1 1 auto;min-width:0;color:${c.fg};overflow-wrap:anywhere;`, { textContent: site }),
            h("span", `${font}flex:0 0 auto;color:${c.muted};`, { textContent: text }),
            del,
          );
        }),
      );
      aliasIn.disabled = partialBox.checked;
      aliasIn.style.opacity = partialBox.checked ? ".55" : "";
      filterRow.style.display = entries.length ? "flex" : "none";
      revealRow.style.display = entries.length ? "flex" : "none"; // inline display beats the hidden attribute
      const q = filterIn.value.trim().toLowerCase();
      const own = sortSel.value === "own" && !q; // reordering only makes sense in your own, unfiltered order
      const gripCss = btnCss + "flex:0 0 auto;min-width:24px;min-height:24px;padding:0 4px;border-color:transparent;color:" + c.muted + ";cursor:grab;touch-action:none;line-height:1;";
      const grip = (e) => {
        if (!own) return "";
        const g = h("button", gripCss, { type: "button", className: "grip", textContent: "⠿", term: e.term });
        g.setAttribute("aria-label", `Move ${e.alias}, use the arrow keys`);
        g.addEventListener("pointerdown", (d) => {
          if (d.button !== 0) return;
          const li = g.closest("li");
          g.setPointerCapture(d.pointerId);
          const y0 = d.clientY;
          li.style.position = "relative";
          li.style.zIndex = "1";
          li.style.background = c.bg;
          const move = (m) => (li.style.transform = `translateY(${m.clientY - y0}px)`); // follows the pointer 1:1
          const up = (u) => {
            g.removeEventListener("pointermove", move);
            g.removeEventListener("pointerup", up);
            g.removeEventListener("pointercancel", up);
            li.style.transform = li.style.position = li.style.zIndex = li.style.background = "";
            if (u.type !== "pointerup" || Math.abs(u.clientY - y0) < 4) return;
            const others = [...li.parentNode.children].filter((x) => x !== li);
            const before = others.find((x) => { const r = x.getBoundingClientRect(); return u.clientY < r.top + r.height / 2; });
            if (before) moveEntry(li.term, before.term, false);
            else if (others.length) moveEntry(li.term, others[others.length - 1].term, true);
          };
          g.addEventListener("pointermove", move);
          g.addEventListener("pointerup", up);
          g.addEventListener("pointercancel", up);
        });
        return g;
      };
      const rows = entries.map((e, i) => {
        if (q && !e.alias.toLowerCase().includes(q) && !e.term.toLowerCase().includes(q)) return null;
        const rowBtn = btnCss + "flex:0 0 auto;min-width:5.4em;padding:3px 10px";
        // Two presses instead of confirm(): the first arms the button for 3 s, the second acts.
        const twoPress = (label, aria, armedColor, run) => {
          const btn = h("button", rowBtn, { type: "button" });
          face(btn, label);
          btn.setAttribute("aria-label", aria);
          let armed = 0;
          const disarm = () => {
            clearTimeout(armed);
            armed = 0;
            face(btn, label);
            btn.className = "";
            btn.setAttribute("aria-label", aria);
            btn.style.background = "transparent";
            btn.style.borderColor = c.edge;
            btn.style.color = c.fg;
          };
          btn.addEventListener("click", () => {
            if (armed) return run();
            face(btn, "Confirm");
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
          partialBox.checked = term !== null && e.partial === true;
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
        // One press: Undo brings it back for a few seconds.
        const remove = h("button", rowBtn, { type: "button" });
        face(remove, "Remove");
        remove.setAttribute("aria-label", `Remove ${e.alias}`);
        remove.addEventListener("click", () => {
          if (editing === i) {
            termIn.value = aliasIn.value = "";
            editTerm = null;
          }
          removed = { entry: e, index: i };
          save(entries.filter((_, k) => k !== i));
          clearTimeout(undoTimer);
          undoText.textContent = `Removed ${e.alias}.`;
          undoBar.style.display = "flex";
          undoBtn.focus();
          undoTimer = setTimeout(() => {
            if (root.activeElement === undoBtn) termIn.focus({ preventScroll: true }); // a hidden button would drop keyboard focus to the page
            undoBar.style.display = "none";
          }, 6000);
        });
        return hoverRow(h(
          "li",
          `display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 0;border-top:1px solid ${c.line};`,
          { term: e.term, className: added.has(e.term.toLowerCase()) ? "added" : "" },
          grip(e),
          h("span", `${font}flex:0 0 auto;max-width:45%;font-weight:600;color:${c.fg};overflow-wrap:anywhere;`, { textContent: e.partial ? partialOf(e.term).split("@")[0] : e.alias }),
          badge(e.term),
          h("span", `${font}flex:1 1 8em;min-width:0;color:${c.muted};overflow-wrap:anywhere;`, null, masked(e.term)),
          h("span", "display:flex;gap:10px;flex:0 0 auto;margin-left:auto;", null, edit, remove),
        ), e.term);
      });
      // While filtering every group is open, and that does not overwrite the saved folding.
      const foldable = (key, label, items) => {
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
      };
      const groups = [
        ["mail", "Emails", (e) => isMail(e.term)],
        ["other", "Names and other", (e) => !isMail(e.term)],
      ];
      list.replaceChildren(
        ...groups.map(([key, label, test]) => {
          const pairs = entries.map((e, i) => [e, rows[i]]).filter(([e, r]) => r && test(e));
          if (sortSel.value === "az") pairs.sort((a, b) => a[0].alias.localeCompare(b[0].alias, undefined, { numeric: true, sensitivity: "base" }));
          const items = pairs.map(([, r]) => r);
          if (!items.length) return "";
          return foldable(key, label, items);
        }),
      );
      added = new Set();
      if (focusGrip !== null) {
        [...root.querySelectorAll(".grip")].find((g) => g.term === focusGrip)?.focus();
        focusGrip = null;
      }
      const shownImages = images.filter((m) => !q || m.label.toLowerCase().includes(q) || m.url.toLowerCase().includes(q));
      if (shownImages.length) {
        const imgRows = shownImages.map((m) => {
          const del = h("button", btnCss + "flex:0 0 auto;", { type: "button" });
          face(del, "Remove");
          del.setAttribute("aria-label", `Remove ${m.label}`);
          const scopeSel = h("select", `${font}flex:0 0 auto;margin:0;padding:2px 6px;border:1px solid ${c.edge};border-radius:6px;background:${c.field};color:${c.fg};`, null,
            h("option", null, { value: "one", textContent: "This one only", disabled: !m.attr }),
            h("option", null, { value: "all", textContent: "All sizes on this site" }));
          scopeSel.value = m.scope;
          scopeSel.setAttribute("aria-label", `Hide ${m.label}`);
          scopeSel.addEventListener("change", () => {
            images = images.map((x) => (x === m ? { ...x, scope: scopeSel.value } : x));
            GM_setValue(IMAGES, images);
            updateImages();
            host.render();
          });
          del.addEventListener("click", () => {
            images = images.filter((x) => x !== m);
            GM_setValue(IMAGES, images);
            updateImages();
            host.render();
          });
          let file = m.url.slice(m.url.lastIndexOf("/") + 1) || m.url;
          try {
            file = decodeURIComponent(file);
          } catch {}
          return hoverRow(h(
            "li",
            `display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 0;border-top:1px solid ${c.line};`,
            null,
            // Images cannot be reordered; an empty slot the size of a grip keeps the labels lined up with the rows above.
            own ? Object.assign(h("span", gripCss + "visibility:hidden;", { textContent: "⠿" }), { ariaHidden: "true" }) : "",
            h("span", `${font}flex:0 0 auto;font-weight:600;color:${c.fg};`, { textContent: m.label }),
            badge(m),
            h("span", `${font}flex:1 1 10em;min-width:0;color:${c.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`, { textContent: `${m.site} · ${file}`, title: m.url }),
            h("span", "display:flex;gap:10px;flex:0 0 auto;margin-left:auto;", null,
              h("label", `${font}display:flex;align-items:center;gap:6px;color:${c.muted};cursor:pointer;`, null, "Hide", scopeSel), del),
          ), m);
        });
        list.append(foldable("img", "Images", imgRows));
      }
      if ((entries.length || images.length) && !rows.some(Boolean) && !shownImages.length) list.append(h("p", `${font}margin:0;padding:12px 0 4px;color:${c.muted};`, { textContent: "No matches. Clear the filter to see everything." }));
      if (!entries.length && !images.length) list.append(h("p", `${font}margin:0;padding:12px 0 4px;color:${c.muted};`, { textContent: "Nothing hidden yet. Add an email or name above, or pick an image." }));
      host.count();
    };

    function fail(message, field) {
      error.textContent = message;
      error.hidden = false;
      field.setAttribute("aria-invalid", "true");
      field.classList.remove("shake");
      void field.offsetWidth; // restart the shake on a repeated error
      field.classList.add("shake");
      field.focus();
    }

    function add() {
      const terms = termIn.value.split(/;+/).map((s) => s.trim()).filter(Boolean);
      if (!terms.length) return termIn.focus();
      if (terms.some((t) => t.length < MIN_LENGTH)) return fail(`Use at least ${MIN_LENGTH} characters.`, termIn);
      // While editing, the old row is dropped and the saved one goes back to its place.
      const editing = editIndex();
      const next = entries.filter((_, k) => k !== editing);
      for (const term of terms) {
        const alias = (terms.length === 1 && aliasIn.value.trim()) || freeLabel("hidden", next.map((e) => e.alias));
        upsert(next, { term, alias, partial: partialBox.checked });
      }
      if (editing >= 0 && terms.length === 1) {
        const [row] = next.splice(next.findIndex((e) => e.term.toLowerCase() === terms[0].toLowerCase()), 1);
        next.splice(Math.min(editing, next.length), 0, row);
      }
      if (hasLoop(next)) return partialBox.checked ? fail("The shown text contains a hidden word.", termIn) : fail("This label contains a hidden word. Pick another.", aliasIn);
      error.hidden = true;
      termIn.removeAttribute("aria-invalid");
      aliasIn.removeAttribute("aria-invalid");
      termIn.value = aliasIn.value = "";
      partialBox.checked = false;
      added = new Set(terms.map((t) => t.toLowerCase()));
      editTerm = null;
      save(next);
      termIn.focus();
    }

    let closing = false;
    host.close = (animate) => {
      if (closing) return;
      closing = true;
      window.removeEventListener("scroll", followWhere, true);
      const calm = matchMedia("(prefers-reduced-motion: reduce)").matches; // fade only, no scale
      if (!animate || !box.animate) host.remove();
      else box.animate(calm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.95)" }], { duration: 150, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }).finished.then(() => host.remove(), () => host.remove());
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
    host.onKey = (e) => {
      if (e.key === "Escape") host.close();
      else if (e.key === "Enter" && (root.activeElement === termIn || root.activeElement === aliasIn)) add();
      else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && root.activeElement?.classList.contains("grip")) {
        e.preventDefault();
        stepEntry(root.activeElement, e.key === "ArrowUp" ? -1 : 1);
      }
    };
    const pickBtn = h("button", btnCss + "margin-top:10px;", { type: "button", textContent: "Pick an image on the page" });
    pickBtn.addEventListener("click", () => {
      host.style.display = "none";
      error.hidden = true;
      // Each choice is saved at once and picking goes on; the reply shows in the picker's bar.
      const onPick = (picked) => {
        let u;
        try {
          u = new URL(picked.src, location.href);
        } catch {}
        if (!u || !/^https?:$/.test(u.protocol)) return "That image has no web address, so it cannot be hidden.";
        const url = u.origin + u.pathname;
        // Only this image by default; without its own address on the element only "all copies" can find it again.
        const one = picked.scope === "one" && picked.attr ? { scope: "one", attr: picked.attr, kind: picked.kind, site: topHost } : { scope: "all", site: topHost };
        if (images.some((m) => m.url === url && m.site === one.site && m.scope === one.scope && m.attr === one.attr)) return "Already hidden.";
        images = [...images, { url, label: freeLabel("image", images.map((m) => m.label)), ...one }];
        GM_setValue(IMAGES, images);
        updateImages();
        host.render();
        return "Hidden.";
      };
      host.endPick = pickImage(onPick, () => {
        host.endPick = null;
        host.style.display = "block";
        pickBtn.focus();
      });
    });
    const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const listed = (e, i) => [e || !i ? counted(e, "entry", "entries") : "", i ? counted(i, "image", "images") : ""].filter(Boolean).join(" and ");
    const exportBtn = h("button", btnCss, { type: "button", textContent: "Export list" });
    const importBtn = h("button", btnCss, { type: "button", textContent: "Import list" });
    const fileIn = h("input", null, { type: "file", accept: ".json,application/json", hidden: true });
    const status = h("p", hintCss, { role: "status" });

    // The file holds the hidden text unmasked, so it is only written when asked.
    exportBtn.addEventListener("click", () => {
      if (!entries.length && !images.length) return (status.textContent = "Nothing to export.");
      const url = URL.createObjectURL(new Blob([JSON.stringify({ entries, images }, null, 2)], { type: "application/json" }));
      const a = h("a", null, { href: url, download: "hide-my-info.json" });
      root.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Exported ${listed(entries.length, images.length)}. The file is not masked.`;
    });

    importBtn.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", async () => {
      const file = fileIn.files[0];
      fileIn.value = "";
      if (!file) return;
      // Older exports are a bare list of entries; newer ones also carry the picked images.
      let data = null;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return (status.textContent = "That file is not a Hide My Info export.");
      }
      const incoming = sanitize(Array.isArray(data) ? data : data?.entries);
      const newImages = readImages(data?.images).filter((x) => !images.some((m) => m.url === x.url && m.site === x.site && m.scope === x.scope && m.attr === x.attr));
      if (!incoming.length && !newImages.length) return (status.textContent = "Found no entries in that file.");
      const next = entries.slice();
      for (const e of incoming) upsert(next, e);
      if (hasLoop(next)) return (status.textContent = "Not imported: a label contains a hidden word.");
      if (newImages.length) {
        images = [...images, ...newImages];
        GM_setValue(IMAGES, images);
        updateImages();
      }
      added = new Set(incoming.map((e) => e.term.toLowerCase()));
      save(next);
      status.textContent = `Imported ${listed(incoming.length, newImages.length)}.`;
    });

    hideBtn.addEventListener("click", add);
    reveal.addEventListener("change", host.render);
    closeBtn.addEventListener("click", () => host.close(true));

    const revealRow = h("label", toggleCss, { className: "row" }, reveal, "Show hidden text");
    const settingsBox = h(
      "details",
      `border-top:1px solid ${c.line};`,
      null,
      h("summary", `${font}cursor:pointer;padding:8px 0 2px;font-weight:600;color:${c.fg};`, { textContent: "Settings" }),
      fieldsRow,
      styleGroup,
      peekRow,
      holdRow,
      rulesBox,
      h("div", "display:flex;gap:8px;margin-top:12px;", null, exportBtn, importBtn, fileIn),
      status,
    );
    settingsBox.addEventListener("toggle", () => {
      folded.settings = !settingsBox.open;
      GM_setValue("folded", folded);
    });
    const title = h("h2", `${font}margin:0;font-size:15px;font-weight:600;color:${c.fg};`, { id: "hme-title", textContent: "Hide My Info" });
    // Drag the header to move the panel. Not saved: it opens in the corner again next time.
    const header = h("div", "display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:grab;touch-action:none;", null, title, pausedTag, h("span", "flex:1 1 auto"), closeBtn);
    header.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest?.("button")) return;
      const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      header.setPointerCapture(e.pointerId);
      header.style.cursor = "grabbing";
      const move = (m) => {
        // Keep 40px of the panel on screen so it can always be grabbed back.
        host.style.left = `${Math.min(Math.max(m.clientX - dx, 40 - r.width), innerWidth - 40)}px`;
        host.style.top = `${Math.min(Math.max(m.clientY - dy, 0), innerHeight - 40)}px`;
        host.style.right = "auto";
      };
      const up = () => {
        header.style.cursor = "grab";
        header.removeEventListener("pointermove", move);
        header.removeEventListener("pointerup", up);
        header.removeEventListener("pointercancel", up);
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", up);
      header.addEventListener("pointercancel", up);
    });
    const box = h(
      "div",
      `${font}box-sizing:border-box;max-height:calc(100vh - 32px);overflow:auto;padding:14px 16px 16px;border:1px solid ${c.edge};border-radius:10px;background:${c.bg};color:${c.fg};box-shadow:0 8px 28px rgba(0,0,0,.3);position:relative;`, // position: paints above the outlines
      { role: "dialog", className: "panel" },
      header,
      siteRow,
      allRow,
      h("label", labelCss + `margin-top:12px;padding-top:12px;border-top:1px solid ${c.line};`, { htmlFor: "hme-term", textContent: "Hide this" }),
      termIn,
      h(
        "div",
        "display:flex;align-items:flex-end;gap:8px;margin-top:12px;",
        null,
        h("div", "flex:1 1 auto;min-width:0;", null, h("label", labelCss, { htmlFor: "hme-alias", textContent: "Show as" }), aliasIn),
        hideBtn,
      ),
      partialRow,
      pickBtn,
      error,
      headRow,
      undoBar,
      filterRow,
      revealRow,
      list,
      settingsBox,
    );
    box.setAttribute("aria-labelledby", "hme-title");
    root.append(marks, box);
    host.render();
    return { host, focus: () => termIn.focus() };
  }

  function togglePanel() {
    if (panel && panel.isConnected) return panel.endPick ? panel.endPick() : panel.close(); // hidden for picking: bring it back
    const built = buildPanel(document.activeElement);
    panel = built.host;
    document.documentElement.append(panel);
    built.focus();
  }

  // From the page, panel keystrokes come from the host element, not a field, so site shortcut handlers eat them.
  // Registered at document-start, this capture listener runs before any page script and stops them first.
  function guardPanel(e) {
    if (!panel || e.target !== panel || panel.style.display === "none") return; // hidden while picking: Escape belongs to the picker
    e.stopImmediatePropagation();
    if (e.type === "keydown") panel.onKey(e);
  }

  // Pick mode: the image under the pointer gets an outline; a click picks it, Escape cancels.
  function imageAt(x, y) {
    const seen = new Set();
    const look = (from) => {
      for (const el of from.elementsFromPoint(x, y)) {
        if (seen.has(el) || /^hide-my-info-/.test(el.localName)) continue;
        seen.add(el);
        if (el.shadowRoot && el.shadowRoot !== from) {
          const inner = look(el.shadowRoot);
          if (inner) return inner;
        }
        const found = imageOf(el);
        if (found) return found;
      }
      return null;
    };
    return look(document);
  }
  // The picture an element shows, as a pick candidate, or null.
  function imageOf(el) {
    if (el.localName === "img") return el.currentSrc || el.src ? { el, src: el.currentSrc || el.src, attr: el.getAttribute("src"), kind: "img" } : null;
    if (el.localName === "image") return el.href?.baseVal ? { el, src: el.href.baseVal, attr: el.getAttribute("href"), kind: "image" } : null;
    // A background picture counts only on a small element: a banner or the page itself would grey out whole sections.
    if (el === document.documentElement || el === document.body || /^hide-my-info-/.test(el.localName)) return null;
    const bg = (/url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage) || [])[1];
    const r = bg && el.getBoundingClientRect();
    return bg && r.width * r.height < (innerWidth * innerHeight) / 3 ? { el, src: bg, attr: (el.getAttribute("style") || "").includes(bg) ? bg : null, kind: "bg" } : null;
  }
  function pickImage(onPick, onEnd) {
    const o = overlayFor(document);
    const ring = document.createElement("div");
    ring.style.cssText = "position:absolute;display:none;outline:2px solid #e8a33d;outline-offset:2px;border-radius:2px;";
    // Hover, focus and press states; the buttons work without them if the page blocks the sheet.
    if (!o.pickCss) {
      o.pickCss = true;
      addSheet(o.root, `.pick{transition:transform 140ms ease-out,background-color 150ms ease,border-color 150ms ease,color 150ms ease}
        @media (hover:hover) and (pointer:fine){.pick:not(:disabled):not([data-on]):hover{background:#3a3a3a!important;border-color:#bdbdbd!important}}
        .pick:focus-visible{outline:2px solid #ececec;outline-offset:2px}
        .pick:not(:disabled):active{transform:scale(.97)}
        .pick:disabled{cursor:not-allowed!important}
        @media (pointer:coarse){.pick{min-height:44px!important}}
        @media (prefers-reduced-motion:reduce){.pick{transition-property:background-color,border-color,color}.pick:active{transform:none}}`);
    }
    const btnCss = "font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:6px 12px;min-height:32px;border:1px solid #787878;border-radius:6px;background:transparent;color:#ececec;cursor:pointer;";
    const tip = document.createElement("div");
    tip.style.cssText = "position:absolute;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:6px 6px 6px 14px;border-radius:8px;background:#1f1f1f;color:#ececec;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:auto;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;";
    const tipText = document.createElement("span");
    tipText.style.cssText = "flex:1 1 auto;min-width:0;";
    const hint = "Click an image, or pick one with the arrow keys and Enter.";
    tipText.textContent = hint;
    tipText.setAttribute("role", "status");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "pick";
    cancelBtn.textContent = "Cancel";
    cancelBtn.title = "Esc";
    cancelBtn.style.cssText = btnCss + "flex:0 0 auto;";
    cancelBtn.addEventListener("click", finish);
    tip.append(tipText, cancelBtn);
    // After a click, two buttons next to the image ask which copies to hide.
    const chooser = document.createElement("div");
    chooser.style.cssText = "position:absolute;display:none;gap:6px;padding:6px;border-radius:8px;background:#1f1f1f;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto;";
    chooser.setAttribute("role", "group");
    chooser.setAttribute("aria-label", "Hide which copies of this image");
    const choice = (text, scope) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = "pick";
      b.style.cssText = btnCss;
      b.addEventListener("click", () => {
        const reply = onPick({ ...cand, scope });
        // Back to picking: the bar says what happened, Esc or Done ends it.
        preview(null);
        asking = false;
        cand = null;
        chooser.style.display = "none";
        delete chooser.dataset.shown;
        ring.style.display = "none";
        tipText.textContent = `${reply} Pick another image.`;
        cancelBtn.textContent = "Done";
        cancelBtn.focus({ preventScroll: true }); // the button just clicked is gone, keep keyboard users in the bar
      });
      // Hover or focus shows the result on the page before anything is saved.
      b.addEventListener("mouseenter", () => preview(scope));
      b.addEventListener("focus", () => preview(scope));
      b.dataset.scope = scope;
      b.addEventListener("mouseleave", () => preview(o.root.activeElement?.dataset.scope || null)); // back to the focused button, if any
      b.addEventListener("blur", () => setTimeout(() => preview(o.root.activeElement?.dataset.scope || null)));
      return b;
    };
    const oneBtn = choice("This one only", "one");
    const allBtn = choice("All sizes on this site", "all");
    chooser.append(oneBtn, allBtn);
    o.root.append(ring, tip, chooser);
    let cand = null, asking = false;
    let previewed = []; // [element, property, its own value, its own priority], put back when the preview ends
    function preview(scope) {
      for (const [el, k, v, p] of previewed) v ? el.style.setProperty(k, v, p) : el.style.removeProperty(k);
      previewed = [];
      // The button whose result is on the page right now stays lit.
      for (const b of [oneBtn, allBtn]) {
        const on = b.dataset.scope === scope;
        b.toggleAttribute("data-on", on);
        b.style.background = on ? "#ececec" : "transparent";
        b.style.borderColor = on ? "#ececec" : "#787878";
        b.style.color = on ? "#1f1f1f" : "#ececec";
      }
      if (!scope || !cand) return;
      let els = [cand.el];
      if (scope === "all") {
        const u = new URL(cand.src, location.href);
        const sel = selectorsFor({ url: u.origin + u.pathname, scope }).join(",");
        els = [...roots].flatMap((r) => (r.nodeType === 9 && !r.defaultView ? [] : [...r.querySelectorAll(sel)]));
        if (!els.includes(cand.el)) els.push(cand.el);
      }
      for (const el of els)
        for (const [k, v] of Object.entries(imageLook())) {
          previewed.push([el, k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
          el.style.setProperty(k, v, "important");
        }
    }
    // From the page the chooser's buttons show up as the overlay host (closed shadow root).
    const fromChooser = (e) => e.target === o.host;
    // Ring and buttons follow the image when the page scrolls or resizes.
    function place() {
      if (!cand || !cand.el.isConnected) return;
      const r = cand.el.getBoundingClientRect();
      ring.style.cssText += `display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
      if (!asking) return r;
      const w = chooser.offsetWidth, ht = chooser.offsetHeight;
      // Below the image when it fits, otherwise above it.
      const top = r.bottom + 8 + ht <= innerHeight ? r.bottom + 8 : Math.max(8, r.top - ht - 8);
      chooser.style.left = `${Math.min(Math.max(r.left, 8), innerWidth - w - 8)}px`;
      chooser.style.top = `${top}px`;
      chooser.style.transformOrigin = top > r.top ? "top left" : "bottom left";
      return r;
    }
    function stopAsking() {
      asking = false;
      preview(null);
      chooser.style.display = "none";
    }
    function ask(byKey) {
      asking = true;
      oneBtn.disabled = !cand.attr; // nothing on the element to tell this copy apart
      oneBtn.style.opacity = cand.attr ? "" : ".5";
      oneBtn.title = cand.attr ? "" : "This image has no address of its own";
      chooser.style.display = "flex";
      place();
      // Grows out of the image side it sits on, only the first time; moving to another image just jumps.
      // Opened with Enter it appears at once: keyboard actions do not animate.
      if (!byKey && !chooser.dataset.shown && chooser.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches)
        chooser.animate([{ opacity: 0, transform: "scale(.95)" }, { opacity: 1, transform: "none" }], { duration: 150, easing: "cubic-bezier(.22,1,.36,1)" });
      chooser.dataset.shown = "1";
      tipText.textContent = "Hide which copies?";
      (cand.attr ? oneBtn : allBtn).focus({ preventScroll: true });
      preview(cand.attr ? "one" : "all"); // focus does not fire again when the same button stays focused
    }
    const cursor = [document.documentElement.style.getPropertyValue("cursor"), document.documentElement.style.getPropertyPriority("cursor")];
    document.documentElement.style.setProperty("cursor", "crosshair", "important");
    const move = (e) => {
      if (asking) return; // the outline stays on the clicked image while the question is open
      if (fromChooser(e)) return; // over the tip's Cancel: keep the outline where it was
      cand = imageAt(e.clientX, e.clientY);
      if (!cand) return (ring.style.display = "none");
      place();
    };
    const follow = () => place();
    const block = (e) => {
      if (fromChooser(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const click = (e) => {
      if (fromChooser(e)) return;
      block(e);
      const next = imageAt(e.clientX, e.clientY);
      if (!next) return;
      cand = next; // a click on another image moves the question there
      ask();
    };
    // Keyboard picking: pictures in reading order, top to bottom. Reads every element's style, but only once per key press.
    const keyImages = () =>
      [...roots]
        .filter((r) => (r.host?.ownerDocument || r) === document) // frames use other coordinates
        .flatMap((r) => [...r.querySelectorAll("*")])
        .map((el) => [el, el.getBoundingClientRect()])
        .filter(([, r]) => r.width >= 8 && r.height >= 8)
        .map(([el, r]) => [imageOf(el), r])
        .filter(([found]) => found)
        .sort(([, a], [, b]) => a.top - b.top || a.left - b.left)
        .map(([found]) => found);
    function step(dir) {
      const list = keyImages();
      if (!list.length) return (tipText.textContent = "No images to pick with the keyboard here.");
      const i = list.findIndex((x) => x.el === cand?.el);
      const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
      stopAsking();
      o.root.activeElement?.blur(); // Enter now asks about the outlined image instead of pressing a bar button
      cand = next;
      next.el.scrollIntoView({ block: "nearest" });
      place();
      tipText.textContent = "Enter hides the outlined image.";
    }
    const key = (e) => {
      if (/^Arrow/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        block(e);
        return step(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
      }
      if (fromChooser(e) && (e.key === "Enter" || e.key === " " || e.key === "Tab")) return e.stopImmediatePropagation(); // keep site shortcuts off the buttons
      if ((e.key === "Enter" || e.key === " ") && cand && !asking && cand.el.isConnected && ring.style.display !== "none") {
        block(e);
        return ask(true);
      }
      if (e.key !== "Escape") return;
      block(e);
      // Esc closes the innermost thing: the question first, then picking.
      if (!asking) return finish();
      stopAsking();
      o.root.activeElement?.blur();
      tipText.textContent = hint;
    };
    const swallow = ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"];
    function finish() {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      for (const t of swallow) window.removeEventListener(t, block, true);
      preview(null);
      ring.remove();
      tip.remove();
      chooser.remove();
      if (cursor[0]) document.documentElement.style.setProperty("cursor", ...cursor);
      else document.documentElement.style.removeProperty("cursor");
      onEnd();
    }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    for (const t of swallow) window.addEventListener(t, block, true);
    return finish;
  }

  function toast(text) {
    const old = document.querySelector("hide-my-info-toast");
    if (old) old.remove();
    const t = document.createElement("hide-my-info-toast");
    t.style.cssText = "all:initial;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;";
    const box = h("div", "font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px 14px;border-radius:8px;background:#1f1f1f;color:#ececec;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity 150ms ease-out;", { textContent: text });
    box.setAttribute("role", "status");
    t.attachShadow({ mode: "closed" }).append(box);
    document.documentElement.append(t);
    setTimeout(() => (box.style.opacity = "0"), 2200);
    setTimeout(() => t.remove(), 2400);
  }
  // Alt+Shift+H: stop or start hiding on this site, without opening the panel. Before the panel guard, so it works there too.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyH" || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const off = siteMode() !== "never";
      setSettings(modeFor(off ? "never" : "default"));
      toast(active() ? `Hiding on ${topHost}` : `Not hiding on ${topHost}`); // Default can still be paused everywhere
    },
    true,
  );

  if (window.top === window) {
    for (const type of ["keydown", "keypress", "keyup", "focusin", "focusout"]) window.addEventListener(type, guardPanel, true);
    GM_registerMenuCommand("Edit hidden info", togglePanel);
  }
})();
