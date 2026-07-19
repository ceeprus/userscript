// ==UserScript==
// @name         Steam Guide: Live Side Preview
// @namespace    https://github.com/ceeprus/userscript
// @version      1.04
// @description  Docks a live rendered preview to the right of the guide section editor, updating as you type. Reuses Steam's own bb_* styles and never touches the Edit/Preview/Changes tabs or the form fields.
// @author       ceeprus
// @match        https://steamcommunity.com/sharedfiles/editguidesubsection/*
// @match        https://steamcommunity.com/sharedfiles/editguide/*
// @icon         https://steamcommunity.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @homepageURL  https://github.com/ceeprus/userscript
// @supportURL   https://github.com/ceeprus/userscript/issues
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/guide-preview.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/guide-preview.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- GM shims (work across managers) -----------------------------------
  var store = {
    get: function (k, d) { try { return GM_getValue(k, d); } catch (e) { var v = localStorage.getItem('gp_' + k); return v === null ? d : JSON.parse(v); } },
    set: function (k, v) { try { GM_setValue(k, v); } catch (e) { localStorage.setItem('gp_' + k, JSON.stringify(v)); } }
  };
  function addStyle(css) {
    try { GM_addStyle(css); }
    catch (e) { var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
  }

  // ========================================================================
  //  BBCode -> HTML renderer (models Steam's guide output; validated against
  //  a real guide's source/preview pair). Pure, no DOM deps.
  // ========================================================================
  var BB = (function () {
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    var RAW_TAGS = { code: 1, noparse: 1 };
    var KNOWN = { b:1,i:1,u:1,s:1,strike:1,spoiler:1,url:1,img:1,previewimg:1,h1:1,h2:1,h3:1,quote:1,code:1,noparse:1,hr:1,list:1,olist:1,table:1,tr:1,th:1,td:1 };

    function tokenize(src) {
      var toks = [], re = /\[(\/?)([a-z0-9]+)(=[^\]]*)?\]|\[\*\]/gi, last = 0, m;
      while ((m = re.exec(src)) !== null) {
        if (m.index > last) toks.push({ t: 'text', v: src.slice(last, m.index) });
        if (m[0] === '[*]') toks.push({ t: 'star' });
        else toks.push({ t: m[1] ? 'close' : 'open', name: m[2].toLowerCase(), arg: m[3] ? m[3].slice(1) : null, rawTag: m[0] });
        last = re.lastIndex;
      }
      if (last < src.length) toks.push({ t: 'text', v: src.slice(last) });
      return toks;
    }

    function textToHtml(v) { return esc(v).replace(/\r\n?|\n/g, '<br>'); }

    function autoLink(htmlText) {
      return htmlText.replace(/(https?:\/\/[^\s<]+)|(\bwww\.[^\s<]+)|(\b[a-z0-9-]+\.(?:com|net|org|io|gg|tv)\/[^\s<]+)/gi, function (url) {
        var href = /^https?:\/\//i.test(url) ? url : 'http://' + url;
        return '<a class="bb_link" href="' + href + '" target="_blank" rel="noopener">' + url + '</a>';
      });
    }

    function resolvePreviewImg(arg, imgResolver) {
      var parts = arg.split(';');
      var id = (parts[0] || '').trim();
      var flags = (parts[1] || '').toLowerCase();
      var float = /floatleft/.test(flags) ? 'left' : /floatright/.test(flags) ? 'right' : '';
      var url = imgResolver ? imgResolver(id) : null;
      var style = 'max-width:220px;max-height:220px;border-radius:2px;margin:4px;';
      if (float) style += 'float:' + float + ';';
      if (url) return '<a class="bb_link" href="' + esc(url) + '" target="_blank" rel="noopener"><img src="' + esc(url) + '" style="' + style + '"></a>';
      return '<span class="gp-img-chip" title="preview image #' + esc(id) + '"' + (float ? ' style="float:' + float + '"' : '') + '>&#128247; image #' + esc(id) + '</span>';
    }

    function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

    function wrap(name, arg, inner) {
      switch (name) {
        case 'b': return '<b>' + inner + '</b>';
        case 'i': return '<i>' + inner + '</i>';
        case 'u': return '<u>' + inner + '</u>';
        case 's': case 'strike': return '<strike>' + inner + '</strike>';
        case 'spoiler': return '<span class="bb_spoiler"><span>' + inner + '</span></span>';
        case 'h1': return '<div class="bb_h1">' + inner + '</div>';
        case 'h2': return '<div class="bb_h2">' + inner + '</div>';
        case 'h3': return '<div class="bb_h3">' + inner + '</div>';
        case 'quote': {
          var who = arg ? '<div class="bb_quoteauthor">' + esc(arg) + ' posted:</div>' : '';
          return '<blockquote class="bb_blockquote">' + who + inner + '</blockquote>';
        }
        case 'url': {
          var href = arg || stripTags(inner);
          if (!/^[a-z]+:\/\//i.test(href) && !/^\//.test(href)) href = 'http://' + href;
          return '<a class="bb_link" href="' + esc(href) + '" target="_blank" rel="noopener">' + inner + '</a>';
        }
        case 'img': return '<img class="bb_img" src="' + esc(stripTags(inner)) + '" style="max-width:100%;">';
        default: return inner;
      }
    }

    function parse(toks, i, opts) {
      var out = '', guard = 0;
      for (; i.p < toks.length;) {
        if (++guard > toks.length * 4 + 100) break;
        var tk = toks[i.p];
        if (tk.t === 'text') { out += autoLink(textToHtml(tk.v)); i.p++; continue; }
        if (tk.t === 'star') { i.p++; continue; }
        if (tk.t === 'close') return out; // bubble up
        var name = tk.name;
        if (!KNOWN[name]) { out += esc(tk.rawTag); i.p++; continue; }
        i.p++;
        if (RAW_TAGS[name]) { out += pullRawBody(toks, i, name); continue; }
        if (name === 'hr') { if (toks[i.p] && toks[i.p].t === 'close' && toks[i.p].name === 'hr') i.p++; out += '<hr class="bb_hr">'; continue; }
        if (name === 'previewimg') { consumeTo(toks, i, 'previewimg'); out += resolvePreviewImg(tk.arg || '', opts.imgResolver); continue; }
        if (name === 'list' || name === 'olist') { out += parseList(toks, i, name, opts); continue; }
        if (name === 'table') { out += parseTable(toks, i, opts); continue; }
        var inner = parseUntilClose(toks, i, name, opts);
        out += wrap(name, tk.arg, inner);
      }
      return out;
    }

    function parseUntilClose(toks, i, name, opts) {
      var sub = parse(toks, i, opts);
      if (toks[i.p] && toks[i.p].t === 'close' && toks[i.p].name === name) i.p++;
      return sub;
    }
    function consumeTo(toks, i, name) { // skip anything until this close (previewimg body)
      var g = 0;
      while (i.p < toks.length && !(toks[i.p].t === 'close' && toks[i.p].name === name)) { if (++g > toks.length) break; i.p++; }
      if (i.p < toks.length) i.p++;
    }
    function pullRawBody(toks, i, name) {
      var buf = '', g = 0;
      while (i.p < toks.length && !(toks[i.p].t === 'close' && toks[i.p].name === name)) {
        if (++g > toks.length) break;
        var t2 = toks[i.p];
        buf += t2.t === 'text' ? t2.v : (t2.t === 'star' ? '[*]' : t2.rawTag);
        i.p++;
      }
      if (i.p < toks.length) i.p++;
      var html = esc(buf).replace(/\r\n?|\n/g, '<br>');
      return name === 'code' ? '<div class="bb_code">' + html + '</div>' : html;
    }

    function parseList(toks, i, name, opts) {
      var tag = name === 'olist' ? 'ol' : 'ul', cls = name === 'olist' ? 'bb_ol' : 'bb_ul';
      var items = [], cur = null, pre = '', g = 0;
      function flush() { if (cur !== null) items.push('<li>' + cur + '</li>'); }
      while (i.p < toks.length) {
        if (++g > toks.length * 4 + 100) break;
        var tk = toks[i.p];
        if (tk.t === 'close' && (tk.name === name || tk.name === 'list' || tk.name === 'olist')) { i.p++; break; }
        if (tk.t === 'star') { flush(); cur = ''; i.p++; continue; }
        var chunk;
        if (tk.t === 'text') { chunk = autoLink(textToHtml(tk.v)); i.p++; }
        else if (tk.t === 'open') {
          if (!KNOWN[tk.name]) { chunk = esc(tk.rawTag); i.p++; }
          else {
            var nm = tk.name; i.p++;
            if (nm === 'list' || nm === 'olist') chunk = parseList(toks, i, nm, opts);
            else if (nm === 'table') chunk = parseTable(toks, i, opts);
            else if (RAW_TAGS[nm]) chunk = pullRawBody(toks, i, nm);
            else if (nm === 'previewimg') { consumeTo(toks, i, 'previewimg'); chunk = resolvePreviewImg(tk.arg || '', opts.imgResolver); }
            else if (nm === 'hr') { if (toks[i.p] && toks[i.p].t === 'close' && toks[i.p].name === 'hr') i.p++; chunk = '<hr class="bb_hr">'; }
            else chunk = wrap(nm, tk.arg, parseUntilClose(toks, i, nm, opts));
          }
        } else { i.p++; continue; }
        if (cur === null) pre += chunk; else cur += chunk;
      }
      flush();
      return (pre ? pre : '') + '<' + tag + ' class="' + cls + '">' + items.join('') + '</' + tag + '>';
    }

    function parseTable(toks, i, opts) {
      var rows = '', g = 0;
      while (i.p < toks.length) {
        if (++g > toks.length * 4 + 100) break;
        var tk = toks[i.p];
        if (tk.t === 'close' && tk.name === 'table') { i.p++; break; }
        if (tk.t === 'open' && tk.name === 'tr') {
          i.p++; var cells = '', g2 = 0;
          while (i.p < toks.length) {
            if (++g2 > toks.length * 4 + 100) break;
            var c = toks[i.p];
            if (c.t === 'close' && c.name === 'tr') { i.p++; break; }
            if (c.t === 'open' && (c.name === 'th' || c.name === 'td')) {
              var cell = c.name; i.p++;
              cells += '<' + cell + '>' + parseUntilClose(toks, i, cell, opts).replace(/^(<br>)+|(<br>)+$/g, '') + '</' + cell + '>';
            } else i.p++;
          }
          rows += '<tr>' + cells + '</tr>';
        } else i.p++;
      }
      return '<table class="bb_table">' + rows + '</table>';
    }

    return {
      render: function (bbcode, opts) {
        var toks = tokenize(bbcode || ''), i = { p: 0 }, out = '', guard = 0;
        // Loop so a stray/unmatched close tag at top level renders as literal
        // text instead of truncating everything after it.
        while (i.p < toks.length && ++guard < toks.length + 10) {
          var before = i.p;
          out += parse(toks, i, opts || {});
          if (i.p < toks.length && toks[i.p].t === 'close') { out += esc(toks[i.p].rawTag); i.p++; }
          if (i.p === before) break;
        }
        return out;
      }
    };
  })();

  // ========================================================================
  //  UI
  // ========================================================================
  var K_W = 'panelWidth', K_COLLAPSED = 'collapsed', K_REVEAL = 'reveal';
  var MIN_W = 280, MAX_W = 900, DEFAULT_W = 440;

  function q(id) { return document.getElementById(id); }

  function buildImgResolver() {
    // Map preview-image element ids -> usable CDN url, read live from the DOM.
    var panel = q('PreviewImages');
    var map = {};
    if (panel) {
      panel.querySelectorAll('img[id]').forEach(function (img) {
        var src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        if (src && src.indexOf('data:') !== 0) map[img.id] = src;
      });
    }
    return function (id) { return map[id] || null; };
  }

  var panel, body, renderTarget, titleTarget, charCount, collapsedTab, lastValue = null, lastTitle = null;

  function css() {
    addStyle([
      '.gp-panel{position:fixed;top:0;right:0;height:100vh;z-index:99998;display:flex;flex-direction:column;',
      '  background:#1b2838;border-left:1px solid #000;box-shadow:-6px 0 22px rgba(0,0,0,.55);',
      '  font-family:"Motiva Sans",Arial,Helvetica,sans-serif;color:#c6d4df;text-align:left;transition:transform .15s ease;}',
      '.gp-panel.gp-hidden{display:none;}',
      '.gp-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 10px;',
      '  background:linear-gradient(90deg,#2a475e,#1b2838);border-bottom:1px solid #000;}',
      '.gp-title{font-size:12px;font-weight:700;letter-spacing:.03em;color:#67c1f5;text-transform:uppercase;white-space:nowrap;}',
      '.gp-count{margin-left:auto;font-size:11px;color:#8f98a0;white-space:nowrap;}',
      '.gp-count.gp-over{color:#e8734f;font-weight:700;}',
      '.gp-btn{cursor:pointer;font-size:11px;line-height:1;padding:4px 7px;border-radius:2px;border:1px solid #000;',
      '  background:#3a4b5c;color:#c6d4df;user-select:none;white-space:nowrap;}',
      '.gp-btn:hover{background:#4b6178;color:#fff;}',
      '.gp-btn.gp-on{background:#5c7e10;color:#d2e885;}',
      '.gp-body{flex:1 1 auto;overflow:auto;padding:16px 18px;}',
      '.gp-body .subSectionTitle{font-size:22px;color:#e1e7ea;font-weight:300;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #32404e;}',
      '.gp-grip{position:absolute;top:0;left:-3px;width:7px;height:100%;cursor:col-resize;z-index:2;}',
      '.gp-grip:hover{background:rgba(103,193,245,.25);}',
      '.gp-tab{position:fixed;top:120px;right:0;z-index:99998;background:#2a475e;color:#67c1f5;border:1px solid #000;border-right:none;',
      '  border-radius:3px 0 0 3px;padding:10px 6px;cursor:pointer;writing-mode:vertical-rl;font-size:11px;font-weight:700;',
      '  letter-spacing:.08em;text-transform:uppercase;box-shadow:-3px 0 10px rgba(0,0,0,.4);user-select:none;}',
      '.gp-tab:hover{background:#356189;color:#fff;}',
      '.gp-img-chip{display:inline-block;padding:2px 8px;margin:4px;border:1px dashed #4b5b6b;border-radius:3px;color:#8f98a0;font-size:11px;}',
      // reveal-spoilers override: Steam hides the inner span via visibility, so flip that (not just colors)
      '.gp-panel.gp-reveal .bb_spoiler{color:#c6d4df !important;background-color:#39566e !important;}',
      '.gp-panel.gp-reveal .bb_spoiler>span{visibility:visible !important;}',
      '.gp-empty{color:#66707b;font-style:italic;font-size:13px;}'
    ].join('\n'));
  }

  function build() {
    css();

    panel = document.createElement('div');
    panel.className = 'gp-panel';
    if (store.get(K_REVEAL, false)) panel.classList.add('gp-reveal');

    var grip = document.createElement('div'); grip.className = 'gp-grip';

    var head = document.createElement('div'); head.className = 'gp-head';
    var t = document.createElement('span'); t.className = 'gp-title'; t.textContent = 'Live Preview';
    charCount = document.createElement('span'); charCount.className = 'gp-count';

    var revealBtn = document.createElement('span'); revealBtn.className = 'gp-btn';
    function revealLabel(on) { revealBtn.textContent = on ? 'spoiler \u25BE' : 'spoiler \u25B8'; } // ▾ open / ▸ closed
    var revealOn = store.get(K_REVEAL, false);
    revealLabel(revealOn);
    if (revealOn) revealBtn.classList.add('gp-on');
    revealBtn.title = 'Reveal spoiler contents in this preview';
    revealBtn.onclick = function () {
      var on = panel.classList.toggle('gp-reveal');
      revealBtn.classList.toggle('gp-on', on);
      revealLabel(on);
      store.set(K_REVEAL, on);
    };

    head.appendChild(t);
    head.appendChild(charCount);
    head.appendChild(revealBtn);

    body = document.createElement('div'); body.className = 'gp-body';
    // Steam guide wrapper so bb_* classes inherit the real guide styling.
    var wrap = document.createElement('div'); wrap.className = 'guide';
    var subs = document.createElement('div'); subs.className = 'subSections';
    titleTarget = document.createElement('div'); titleTarget.className = 'subSectionTitle';
    renderTarget = document.createElement('div'); renderTarget.className = 'subSectionDesc gp-render';
    subs.appendChild(titleTarget); subs.appendChild(renderTarget); wrap.appendChild(subs); body.appendChild(wrap);

    panel.appendChild(grip);
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    collapsedTab = document.createElement('div');
    collapsedTab.className = 'gp-tab gp-hidden';
    collapsedTab.textContent = 'Preview';
    collapsedTab.title = 'Show/hide live preview (Alt+P)';
    collapsedTab.onclick = function () { setCollapsed(!panel.classList.contains('gp-hidden')); };
    document.body.appendChild(collapsedTab);

    setWidth(store.get(K_W, DEFAULT_W));
    wireResize(grip);
    if (store.get(K_COLLAPSED, false)) setCollapsed(true, true);
    positionTab();
  }

  function setWidth(w) {
    w = Math.max(MIN_W, Math.min(MAX_W, w | 0));
    panel.style.width = w + 'px';
    return w;
  }

  function wireResize(grip) {
    var dragging = false;
    grip.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; });
    window.addEventListener('mousemove', function (e) { if (dragging) { setWidth(window.innerWidth - e.clientX); positionTab(); } });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      store.set(K_W, parseInt(panel.style.width, 10) || DEFAULT_W);
    });
  }

  var editorVisible = true; // gets corrected by observer
  // Toggle handle sits at the panel's left edge when open, at the screen edge when
  // collapsed, so one control both hides and shows the panel.
  function positionTab() {
    if (!collapsedTab) return;
    var collapsed = panel.classList.contains('gp-hidden');
    collapsedTab.style.right = collapsed ? '0px' : (panel.style.width || (DEFAULT_W + 'px'));
  }
  function setCollapsed(on, skipSave) {
    panel.classList.toggle('gp-hidden', on);
    positionTab();
    if (!skipSave) store.set(K_COLLAPSED, on);
  }

  // ---- render ------------------------------------------------------------
  var desc, titleInput;
  function doRender() {
    if (!desc) return;
    var val = desc.value;
    var tv = titleInput ? titleInput.value : '';
    if (val === lastValue && tv === lastTitle) return;
    lastValue = val; lastTitle = tv;

    titleTarget.textContent = tv || '';
    titleTarget.style.display = tv ? '' : 'none';

    if (!val.trim()) {
      renderTarget.innerHTML = '<div class="gp-empty">Nothing to preview yet \u2014 start typing in the editor.</div>';
    } else {
      renderTarget.innerHTML = BB.render(val, { imgResolver: buildImgResolver() });
    }

    var n = val.length;
    charCount.textContent = n + ' / 8000';
    charCount.classList.toggle('gp-over', n > 8000);
  }

  var rTimer = null;
  function scheduleRender() { clearTimeout(rTimer); rTimer = setTimeout(doRender, 120); }

  // ---- editor-tab visibility --------------------------------------------
  function editorPaneVisible() {
    var ep = q('EditorPane');
    if (!ep) return true;
    return getComputedStyle(ep).display !== 'none';
  }

  function syncVisibility() {
    editorVisible = editorPaneVisible();
    if (!editorVisible) {
      // On Preview/Changes tabs: hide our overlay + handle (Steam shows its own).
      panel.classList.add('gp-hidden');
      collapsedTab.classList.add('gp-hidden');
    } else {
      // Back on the Edit tab: show the toggle handle, restore the chosen state.
      collapsedTab.classList.remove('gp-hidden');
      setCollapsed(store.get(K_COLLAPSED, false), true);
      scheduleRender();
    }
  }

  function watchTabs() {
    ['EditorPane', 'PreviewPane', 'ChangesPane'].forEach(function (id) {
      var el = q(id);
      if (el) new MutationObserver(syncVisibility).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    ['EditorTab', 'PreviewTab', 'ChangesTab'].forEach(function (id) {
      var el = q(id);
      if (el) el.addEventListener('click', function () { setTimeout(syncVisibility, 30); });
    });
  }

  // ---- init --------------------------------------------------------------
  function init() {
    if (panel) return true; // already built
    desc = q('description');
    titleInput = q('title');
    if (!desc || !q('EditorPane')) return false; // not the section editor

    build();

    ['input', 'keyup', 'paste', 'cut'].forEach(function (ev) { desc.addEventListener(ev, scheduleRender); });
    if (titleInput) ['input', 'keyup'].forEach(function (ev) { titleInput.addEventListener(ev, scheduleRender); });

    // Toolbar buttons write into the textarea without firing 'input' in some
    // managers/browsers; a light poll guarantees those inserts show up too.
    setInterval(function () { if (desc.value !== lastValue) scheduleRender(); }, 600);

    watchTabs();

    document.addEventListener('keydown', function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
        if (!editorVisible) return;
        e.preventDefault();
        setCollapsed(!panel.classList.contains('gp-hidden'));
      }
    });

    syncVisibility();
    doRender();
    return true;
  }

  // The editor is server-rendered, but be defensive about timing.
  if (!init()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (init() || ++tries > 40) clearInterval(iv);
    }, 250);
  }
})();
