// ==UserScript==
// @name         FFXIV Language redirect
// @namespace    FFXIV redirect
// @version      1.1
// @description  Redirect any FFXIV website (DE, FR, EU, JP, etc.) to the NA version
// @author       ceeprus
// @match        https://*.finalfantasyxiv.com/*
// @icon         https://www.finalfantasyxiv.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/ffxiv/ffxiv-redirect.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/ffxiv/ffxiv-redirect.user.js
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Only these regional subdomains hop to NA. Everything else stays put:
    // na itself, the apex domain (rewriting it to itself reload-looped),
    // and non-regional hosts like store./forum./img.
    const REGIONAL = new Set(['de', 'fr', 'eu', 'jp']);

    const currentHost = window.location.hostname;
    const sub = currentHost.split('.')[0];

    if (currentHost === 'finalfantasyxiv.com' || !REGIONAL.has(sub)) return;

    const newHost = 'na.' + currentHost.slice(sub.length + 1);

    window.location.replace(window.location.href.replace(currentHost, newHost));
})();
