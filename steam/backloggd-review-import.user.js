// ==UserScript==
// @name         Steam Curator: Import Review Link from Backloggd
// @namespace    https://github.com/ceeprus
// @version      2.3
// @description  Adds a searchable "Import from Backloggd" box next to the "URL for full review (Optional)" field on Steam Curator review-edit pages, letting you pick one of your Backloggd reviews, auto-fill the link, and optionally import the review text into "Write your review". Prompts for your Backloggd username on first use.
// @author       Cee
// @match        https://store.steampowered.com/curator/*/admin/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      backloggd.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/backloggd-review-import.user.js
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/backloggd-review-import.user.js
// ==/UserScript==

(function () {
    'use strict';

    const USERNAME_KEY = 'backloggd_username';
    const CACHE_KEY_PREFIX = 'bglg_reviews_cache_';
    const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
    const MAX_RESULTS_SHOWN = 8;
    // Bump this whenever the shape of cached review items changes, so old
    // caches (missing newer fields like `text`) are automatically refetched.
    const CACHE_SCHEMA_VERSION = 2;

    const STYLE_ID = 'bglg-import-style';

    // Returns the saved Backloggd username, prompting the user to set one if
    // this is the first time the script has run (or it was never configured).
    function getUsername(promptIfMissing) {
        let username = GM_getValue(USERNAME_KEY, '').trim();
        if (!username && promptIfMissing) {
            username = promptForUsername();
        }
        return username || null;
    }

    function promptForUsername() {
        const input = window.prompt(
            'Enter your Backloggd username (the part after backloggd.com/u/ in your profile URL):'
        );
        const trimmed = (input || '').trim();
        if (trimmed) {
            GM_setValue(USERNAME_KEY, trimmed);
            return trimmed;
        }
        return '';
    }

    function changeUsername() {
        const current = GM_getValue(USERNAME_KEY, '');
        const input = window.prompt(
            'Enter your Backloggd username (the part after backloggd.com/u/ in your profile URL):',
            current
        );
        if (input === null) return;
        const trimmed = input.trim();
        if (!trimmed) return;
        GM_setValue(USERNAME_KEY, trimmed);
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Set/change Backloggd username', changeUsername);
    }

    function cacheKey(username) {
        return CACHE_KEY_PREFIX + username.toLowerCase();
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .bglg-import-container {
                position: relative;
                display: inline-block;
                margin-left: 10px;
                vertical-align: middle;
                font-family: inherit;
            }
            .bglg-import-toggle {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                border: 1px solid #2a475e;
                border-radius: 4px;
                background: #16202d;
                color: #67c1f5;
                font-size: 12px;
                text-decoration: none;
                cursor: pointer;
                transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            .bglg-import-toggle:hover {
                background: #2a475e;
                border-color: #67c1f5;
                color: #fff;
            }
            .bglg-import-toggle-icon {
                width: 16px;
                height: 16px;
                border-radius: 2px;
                flex-shrink: 0;
            }
            .bglg-import-panel {
                position: absolute;
                top: 100%;
                left: 0;
                z-index: 1000;
                margin-top: 4px;
                width: 340px;
                max-height: 340px;
                overflow-y: auto;
                background: #1b2838;
                border: 1px solid #2a475e;
                border-radius: 4px;
                padding: 8px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
                font-size: 12px;
                color: #c6d4df;
            }
            .bglg-import-search {
                width: 100%;
                box-sizing: border-box;
                padding: 6px 8px;
                margin-bottom: 6px;
                background: #0f1923;
                border: 1px solid #2a475e;
                color: #c6d4df;
                border-radius: 3px;
                font-size: 12px;
            }
            .bglg-import-search:focus {
                outline: none;
                border-color: #67c1f5;
            }
            .bglg-import-status {
                margin-bottom: 6px;
                opacity: 0.7;
            }
            .bglg-import-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 6px;
                border-radius: 3px;
                cursor: pointer;
            }
            .bglg-import-item-cover {
                flex: 0 0 32px;
                width: 32px;
                height: 45px;
                object-fit: cover;
                border-radius: 2px;
                background: #0f1923;
            }
            .bglg-import-item-cover-placeholder {
                border: 1px solid #2a475e;
            }
            .bglg-import-item-text {
                flex: 1 1 auto;
                min-width: 0;
            }
            .bglg-import-item-title {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .bglg-import-item-date {
                font-size: 11px;
                opacity: 0.6;
                margin-top: 1px;
            }
            .bglg-import-item:hover {
                background: #2a475e;
                color: #fff;
            }
            .bglg-import-empty {
                padding: 5px 6px;
                opacity: 0.6;
            }
            .bglg-import-bottom-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 6px;
            }
            .bglg-import-refresh,
            .bglg-import-loadmore {
                color: #67c1f5;
                font-size: 11px;
                text-decoration: none;
            }
            .bglg-import-refresh:hover,
            .bglg-import-loadmore:hover {
                color: #fff;
                text-decoration: underline;
            }
            .bglg-import-arrow {
                display: inline-block;
                font-size: 10px;
            }
            .bglg-import-blurb-prompt {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                margin-top: 6px;
                padding: 4px 10px;
                border: 1px solid #2a475e;
                border-radius: 4px;
                background: #16202d;
                color: #c6d4df;
                font-size: 12px;
            }
            .bglg-import-blurb-prompt a {
                color: #67c1f5;
                text-decoration: none;
                cursor: pointer;
            }
            .bglg-import-blurb-prompt a:hover {
                color: #fff;
                text-decoration: underline;
            }
        `;
        document.head.appendChild(style);
    }

    // Walk up from the "open review" link to find the related game's title.
    function findGameTitle(reviewLink) {
        const card = reviewLink.closest('.review-card');
        if (card) {
            let sib = card.previousElementSibling;
            while (sib) {
                if (sib.classList && sib.classList.contains('game-name')) {
                    const h3 = sib.querySelector('h3');
                    if (h3 && h3.textContent.trim()) return h3.textContent.trim();
                }
                sib = sib.previousElementSibling;
            }

            // Fallback: cover image alt text within the card
            const img = card.querySelector('img[alt]');
            if (img && img.alt && img.alt.trim()) return img.alt.trim();
        }

        // Last-resort generic fallback
        let el = reviewLink;
        for (let i = 0; i < 6 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const img = el.querySelector('img[alt]');
            if (img && img.alt && img.alt.trim()) return img.alt.trim();
        }
        return null;
    }

    // Find the review date (e.g. "Jun 12, 2026") from the card's <time> element.
    function findReviewDate(reviewLink) {
        const card = reviewLink.closest('.review-card');
        if (!card) return null;
        const time = card.querySelector('time');
        if (!time) return null;
        return (time.getAttribute('aria-label') || time.textContent || '').trim() || null;
    }

    // Find the full review text from the card's review body.
    function findReviewText(reviewLink) {
        const card = reviewLink.closest('.review-card');
        if (!card) return null;
        const textEl = card.querySelector('.card-text');
        if (!textEl) return null;
        const text = textEl.textContent.replace(/\s+/g, ' ').trim();
        return text || null;
    }

    // Find the game cover image URL from the card.
    function findGameImage(reviewLink) {
        const card = reviewLink.closest('.review-card');
        if (!card) return null;

        const img = card.querySelector('.game-cover img, img[alt]');
        if (!img) return null;

        const candidates = [
            img.getAttribute('src'),
            img.getAttribute('data-src'),
            img.getAttribute('data-srcset'),
            img.getAttribute('srcset'),
        ];

        for (const candidate of candidates) {
            if (!candidate) continue;
            // srcset-style values may contain "url size, url size" - take the first URL
            const firstUrl = candidate.split(',')[0].trim().split(/\s+/)[0];
            if (!firstUrl || firstUrl.startsWith('data:')) continue;
            try {
                return new URL(firstUrl, 'https://backloggd.com').href;
            } catch (e) {
                continue;
            }
        }

        return null;
    }

    function fetchPage(username, page) {
        return new Promise((resolve, reject) => {
            const url = `https://backloggd.com/u/${username}/reviews/?page=${page}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload(resp) {
                    if (resp.status === 403) {
                        if (typeof GM_openInTab === 'function') {
                            GM_openInTab(`https://backloggd.com/u/${username}/`, { active: true });
                        }
                        reject(new Error('Blocked (403) — opened your Backloggd profile in a new tab, complete any check there and refresh.'));
                        return;
                    }
                    if (resp.status < 200 || resp.status >= 300) {
                        reject(new Error(`HTTP ${resp.status}`));
                        return;
                    }
                    resolve(resp.responseText);
                },
                onerror() {
                    reject(new Error('Network error'));
                },
            });
        });
    }

    // Fetches one page of reviews and returns its items plus whether a next page exists.
    async function fetchReviewsPage(username, page) {
        const html = await fetchPage(username, page);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const links = doc.querySelectorAll('a.open-review-link');

        const items = [];
        const seen = new Set();
        links.forEach((link) => {
            const href = link.getAttribute('href');
            if (!href) return;
            const fullUrl = new URL(href, 'https://backloggd.com').href;
            if (seen.has(fullUrl)) return;
            seen.add(fullUrl);

            items.push({
                title: findGameTitle(link) || fullUrl,
                date: findReviewDate(link),
                image: findGameImage(link),
                text: findReviewText(link),
                url: fullUrl,
            });
        });

        const nextLink = doc.querySelector('a[aria-label="Next"]');
        const hasMore = !!(nextLink && nextLink.getAttribute('href'));

        return { items, hasMore };
    }

    function getCache(username) {
        return GM_getValue(cacheKey(username), null);
    }

    function saveCache(username, data, nextPage, hasMore) {
        GM_setValue(cacheKey(username), {
            timestamp: Date.now(),
            schemaVersion: CACHE_SCHEMA_VERSION,
            data,
            nextPage,
            hasMore,
        });
    }

    function enhanceInput(input) {
        if (input.dataset.bglgImportAdded) return;
        input.dataset.bglgImportAdded = 'true';

        const container = document.createElement('span');
        container.className = 'bglg-import-container';

        const toggleBtn = document.createElement('a');
        toggleBtn.href = '#';
        toggleBtn.className = 'bglg-import-toggle';

        const toggleIcon = document.createElement('img');
        toggleIcon.className = 'bglg-import-toggle-icon';
        toggleIcon.src = 'https://www.google.com/s2/favicons?sz=32&domain=backloggd.com';
        toggleIcon.alt = '';

        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = 'Import from Backloggd';

        toggleBtn.appendChild(toggleIcon);
        toggleBtn.appendChild(toggleLabel);

        const panel = document.createElement('div');
        panel.className = 'bglg-import-panel';
        panel.style.display = 'none';

        const searchBox = document.createElement('input');
        searchBox.type = 'text';
        searchBox.className = 'bglg-import-search';
        searchBox.placeholder = 'Type to search your reviews…';

        const status = document.createElement('div');
        status.className = 'bglg-import-status';

        const resultsEl = document.createElement('div');
        resultsEl.className = 'bglg-import-results';

        const bottomRow = document.createElement('div');
        bottomRow.className = 'bglg-import-bottom-row';

        const refreshBtn = document.createElement('a');
        refreshBtn.href = '#';
        refreshBtn.className = 'bglg-import-refresh';
        refreshBtn.textContent = '↻ refresh list';

        const loadMoreBtn = document.createElement('a');
        loadMoreBtn.href = '#';
        loadMoreBtn.className = 'bglg-import-loadmore';
        loadMoreBtn.innerHTML = 'Load more <span class="bglg-import-arrow">▾</span>';
        loadMoreBtn.style.display = 'none';

        bottomRow.appendChild(refreshBtn);
        bottomRow.appendChild(loadMoreBtn);

        panel.appendChild(searchBox);
        panel.appendChild(status);
        panel.appendChild(resultsEl);
        panel.appendChild(bottomRow);

        container.appendChild(toggleBtn);
        container.appendChild(panel);

        input.insertAdjacentElement('afterend', container);

        // Locate the "Write your review" textarea and its character counter,
        // so we can offer to fill it in alongside the link.
        const form = input.closest('form');
        const blurbTextarea = form ? form.querySelector('textarea[name="blurb"]') : null;
        const reviewLenEl = form ? form.querySelector('#review_len') : null;

        let pendingBlurbText = null;
        let blurbPrompt = null;
        let blurbPromptLabel = null;

        if (blurbTextarea) {
            blurbPrompt = document.createElement('div');
            blurbPrompt.className = 'bglg-import-blurb-prompt';
            blurbPrompt.style.display = 'none';

            blurbPromptLabel = document.createElement('span');
            blurbPromptLabel.textContent = 'Add review text?';

            const yesBtn = document.createElement('a');
            yesBtn.href = '#';
            yesBtn.className = 'bglg-import-blurb-yes';
            yesBtn.textContent = 'Yes';

            const noBtn = document.createElement('a');
            noBtn.href = '#';
            noBtn.className = 'bglg-import-blurb-no';
            noBtn.textContent = 'No';

            blurbPrompt.appendChild(blurbPromptLabel);
            blurbPrompt.appendChild(yesBtn);
            blurbPrompt.appendChild(noBtn);

            const anchor = reviewLenEl || blurbTextarea;
            anchor.insertAdjacentElement('afterend', blurbPrompt);

            yesBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (pendingBlurbText) {
                    const maxLen = parseInt(blurbTextarea.getAttribute('maxlength'), 10) || pendingBlurbText.length;
                    blurbTextarea.value = pendingBlurbText.slice(0, maxLen);
                    blurbTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                    blurbTextarea.dispatchEvent(new Event('change', { bubbles: true }));
                    blurbTextarea.dispatchEvent(new Event('keyup', { bubbles: true }));
                    if (reviewLenEl) {
                        const remaining = maxLen - blurbTextarea.value.length;
                        reviewLenEl.textContent = `${remaining} characters remaining`;
                    }
                }
                blurbPrompt.style.display = 'none';
            });

            noBtn.addEventListener('click', (e) => {
                e.preventDefault();
                blurbPrompt.style.display = 'none';
            });
        }

        function offerBlurbText(text) {
            if (!blurbPrompt) return;
            if (!text) {
                blurbPrompt.style.display = 'none';
                return;
            }
            pendingBlurbText = text;
            const maxLen = parseInt(blurbTextarea.getAttribute('maxlength'), 10) || text.length;
            blurbPromptLabel.textContent = text.length > maxLen
                ? `Add review text? (trimmed to ${maxLen} chars)`
                : 'Add review text?';
            blurbPrompt.style.display = '';
        }

        let allReviews = null;
        let loading = false;
        let loadingMore = false;
        let displayLimit = MAX_RESULTS_SHOWN;
        let nextPage = 1;
        let hasMore = false;

        function renderResults(query) {
            resultsEl.innerHTML = '';
            if (!allReviews) return;

            const q = query.trim().toLowerCase();
            const allMatches = q
                ? allReviews.filter((r) => r.title.toLowerCase().includes(q))
                : allReviews;
            const matches = allMatches.slice(0, displayLimit);

            const moreToShowLocally = allMatches.length > matches.length;
            loadMoreBtn.style.display = (moreToShowLocally || hasMore) ? '' : 'none';

            if (matches.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'bglg-import-empty';
                empty.textContent = 'No matches';
                resultsEl.appendChild(empty);
                return;
            }

            matches.forEach((r) => {
                const item = document.createElement('div');
                item.className = 'bglg-import-item';
                item.title = r.url;

                if (r.image) {
                    const img = document.createElement('img');
                    img.className = 'bglg-import-item-cover';
                    img.src = r.image;
                    img.alt = '';
                    img.loading = 'lazy';
                    item.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'bglg-import-item-cover bglg-import-item-cover-placeholder';
                    item.appendChild(placeholder);
                }

                const textWrap = document.createElement('div');
                textWrap.className = 'bglg-import-item-text';

                const titleEl = document.createElement('div');
                titleEl.className = 'bglg-import-item-title';
                titleEl.textContent = r.title;
                textWrap.appendChild(titleEl);

                if (r.date) {
                    const dateEl = document.createElement('div');
                    dateEl.className = 'bglg-import-item-date';
                    dateEl.textContent = r.date;
                    textWrap.appendChild(dateEl);
                }

                item.appendChild(textWrap);

                item.addEventListener('click', () => {
                    input.value = r.url;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    panel.style.display = 'none';
                    offerBlurbText(r.text);
                });
                resultsEl.appendChild(item);
            });
        }

        function load(force) {
            const username = getUsername(true);
            if (!username) {
                status.textContent = 'No Backloggd username set. Click "Import from Backloggd" again to enter one.';
                resultsEl.innerHTML = '';
                loadMoreBtn.style.display = 'none';
                return;
            }

            loading = true;
            status.textContent = 'Loading your reviews…';
            resultsEl.innerHTML = '';
            displayLimit = MAX_RESULTS_SHOWN;

            const cached = !force ? getCache(username) : null;
            const useCache = cached
                && Array.isArray(cached.data)
                && typeof cached.nextPage === 'number'
                && cached.schemaVersion === CACHE_SCHEMA_VERSION
                && Date.now() - cached.timestamp < CACHE_TTL_MS;

            const ready = useCache
                ? Promise.resolve(cached)
                : fetchReviewsPage(username, 1).then(({ items, hasMore: more }) => {
                    const cacheObj = { timestamp: Date.now(), schemaVersion: CACHE_SCHEMA_VERSION, data: items, nextPage: 2, hasMore: more };
                    saveCache(username, cacheObj.data, cacheObj.nextPage, cacheObj.hasMore);
                    return cacheObj;
                });

            ready
                .then((cacheObj) => {
                    allReviews = cacheObj.data;
                    nextPage = cacheObj.nextPage;
                    hasMore = cacheObj.hasMore;
                    status.textContent = `${allReviews.length} review${allReviews.length === 1 ? '' : 's'} loaded. Type to search.`;
                    renderResults(searchBox.value);
                })
                .catch((err) => {
                    status.textContent = `Failed to load reviews: ${err.message}`;
                })
                .finally(() => {
                    loading = false;
                });
        }

        function handleLoadMore() {
            const username = getUsername(false);
            if (!username) return;

            const q = searchBox.value.trim().toLowerCase();
            const allMatches = q
                ? allReviews.filter((r) => r.title.toLowerCase().includes(q))
                : allReviews;

            if (allMatches.length > displayLimit) {
                // More already-loaded matches can just be revealed.
                displayLimit += MAX_RESULTS_SHOWN;
                renderResults(searchBox.value);
                return;
            }

            if (!hasMore || loadingMore) return;

            loadingMore = true;
            loadMoreBtn.textContent = 'Loading…';

            fetchReviewsPage(username, nextPage)
                .then(({ items, hasMore: more }) => {
                    const existing = new Set(allReviews.map((r) => r.url));
                    items.forEach((item) => {
                        if (!existing.has(item.url)) {
                            allReviews.push(item);
                            existing.add(item.url);
                        }
                    });
                    nextPage += 1;
                    hasMore = more;
                    saveCache(username, allReviews, nextPage, hasMore);
                    displayLimit += MAX_RESULTS_SHOWN;
                    renderResults(searchBox.value);
                })
                .catch((err) => {
                    status.textContent = `Failed to load more: ${err.message}`;
                })
                .finally(() => {
                    loadingMore = false;
                    loadMoreBtn.innerHTML = 'Load more <span class="bglg-import-arrow">▾</span>';
                });
        }

        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const opening = panel.style.display === 'none';
            panel.style.display = opening ? 'block' : 'none';
            if (opening) {
                searchBox.focus();
                if (!allReviews && !loading) load(false);
            }
        });

        searchBox.addEventListener('input', () => {
            displayLimit = MAX_RESULTS_SHOWN;
            renderResults(searchBox.value);
        });

        loadMoreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleLoadMore();
        });

        refreshBtn.addEventListener('click', (e) => {
            e.preventDefault();
            allReviews = null;
            nextPage = 1;
            hasMore = false;
            displayLimit = MAX_RESULTS_SHOWN;
            load(true);
        });

        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                panel.style.display = 'none';
            }
        });
    }

    function scan() {
        document.querySelectorAll('input[name="link_url"]').forEach(enhanceInput);
    }

    function init() {
        injectStyles();
        scan();
    }

    init();

    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
})();
