// ==UserScript==
// @name         Scrap.TF - Hide Entered Raffles
// @namespace    https://github.com/ceeprus
// @version      1.1
// @description  Hide already-entered (darkened) raffles on scrap.tf raffle lists, with an eye toggle button next to Create Raffle
// @icon         https://www.google.com/s2/favicons?sz=64&domain=scrap.tf
// @author       Cee
// @match        https://scrap.tf/raffles
// @match        https://scrap.tf/raffles/*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/scraptf/scraptf-hide-entered.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/scraptf/scraptf-hide-entered.user.js
// ==/UserScript==

(function () {
  'use strict';

  var list = document.getElementById('raffles-list');
  if (!list) return; // not a raffle list page (e.g. an individual raffle)

  var KEY = 'stf-hide-entered';
  var hidden = localStorage.getItem(KEY) !== '0'; // default: hide entered

  var style = document.createElement('style');
  style.textContent =
    'body.stf-hide-entered .panel-raffle.raffle-entered{display:none!important}' +
    '#stf-eye-toggle{margin-right:8px;cursor:pointer}' +
    '#stf-eye-toggle.stf-floating{position:fixed;bottom:20px;right:20px;z-index:99999;margin:0}' +
    '#stf-eye-badge{display:inline-block;margin-left:5px;background:#e74c3c;color:#fff;' +
    'border-radius:9px;font-size:11px;line-height:16px;min-width:16px;padding:0 4px;' +
    'text-align:center;vertical-align:middle}';
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.id = 'stf-eye-toggle';
  btn.type = 'button';
  btn.className = 'btn btn-inverse btn-embossed';
  btn.innerHTML = '<i class="fa fa-fw"></i><span id="stf-eye-badge">0</span>';

  var newRaffle = document.querySelector('.new-raffle');
  if (newRaffle) {
    newRaffle.insertBefore(btn, newRaffle.firstChild); // left of Create Raffle
  } else {
    btn.classList.add('stf-floating'); // fallback: floating bottom-right
    document.body.appendChild(btn);
  }

  var icon = btn.querySelector('.fa');
  var badge = btn.querySelector('#stf-eye-badge');

  function render() {
    document.body.classList.toggle('stf-hide-entered', hidden);
    icon.className = 'fa fa-fw ' + (hidden ? 'fa-eye-slash' : 'fa-eye');
    var n = list.querySelectorAll('.panel-raffle.raffle-entered').length;
    badge.textContent = n;
    btn.title = hidden
      ? n + ' entered raffle(s) hidden — click to show'
      : n + ' entered raffle(s) shown — click to hide';
  }

  btn.addEventListener('click', function () {
    hidden = !hidden;
    localStorage.setItem(KEY, hidden ? '1' : '0');
    render();
  });

  // infinite scroll appends panels; entering a raffle can flip its class live
  new MutationObserver(render).observe(list, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  render();
})();
