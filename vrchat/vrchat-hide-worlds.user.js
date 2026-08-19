// ==UserScript==
// @name         VRChat: Hide Worlds
// @namespace    https://github.com/ceeprus/userscript
// @version      1.00
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vrchat.com
// @description  Hides worlds you never want to see again from the VRChat website, with an eye toggle button next to the friends list.
// @author       ceeprus
// @match        https://vrchat.com/home*
// @match        https://*.vrchat.com/home*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_registerMenuCommand
// @downloadURL https://raw.githubusercontent.com/ceeprus/userscript/main/vrchat/vrchat-hide-worlds.user.js
// @updateURL https://raw.githubusercontent.com/ceeprus/userscript/main/vrchat/vrchat-hide-worlds.user.js
// ==/UserScript==

// To submit bugs or submit revisions please see visit the repository at:
// https://github.com/ceeprus/userscript

const REGEX_WORLD_ID = /\/home\/world\/(wrld_[0-9a-f-]{36})/iu;
const WORLD_LINK_SELECTOR = 'a[href*="/home/world/wrld_"]';
const HEADING_SELECTOR = 'h1, h2, h3, h4';
const TITLE_HEADING_SELECTOR = 'h1, h2, h3';
// `:scope` binds only to the compound it sits in, so ':scope > h1, h2' would
// mean "direct-child h1, or ANY descendant h2". Scope every compound.
const CHILD_HEADING_SELECTOR = HEADING_SELECTOR.split(',')
	.map((tag) => `:scope > ${tag.trim()}`)
	.join(', ');
const STATES = ['normal', 'dimmed', 'hidden'];
const MAX_CLIMB = 10;

