// ==UserScript==
// @name         FFXIV Language redirect
// @namespace    FFXIV redirect
// @version      1.0
// @description  Redirect any FFXIV website (DE, FR, EU, JP, etc.) to the NA version
// @author       ceeprus
// @match        https://*.finalfantasyxiv.com/*
// @icon         https://www.finalfantasyxiv.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/ffxiv/ffxiv-redirect.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/ffxiv/ffxiv-redirect.user.js
// @license MIT 
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const currentHost = window.location.hostname;

    if (currentHost.startsWith('na.')) return;

    const newHost = currentHost.replace(/^[^.]+\.finalfantasyxiv\.com/, 'na.finalfantasyxiv.com');

    const newUrl = window.location.href.replace(currentHost, newHost);

    window.location.replace(newUrl);
})();