((_undefined) => {
	// Enable for debugging
	const DEBUG = false;

	const KEY_STATE = 'VRCWH_STATE';
	const KEY_HIDDEN = 'VRCWH_HIDDEN';

	const logDebug = (...msgs) => {
		if (DEBUG) console.debug('[VRC-WH]', msgs);
	};

	// Prefer GM storage, fall back to localStorage. Always strings so all
	// three backends round-trip identically.
	const stateGet = async (key, defaultValue) => {
		try {
			return GM_getValue(key, defaultValue);
		} catch (_) {
			/* fall through */
		}
		try {
			return await GM.getValue(key, defaultValue);
		} catch (_) {
			/* fall through */
		}
		return localStorage.getItem(key) ?? defaultValue;
	};
	const stateSet = async (key, value) => {
		try {
			GM_setValue(key, value);
			return;
		} catch (_) {
			/* fall through */
		}
		try {
			await GM.setValue(key, value);
			return;
		} catch (_) {
			/* fall through */
		}
		localStorage.setItem(key, value);
	};

	// GreaseMonkey no longer supports GM_addStyle. So we have to define
	// our own polyfill here
	const addStyle = (aCss) => {
		const head = document.getElementsByTagName('head')[0];
		if (head) {
			const style = document.createElement('style');
			style.setAttribute('type', 'text/css');
			style.textContent = aCss;
			head.appendChild(style);
			return style;
		}
		return null;
	};

	addStyle(`
.VRCWH-WORLD-HIDDEN { display: none !important }

.VRCWH-WORLD-DIMMED {
	opacity: .25;
	filter: grayscale(.85);
	transition: opacity .15s ease, filter .15s ease;
}

.VRCWH-WORLD-DIMMED:hover,
.VRCWH-WORLD-DIMMED:focus-within { opacity: .75 }

.VRCWH-WORLD-MARKED {
	outline: 2px dashed rgba(255, 122, 122, .75);
	outline-offset: 2px;
}

.VRCWH-ROW-EMPTY { display: none !important }

.VRCWH-CARD { position: relative }

.VRCWH-BTN {
	align-items: center;
	background: rgba(5, 25, 29, .85);
	border: 2px solid #053c48;
	border-radius: 100%;
	color: #fff;
	cursor: pointer;
	display: flex;
	height: 28px;
	justify-content: center;
	opacity: 0;
	padding: 0;
	/* Invisible must also mean untouchable, or a tap on the card corner
	   silently hides a world instead of opening it */
	pointer-events: none;
	position: absolute;
	right: 6px;
	top: 6px;
	transition: opacity .12s ease, transform .12s ease, background .12s ease;
	width: 28px;
	z-index: 20;
}

.VRCWH-CARD:hover .VRCWH-BTN,
.VRCWH-CARD:focus-within .VRCWH-BTN,
.VRCWH-BTN:focus { opacity: 1; pointer-events: auto }

/* No hover to reveal it on touch, so keep it out permanently. Scoped through
   .VRCWH-CARD to outrank the base rule on specificity, not just on order. */
@media (hover: none) {
	.VRCWH-CARD .VRCWH-BTN { opacity: .85; pointer-events: auto }
}

.VRCWH-BTN:hover { background: #07242b; transform: scale(1.12) }

.VRCWH-BTN:active { transform: scale(.92) }

.VRCWH-BTN.VRCWH-BTN-ON {
	background: rgba(74, 12, 12, .9);
	border-color: #8f2f2f;
	color: #ff9d9d;
	opacity: 1;
	pointer-events: auto;
}

.VRCWH-BTN svg { height: 15px; width: 15px }

.VRCWH-FAB {
	align-items: center;
	background: #07242b;
	border: 4px solid #053c48;
	border-radius: 100%;
	color: #fff;
	cursor: pointer;
	display: flex;
	height: 65px;
	justify-content: center;
	position: fixed;
	right: 100px;
	top: 70px;
	transition: .1s ease-in;
	width: 65px;
	z-index: 3;
}

.VRCWH-FAB:hover { background: #05191d; transform: scale(1.05) }

.VRCWH-FAB:active { background: #053c48; transform: scale(.95) }

.VRCWH-FAB svg { height: 28px; width: 28px }

.VRCWH-FAB.VRCWH-STATE-dimmed { border-color: #6b5a12; color: #ffd24a }

.VRCWH-FAB.VRCWH-STATE-hidden { border-color: #6b1f1f; color: #ff7a7a }

.VRCWH-FAB-COUNT {
	align-items: center;
	background: #053c48;
	border: 2px solid #07242b;
	border-radius: 100%;
	bottom: -4px;
	color: #fff;
	display: flex;
	font-size: 11px;
	font-weight: 700;
	height: 22px;
	justify-content: center;
	line-height: 1;
	min-width: 22px;
	padding: 0 3px;
	position: absolute;
	right: -4px;
}

.VRCWH-FAB-COUNT:empty { display: none }
`);

	const ICONS = {
		eye: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 9C14 9 5.46 15.22 2 24c3.46 8.78 12 15 22 15 10.01 0 18.54-6.22 22-15-3.46-8.78-11.99-15-22-15zm0 25c-5.52 0-10-4.48-10-10s4.48-10 10-10 10 4.48 10 10-4.48 10-10 10zm0-16c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/></svg>',
		eyeSlash:
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 14c5.52 0 10 4.48 10 10 0 1.29-.26 2.52-.71 3.65l5.85 5.85c3.02-2.52 5.4-5.78 6.87-9.5-3.47-8.78-12-15-22.01-15-2.8 0-5.48.5-7.97 1.4l4.32 4.31c1.13-.44 2.36-.71 3.65-.71zM4 8.55l4.56 4.56.91.91C6.17 16.6 3.56 20.03 2 24c3.46 8.78 12 15 22 15 3.1 0 6.06-.6 8.77-1.69l.85.85L39.45 44 42 41.46 6.55 6 4 8.55zM15.06 19.6l3.09 3.09c-.09.43-.15.86-.15 1.31 0 3.31 2.69 6 6 6 .45 0 .88-.06 1.3-.15l3.09 3.09C27.06 33.6 25.58 34 24 34c-5.52 0-10-4.48-10-10 0-1.58.4-3.06 1.06-4.4zm8.61-1.57 6.3 6.3L30 24c0-3.31-2.69-6-6-6l-.33.03z"/></svg>',
	};

	// ===========================================================

	// In-memory mirror of storage so the render path stays synchronous.
	// `hidden` maps world id -> world name, name is tooltip-only.
	let toggleState = 'normal';
	let hidden = {};

	const isHidden = (id) => Object.hasOwn(hidden, id);

	const persistHidden = () => stateSet(KEY_HIDDEN, JSON.stringify(hidden));

	const parseHidden = (raw) => {
		if (!raw) return {};
		try {
			const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
			if (!parsed || typeof parsed !== 'object') return {};
			// Tolerate the array shape an older build may have written
			if (Array.isArray(parsed)) {
				return Object.fromEntries(parsed.map((id) => [id, '']));
			}
			return parsed;
		} catch (error) {
			console.error('[VRC-WH]', error);
			return {};
		}
	};

	// ===========================================================

	const debounce = function (func, wait, immediate) {
		let timeout;
		return (...args) => {
			const later = () => {
				timeout = null;
				if (!immediate) func.apply(this, args);
			};
			const callNow = immediate && !timeout;
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
			if (callNow) func.apply(this, args);
		};
	};

	// Every DOM write goes through these, so a run that changes nothing emits
	// no mutation records and can't re-trigger the observer.
	const setClass = (el, className, on) => {
		if (on) {
			if (!el.classList.contains(className)) el.classList.add(className);
		} else if (el.classList.contains(className)) {
			el.classList.remove(className);
		}
	};

	const setText = (el, text) => {
		if (el.textContent !== text) el.textContent = text;
	};

	const setAttr = (el, name, value) => {
		if (el.getAttribute(name) !== value) el.setAttribute(name, value);
	};

	// Compared via a dataset flag, not innerHTML: the browser re-serialises
	// SVG, so an innerHTML compare would never match.
	const setIcon = (el, name) => {
		if (el.dataset.vrcwhIcon === name) return;
		el.dataset.vrcwhIcon = name;
		el.innerHTML = ICONS[name];
	};

	// ===========================================================

	const worldIdFrom = (href) => {
		const match = href && REGEX_WORLD_ID.exec(href);
		return match ? match[1] : null;
	};

	const linkWorldId = (anchor) =>
		worldIdFrom(anchor.getAttribute('href') || anchor.href);

	// Emotion class hashes (css-1w3pyrn, e3qzuk74, ...) change on every VRChat
	// deploy, so cards are found structurally: walk up from a world link until
	// a parent holds more than one distinct world.
	const resolveCard = (link, idCache) => {
		const distinctWorldIds = (el) => {
			let count = idCache.get(el);
			if (count !== undefined) return count;
			const seen = new Set();
			for (const anchor of el.querySelectorAll(WORLD_LINK_SELECTOR)) {
				const id = linkWorldId(anchor);
				if (id) seen.add(id);
			}
			count = seen.size;
			idCache.set(el, count);
			return count;
		};

		let node = link;
		for (let i = 0; i < MAX_CLIMB; i++) {
			const parent = node.parentElement;
			if (!parent || parent === document.body) return null;
			if (distinctWorldIds(parent) > 1) {
				// A section holding a single world lets the climb run past the
				// card and into the section itself, so check the container is
				// really a card list and the candidate is really a card. Cards
				// carry exactly one <h4> (the favourite count) and never a
				// title heading; sections and world pages have both.
				const siblingCards = [...parent.children].filter(
					(child) => distinctWorldIds(child) === 1,
				);
				if (siblingCards.length < 2) return null;
				if (node.querySelector(TITLE_HEADING_SELECTOR)) return null;
				if (node.querySelectorAll(HEADING_SELECTOR).length > 1) return null;
				return { card: node, container: parent };
			}
			node = parent;
		}
		// A single-world page never reaches a multi-world container
		return null;
	};

	// Identity of a card as a layout, ignoring our own classes. Cards in a
	// list all share one Emotion class string, so a signature learned from
	// the cards that did resolve identifies the ones that could not.
	const cardSignature = (el) => {
		const classes = [...el.classList]
			.filter((name) => !name.startsWith('VRCWH-'))
			.sort()
			.join(' ');
		return classes ? `${el.tagName}.${classes}` : null;
	};

	// Second chance for a link whose climb found no card list: a section
	// holding a single world has no sibling cards to compare against, so
	// match it against the signatures learned elsewhere on the page.
	const resolveCardBySignature = (link, idCache, signatures) => {
		if (signatures.size === 0) return null;

		let node = link.parentElement;
		for (let i = 0; i < MAX_CLIMB && node && node !== document.body; i++) {
			if (signatures.has(cardSignature(node)) && node.parentElement) {
				return { card: node, container: node.parentElement };
			}
			node = node.parentElement;
		}
		return null;
	};

	// Title is the first text in the card, ahead of the player count and
	// author. Read structurally to avoid depending on the title's class.
	const worldNameFrom = (card) => {
		const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.textContent.trim();
			if (text) return text.slice(0, 80);
		}
		return '';
	};

	// ===========================================================

	const toggleCard = async (card) => {
		// Read the id off the card rather than closing over it: VRChat recycles
		// card nodes between rows, and a stale closure would hide the wrong world.
		const id = card.dataset.vrcwhId;
		if (!id) return;

		if (isHidden(id)) {
			delete hidden[id];
		} else {
			hidden[id] = worldNameFrom(card);
		}
		logDebug(`Toggled ${id}`);

		await persistHidden();
		applyAll();
	};

	const makeCardButton = (card) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'VRCWH-BTN';
		button.addEventListener('click', async (event) => {
			// Cards are blanketed in absolutely-positioned <a> overlays
			event.preventDefault();
			event.stopPropagation();
			await toggleCard(card);
		});
		card.appendChild(button);
		return button;
	};

	const updateCard = (card, id) => {
		setClass(card, 'VRCWH-CARD', true);
		if (card.dataset.vrcwhId !== id) card.dataset.vrcwhId = id;

		const button =
			card.querySelector(':scope > .VRCWH-BTN') || makeCardButton(card);
		const marked = isHidden(id);

		setIcon(button, marked ? 'eye' : 'eyeSlash');
		setClass(button, 'VRCWH-BTN-ON', marked);
		setAttr(button, 'title', marked ? 'Un-hide this world' : 'Hide this world');
		setAttr(
			button,
			'aria-label',
			marked ? 'Un-hide this world' : 'Hide this world',
		);

		setClass(card, 'VRCWH-WORLD-DIMMED', marked && toggleState === 'dimmed');
		setClass(card, 'VRCWH-WORLD-HIDDEN', marked && toggleState === 'hidden');
		setClass(card, 'VRCWH-WORLD-MARKED', marked && toggleState === 'normal');
	};

	// A row whose every card is hidden leaves a heading and two scroll arrows
	// over empty space, so collapse the whole section instead. Returns the
	// section it touched so the caller can clear the ones it no longer owns.
	const updateRow = (container, cards) => {
		const allHidden = cards.every((card) =>
			card.classList.contains('VRCWH-WORLD-HIDDEN'),
		);

		let section = container;
		for (let i = 0; i < 4; i++) {
			const parent = section.parentElement;
			if (!parent || parent === document.body) return null;
			section = parent;
			if (section.querySelector(CHILD_HEADING_SELECTOR)) {
				setClass(section, 'VRCWH-ROW-EMPTY', allHidden);
				return section;
			}
		}
		return null;
	};

	const updateClassOnWorldCards = () => {
		try {
			const idCache = new Map();
			const seenCards = new Set();
			const signatures = new Set();
			const rows = new Map();
			const pending = [];
			// Sections collapsed by an earlier pass. Anything still in here at
			// the end no longer resolves, so its class has to come back off or
			// the section stays invisible until a reload.
			const stale = new Set(document.querySelectorAll('.VRCWH-ROW-EMPTY'));

			const take = (resolved, id) => {
				if (!resolved || seenCards.has(resolved.card)) return;
				seenCards.add(resolved.card);

				updateCard(resolved.card, id);

				const row = rows.get(resolved.container);
				if (row) {
					row.push(resolved.card);
				} else {
					rows.set(resolved.container, [resolved.card]);
				}
			};

			for (const link of document.querySelectorAll(WORLD_LINK_SELECTOR)) {
				const id = linkWorldId(link);
				if (!id) continue;

				const resolved = resolveCard(link, idCache);
				if (!resolved) {
					pending.push({ link, id });
					continue;
				}

				const signature = cardSignature(resolved.card);
				if (signature) signatures.add(signature);
				take(resolved, id);
			}

			for (const { link, id } of pending) {
				take(resolveCardBySignature(link, idCache, signatures), id);
			}

			for (const [container, cards] of rows) {
				const section = updateRow(container, cards);
				if (section) stale.delete(section);
			}

			for (const section of stale) {
				setClass(section, 'VRCWH-ROW-EMPTY', false);
			}

			logDebug(`Processed ${seenCards.size} cards, state "${toggleState}"`);
		} catch (error) {
			console.error('[VRC-WH]', error);
		}
	};

	// ===========================================================

	let fab = null;

	// .friends-button is fixed with a hard-coded top/right. Read its real box
	// instead of duplicating those numbers.
	const positionFab = () => {
		if (!fab) return;

		const friends = document.querySelector('.friends-button');
		const rect = friends?.getBoundingClientRect();

		// Narrow viewports hide the friends button. Drop back to the stylesheet
		// position instead of keeping geometry measured at desktop width.
		if (!rect?.width) {
			fab.style.top = '';
			fab.style.right = '';
			fab.style.width = '';
			fab.style.height = '';
			return;
		}

		// clientWidth, not innerWidth: innerWidth includes the scrollbar, which
		// is not part of the box a fixed element's `right` resolves against.
		const viewport = document.documentElement.clientWidth;

		fab.style.top = `${rect.top}px`;
		fab.style.right = `${viewport - rect.right + rect.width + 12}px`;
		fab.style.width = `${rect.width}px`;
		fab.style.height = `${rect.height}px`;
	};

	const cycleState = async () => {
		toggleState = STATES[(STATES.indexOf(toggleState) + 1) % STATES.length];
		await stateSet(KEY_STATE, toggleState);
		logDebug(`Toggled to "${toggleState}"`);
		applyAll();
	};

	const unhideAll = async () => {
		const count = Object.keys(hidden).length;
		if (count === 0) return;
		if (!confirm(`Un-hide all ${count} hidden world(s)?`)) return;

		hidden = {};
		await persistHidden();
		applyAll();
	};

	const buildFab = () => {
		const el = document.createElement('div');
		el.className = 'VRCWH-FAB';
		el.setAttribute('role', 'button');
		el.setAttribute('tabindex', '0');

		const icon = document.createElement('span');
		icon.className = 'VRCWH-FAB-ICON';
		el.appendChild(icon);

		const count = document.createElement('span');
		count.className = 'VRCWH-FAB-COUNT';
		el.appendChild(count);

		el.addEventListener('click', async (event) => {
			// Escape hatch for "I hid something by accident and can't find it"
			if (event.altKey) {
				await unhideAll();
				return;
			}
			await cycleState();
		});
		el.addEventListener('keydown', async (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			await cycleState();
		});

		return el;
	};

	const renderFab = () => {
		if (!document.body) return;
		if (!fab || !fab.isConnected) {
			fab = buildFab();
			document.body.appendChild(fab);
		}

		const total = Object.keys(hidden).length;

		setIcon(
			fab.querySelector('.VRCWH-FAB-ICON'),
			toggleState === 'hidden' ? 'eyeSlash' : 'eye',
		);
		setClass(fab, 'VRCWH-STATE-dimmed', toggleState === 'dimmed');
		setClass(fab, 'VRCWH-STATE-hidden', toggleState === 'hidden');
		setText(fab.querySelector('.VRCWH-FAB-COUNT'), total ? String(total) : '');
		setAttr(
			fab,
			'title',
			`Hidden worlds: currently "${toggleState}" (${total} marked)\n` +
				'Click to cycle normal -> dimmed -> hidden. Alt-click to un-hide everything.',
		);

		positionFab();
	};

	// ===========================================================

	const applyAll = () => {
		updateClassOnWorldCards();
		renderFab();
	};

	const run = debounce(() => {
		logDebug('Running check for hidden worlds');
		applyAll();
	}, 250);

	// ===========================================================

	const observeDOM = (() => {
		const MutationObserver =
			window.MutationObserver || window.WebKitMutationObserver;
		const eventListenerSupported = window.addEventListener;

		// closest(), not a class check: the badge and icon spans live inside
		// the FAB, and their text/icon rewrites are ours too.
		const isOurs = (node) =>
			!!(node?.nodeType === 1
				? node.closest?.('.VRCWH-BTN, .VRCWH-FAB')
				: node?.parentElement?.closest?.('.VRCWH-BTN, .VRCWH-FAB'));

		// True when a mutation only concerns nodes this script owns
		const isOwnMutation = (mutation) => {
			if (isOurs(mutation.target)) return true;
			const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
			return nodes.length > 0 && nodes.every(isOurs);
		};

		return (obj, callback) => {
			logDebug('Attaching DOM listener');

			// Invalid `obj` given
			if (!obj) return;

			if (MutationObserver) {
				const obs = new MutationObserver((mutations, _observer) => {
					if (mutations.every(isOwnMutation)) return;
					if (
						mutations.some((m) => m.addedNodes.length || m.removedNodes.length)
					) {
						callback(mutations);
					}
				});

				obs.observe(obj, { childList: true, subtree: true });
			} else if (eventListenerSupported) {
				obj.addEventListener('DOMNodeInserted', callback, false);
				obj.addEventListener('DOMNodeRemoved', callback, false);
			}
		};
	})();

	// ===========================================================

	const start = async () => {
		logDebug('Starting Script');

		const storedState = await stateGet(KEY_STATE, 'normal');
		toggleState = STATES.includes(storedState) ? storedState : 'normal';
		hidden = parseHidden(await stateGet(KEY_HIDDEN, '{}'));

		try {
			if (typeof GM_registerMenuCommand === 'function') {
				GM_registerMenuCommand('Un-hide all worlds', unhideAll);
			}
		} catch (_) {
			/* menu commands are optional */
		}

		window.addEventListener('resize', positionFab);

		// VRChat is a SPA: rows lazy-load on scroll and the content pane swaps
		// on navigation, so re-run on any DOM change.
		observeDOM(document.body, run);

		applyAll();
	};

	start();
})();
