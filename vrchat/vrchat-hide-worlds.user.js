// ==UserScript==
// @name         VRChat: Hide Worlds
// @namespace    https://github.com/ceeprus/userscript
// @version      1.21
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vrchat.com
// @description  Hide worlds you never want to see again from the VRChat website, and create or join an instance straight from any world card without opening the world page.
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
const WORLD_INFO_SELECTOR = '[role="region"][aria-label="World Info"]';
// Same button, relabelled once an instance is picked, so match both.
const LAUNCH_SELECTOR =
	'button[aria-label="Launch"], button[aria-label="Create Instance"]';
const LAUNCH_LINK_SELECTOR = 'a[href*="/home/launch?worldId="]';
const OWN_SELECTOR =
	'.VRCWH-BTN, .VRCWH-FAB, .VRCWH-BADGE, .VRCWH-PAGE-BTN, .VRCWH-JOIN, .VRCWH-PANEL';
const HEADING_SELECTOR = 'h1, h2, h3, h4';
const TITLE_HEADING_SELECTOR = 'h1, h2, h3';
// `:scope` binds only to the compound it sits in, so ':scope > h1, h2' would
// mean "direct-child h1, or ANY descendant h2". Scope every compound.
const CHILD_HEADING_SELECTOR = HEADING_SELECTOR.split(',')
	.map((tag) => `:scope > ${tag.trim()}`)
	.join(', ');
const STATES = ['normal', 'dimmed', 'hidden'];
const MAX_CLIMB = 10;

// An instance id is `name~key(value)~...`, and VRChat's own parser only
// accepts these keys in this order. `name` is a plain random integer below
// 1e5 — the site generates it client-side, nothing is reserved server-side.
const INSTANCE_TYPES = [
	{ id: 'public', label: 'Public', hint: 'Anybody can join', keys: [] },
	{
		id: 'friendsPlus',
		label: 'Friends+',
		hint: 'Any friend of a user in the instance may join',
		keys: ['hidden'],
	},
	{
		id: 'friends',
		label: 'Friends',
		hint: 'Only your friends may join',
		keys: ['friends'],
	},
	{
		id: 'invitePlus',
		label: 'Invite+',
		hint: 'You can invite others. Joiners can accept requests',
		keys: ['private', 'canRequestInvite'],
	},
	{
		id: 'invite',
		label: 'Invite',
		hint: 'You can invite others. Only you can accept requests',
		keys: ['private'],
	},
];

const REGIONS = [
	{ id: 'us', label: 'USW' },
	{ id: 'use', label: 'USE' },
	{ id: 'eu', label: 'EU' },
	{ id: 'jp', label: 'JP' },
];

const DEFAULT_LAUNCH = {
	type: 'public',
	region: 'us',
	inviteMe: true,
};

((_undefined) => {
	// Enable for debugging
	const DEBUG = false;

	const KEY_STATE = 'VRCWH_STATE';
	const KEY_HIDDEN = 'VRCWH_HIDDEN';
	const KEY_LAUNCH = 'VRCWH_LAUNCH';

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

.VRCWH-BADGE {
	align-items: center;
	background: #8f2f2f;
	border-radius: 4px;
	color: #fff;
	display: inline-flex;
	flex: none;
	font-size: 10px;
	font-weight: 700;
	letter-spacing: .04em;
	line-height: 1;
	margin-left: 6px;
	padding: 3px 5px;
	text-transform: uppercase;
	vertical-align: middle;
	white-space: nowrap;
}

.VRCWH-PAGE-BTN {
	align-items: center;
	align-self: flex-start;
	background: #07242b;
	border: 2px solid #053c48;
	border-radius: 4px;
	color: #fff;
	cursor: pointer;
	display: inline-flex;
	font-size: 1rem;
	gap: 8px;
	margin-top: 8px;
	padding: 5px 12px;
	transition: background .1s ease-in, transform .1s ease-in;
}

.VRCWH-PAGE-BTN:hover { background: #05191d }

.VRCWH-PAGE-BTN.VRCWH-BTN-ON {
	background: rgba(74, 12, 12, .9);
	border-color: #8f2f2f;
	color: #ff9d9d;
}

.VRCWH-PAGE-BTN svg { height: 16px; width: 16px }

/* The Launch button themes itself off this variable, so recolouring it here
   keeps VRChat's own hover and contrast rules intact. */
.VRCWH-LAUNCH-HIDDEN { --profile-button-color: #8f2f2f }

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
	/* The measured friends button includes its border, so match it */
	box-sizing: border-box;
	color: #fff;
	cursor: pointer;
	display: flex;
	height: var(--vrcwh-fab-size, 65px);
	justify-content: center;
	position: fixed;
	right: var(--vrcwh-fab-right, 100px);
	top: var(--vrcwh-fab-top, 70px);
	transition: background .1s ease-in, transform .1s ease-in;
	width: var(--vrcwh-fab-size, 65px);
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

.VRCWH-JOIN {
	align-items: center;
	background: #064b5c;
	border: 2px solid #064b5c;
	border-radius: 4px;
	color: #fff;
	cursor: pointer;
	display: flex;
	font-size: 13px;
	gap: 6px;
	justify-content: center;
	margin: 6px;
	padding: 5px 8px;
	position: relative;
	transition: background .1s ease-in, transform .1s ease-in;
	width: calc(100% - 12px);
	z-index: 20;
}

.VRCWH-JOIN:hover { background: #0a6b81; border-color: #0a6b81 }

.VRCWH-JOIN:active { transform: scale(.98) }

.VRCWH-JOIN[disabled] { cursor: default; opacity: .6 }

.VRCWH-JOIN.VRCWH-JOIN-LIVE { background: #1d6b2f; border-color: #1d6b2f }

.VRCWH-JOIN.VRCWH-JOIN-LIVE:hover { background: #268a3d; border-color: #268a3d }

.VRCWH-JOIN.VRCWH-JOIN-ERROR { background: #6b1f1f; border-color: #8f2f2f }

.VRCWH-JOIN svg { height: 13px; width: 13px }

.VRCWH-PANEL {
	background: #1b1f22;
	border: 1px solid #333;
	border-radius: 8px;
	box-shadow: rgba(0, 0, 0, .5) 0 8px 30px;
	color: #fff;
	font-size: 13px;
	max-height: calc(100vh - 160px);
	overflow-y: auto;
	padding: 12px;
	position: fixed;
	right: var(--vrcwh-panel-right, 100px);
	top: var(--vrcwh-panel-top, 145px);
	width: 300px;
	z-index: 4;
}

.VRCWH-PANEL-TITLE {
	color: #4fc3d9;
	font-weight: 700;
	margin: 10px 0 6px;
	text-align: center;
}

.VRCWH-PANEL-TITLE:first-child { margin-top: 0 }

.VRCWH-OPT {
	align-items: baseline;
	background: #24292d;
	border: 1px solid transparent;
	border-radius: 5px;
	color: #ccc;
	cursor: pointer;
	display: flex;
	gap: 8px;
	margin-bottom: 4px;
	padding: 7px 9px;
	text-align: left;
	width: 100%;
}

.VRCWH-OPT:hover { background: #2c3237 }

.VRCWH-OPT.VRCWH-ON { border-color: #4fc3d9 }

.VRCWH-OPT.VRCWH-ON .VRCWH-OPT-NAME { color: #4fc3d9 }

.VRCWH-OPT-NAME { color: #fff; flex: none; font-weight: 600 }

.VRCWH-OPT-HINT { color: #8b969c; font-size: 11px }

.VRCWH-CHIPS { display: flex; gap: 6px }

.VRCWH-CHIP {
	background: #24292d;
	border: 1px solid transparent;
	border-radius: 5px;
	color: #ccc;
	cursor: pointer;
	flex: 1;
	padding: 6px 4px;
	text-align: center;
}

.VRCWH-CHIP:hover { background: #2c3237 }

.VRCWH-CHIP.VRCWH-ON { border-color: #4fc3d9; color: #4fc3d9 }

.VRCWH-CHECK {
	align-items: center;
	background: #24292d;
	border: 1px solid transparent;
	border-radius: 5px;
	color: #ccc;
	cursor: pointer;
	display: flex;
	gap: 8px;
	margin-top: 6px;
	padding: 7px 9px;
	width: 100%;
}

.VRCWH-CHECK.VRCWH-ON { border-color: #4fc3d9; color: #fff }

.VRCWH-CHECK-BOX {
	border: 2px solid #55606a;
	border-radius: 3px;
	flex: none;
	height: 15px;
	position: relative;
	width: 15px;
}

.VRCWH-CHECK.VRCWH-ON .VRCWH-CHECK-BOX {
	background: #4fc3d9;
	border-color: #4fc3d9;
}

.VRCWH-CHECK.VRCWH-ON .VRCWH-CHECK-BOX::after {
	border: solid #12181b;
	border-width: 0 2px 2px 0;
	content: '';
	height: 8px;
	left: 4px;
	position: absolute;
	top: 0;
	transform: rotate(45deg);
	width: 4px;
}

.VRCWH-PANEL-NOTE { color: #8b969c; font-size: 11px; margin-top: 8px }
`);

	const ICONS = {
		rocket:
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M156.6 384.9 125.7 354c-8.5-8.5-11.5-20.8-7.7-32 3.8-11.2 8.1-22.8 12.9-34.7L120 288c-17.7 0-32-14.3-32-32 0-17.7 14.3-32 32-32l40.4 0c33.5-59.3 79-108.5 137-146.1C332.9 55.3 386.2 44.6 434 45.6c11.7.2 21.2 9.7 21.4 21.4 1 47.8-9.7 101.1-32.3 146.6-37.6 58-86.8 103.5-146.1 137l0 40.4c0 17.7-14.3 32-32 32-17.7 0-32-14.3-32-32l0-11c-11.9 4.8-23.5 9.1-34.7 12.9-11.2 3.8-23.5.8-32-7.7zM384 168a40 40 0 1 0-80 0 40 40 0 1 0 80 0z"/></svg>',
		eye: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 9C14 9 5.46 15.22 2 24c3.46 8.78 12 15 22 15 10.01 0 18.54-6.22 22-15-3.46-8.78-11.99-15-22-15zm0 25c-5.52 0-10-4.48-10-10s4.48-10 10-10 10 4.48 10 10-4.48 10-10 10zm0-16c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/></svg>',
		eyeSlash:
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M24 14c5.52 0 10 4.48 10 10 0 1.29-.26 2.52-.71 3.65l5.85 5.85c3.02-2.52 5.4-5.78 6.87-9.5-3.47-8.78-12-15-22.01-15-2.8 0-5.48.5-7.97 1.4l4.32 4.31c1.13-.44 2.36-.71 3.65-.71zM4 8.55l4.56 4.56.91.91C6.17 16.6 3.56 20.03 2 24c3.46 8.78 12 15 22 15 3.1 0 6.06-.6 8.77-1.69l.85.85L39.45 44 42 41.46 6.55 6 4 8.55zM15.06 19.6l3.09 3.09c-.09.43-.15.86-.15 1.31 0 3.31 2.69 6 6 6 .45 0 .88-.06 1.3-.15l3.09 3.09C27.06 33.6 25.58 34 24 34c-5.52 0-10-4.48-10-10 0-1.58.4-3.06 1.06-4.4zm8.61-1.57 6.3 6.3L30 24c0-3.31-2.69-6-6-6l-.33.03z"/></svg>',
	};

	// ===========================================================

	// In-memory mirror of storage so the render path stays synchronous.
	// `hidden` maps world id -> world name, name is tooltip-only.
	let toggleState = 'normal';
	let hidden = {};
	let launch = { ...DEFAULT_LAUNCH };

	const isHidden = (id) => Object.hasOwn(hidden, id);

	const persistHidden = () => stateSet(KEY_HIDDEN, JSON.stringify(hidden));

	const parseStored = (raw) => {
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

	// The title is the first text in the card, ahead of the player count and
	// author. Read structurally to avoid depending on the title's class.
	const titleElementFrom = (root) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent.trim()) continue;
			const parent = node.parentElement;
			// Our own badge sits after the title, never before it, but skip it
			// anyway so the name can't come back as "Hidden".
			if (!parent || parent.closest('.VRCWH-BADGE')) continue;
			return parent;
		}
		return null;
	};

	// The badge lives inside the title element, so it has to be skipped when
	// reading the name back out.
	const textWithoutBadge = (el) => {
		if (!el) return '';
		let text = '';
		for (const node of el.childNodes) {
			if (node.nodeType === 1 && node.classList.contains('VRCWH-BADGE')) continue;
			text += node.textContent;
		}
		return text.trim();
	};

	const worldNameFrom = (root) =>
		textWithoutBadge(titleElementFrom(root)).slice(0, 80);

	// Goes inside the title element rather than after it: a world page header
	// is a column flex, so a sibling would drop onto its own full-width row
	// instead of sitting beside the name.
	const syncBadge = (anchor, marked) => {
		if (!anchor) return;

		const existing = anchor.querySelector(':scope > .VRCWH-BADGE');
		if (!marked) {
			existing?.remove();
			return;
		}
		if (existing) return;

		const badge = document.createElement('span');
		badge.className = 'VRCWH-BADGE';
		badge.textContent = 'Hidden';
		anchor.appendChild(badge);
	};

	// ===========================================================

	// ===========================================================

	// Only the private instance types need an owner id, so this is fetched
	// lazily and kept for the session.
	let selfId = null;
	let selfIdPromise = null;

	const fetchSelfId = () => {
		if (selfId) return Promise.resolve(selfId);
		if (selfIdPromise) return selfIdPromise;

		selfIdPromise = fetch('/api/1/auth/user', {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
		})
			.then((response) => (response.ok ? response.json() : null))
			.then((user) => {
				selfId = user?.id || null;
				return selfId;
			})
			.catch((error) => {
				console.error('[VRC-WH]', error);
				return null;
			})
			.finally(() => {
				selfIdPromise = null;
			});

		return selfIdPromise;
	};

	const typeById = (id) =>
		INSTANCE_TYPES.find((entry) => entry.id === id) || INSTANCE_TYPES[0];

	// Key order is VRChat's, not ours — its parser walks a fixed list.
	const buildInstanceId = (type, region, ownerId) => {
		const parts = [String(Math.floor(Math.random() * 1e5))];

		for (const key of type.keys) {
			parts.push(key === 'canRequestInvite' ? key : `${key}(${ownerId})`);
		}
		parts.push(`region(${region})`);
		if (type.keys.length) parts.push(`nonce(${crypto.randomUUID()})`);

		return parts.join('~');
	};

	const inviteSelf = (worldId, instanceId) =>
		fetch(`/api/1/invite/myself/to/${worldId}:${instanceId}`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});

	// Deliberately never fires vrchat://: that boots the game straight into a
	// brand new instance. Open VRChat's launch page and leave the choice there.
	const openInstance = (worldId, instanceId) => {
		window.open(
			`/home/launch?worldId=${worldId}&instanceId=${encodeURIComponent(instanceId)}`,
			'_blank',
			'noopener',
		);
	};

	// `existing` is set when the card already points at a live instance, in
	// which case we join that one instead of making a new one.
	const runLaunch = async (button, worldId, existing) => {
		const type = typeById(launch.type);
		let instanceId = existing;

		if (!instanceId) {
			let ownerId = null;
			if (type.keys.length) {
				ownerId = await fetchSelfId();
				if (!ownerId) {
					setClass(button, 'VRCWH-JOIN-ERROR', true);
					setText(button.querySelector('.VRCWH-JOIN-LABEL'), 'Not signed in');
					return;
				}
			}
			instanceId = buildInstanceId(type, launch.region, ownerId);
		}

		if (launch.inviteMe) {
			try {
				await inviteSelf(worldId, instanceId);
			} catch (error) {
				console.error('[VRC-WH]', error);
			}
		}

		openInstance(worldId, instanceId);
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

	// Cards in the "Active" rows link at a live instance; everything else has
	// to have one made for it.
	const existingInstanceFrom = (card) => {
		const link = card.querySelector(LAUNCH_LINK_SELECTOR);
		if (!link) return null;
		const url = new URL(link.href, location.origin);
		return url.searchParams.get('instanceId');
	};

	const makeJoinButton = (card) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'VRCWH-JOIN';

		const icon = document.createElement('span');
		icon.className = 'VRCWH-JOIN-ICON';
		button.appendChild(icon);
		setIcon(icon, 'rocket');

		const label = document.createElement('span');
		label.className = 'VRCWH-JOIN-LABEL';
		button.appendChild(label);

		button.addEventListener('click', async (event) => {
			// The whole card is an overlay anchor to the world page.
			event.preventDefault();
			event.stopPropagation();

			const worldId = card.dataset.vrcwhId;
			if (!worldId || button.disabled) return;

			button.disabled = true;
			setText(button.querySelector('.VRCWH-JOIN-LABEL'), 'Working...');
			try {
				await runLaunch(button, worldId, existingInstanceFrom(card));
			} finally {
				button.disabled = false;
				applyAll();
			}
		});

		card.appendChild(button);
		return button;
	};

	const updateJoinButton = (card) => {
		const button =
			card.querySelector(':scope > .VRCWH-JOIN') || makeJoinButton(card);
		const live = existingInstanceFrom(card);

		setClass(button, 'VRCWH-JOIN-LIVE', !!live);
		if (button.disabled) return;

		setClass(button, 'VRCWH-JOIN-ERROR', false);
		setText(
			button.querySelector('.VRCWH-JOIN-LABEL'),
			live ? 'Join instance' : typeById(launch.type).label,
		);
		setAttr(
			button,
			'title',
			live
				? 'Join the live instance this card points at'
				: `Create a ${typeById(launch.type).label} instance in ${
						REGIONS.find((r) => r.id === launch.region)?.label || launch.region
					}`,
		);
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

		syncBadge(titleElementFrom(card), marked);
		updateJoinButton(card);

		setClass(card, 'VRCWH-WORLD-DIMMED', marked && toggleState === 'dimmed');
		setClass(card, 'VRCWH-WORLD-HIDDEN', marked && toggleState === 'hidden');
		setClass(card, 'VRCWH-WORLD-MARKED', marked && toggleState === 'normal');
	};

	// A world page shows one world, so the card resolver finds nothing there.
	// Drive it off the URL instead: badge the title, recolour Launch, and add
	// a labelled toggle so a world can be hidden while you are looking at it.
	let pageButton = null;

	const togglePageWorld = async (title) => {
		const id = worldIdFrom(location.pathname);
		if (!id) return;

		if (isHidden(id)) {
			delete hidden[id];
		} else {
			hidden[id] = textWithoutBadge(title).slice(0, 80);
		}

		await persistHidden();
		applyAll();
	};

	const updateWorldPage = () => {
		const id = worldIdFrom(location.pathname);
		const marked = !!id && isHidden(id);

		const launch = document.querySelector(LAUNCH_SELECTOR);
		if (launch) setClass(launch, 'VRCWH-LAUNCH-HIDDEN', marked);

		const header = document.querySelector(WORLD_INFO_SELECTOR)?.parentElement;
		const title = header?.querySelector('h2');
		if (!id || !title) {
			pageButton?.remove();
			pageButton = null;
			return;
		}

		syncBadge(title, marked);

		if (!pageButton?.isConnected) {
			pageButton = document.createElement('button');
			pageButton.type = 'button';
			pageButton.className = 'VRCWH-PAGE-BTN';

			const icon = document.createElement('span');
			icon.className = 'VRCWH-PAGE-ICON';
			pageButton.appendChild(icon);

			const label = document.createElement('span');
			label.className = 'VRCWH-PAGE-LABEL';
			pageButton.appendChild(label);

			pageButton.addEventListener('click', async (event) => {
				event.preventDefault();
				event.stopPropagation();
				await togglePageWorld(title);
			});

			header.appendChild(pageButton);
		}

		setIcon(pageButton.querySelector('.VRCWH-PAGE-ICON'), marked ? 'eye' : 'eyeSlash');
		setText(
			pageButton.querySelector('.VRCWH-PAGE-LABEL'),
			marked ? 'Un-hide this world' : 'Hide this world',
		);
		setClass(pageButton, 'VRCWH-BTN-ON', marked);
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
	// Geometry rides on custom properties instead of the `top`/`right`
	// longhands: the base rule already sets those, and an inline longhand does
	// not reliably outrank it in every environment this script runs in.
	const setVar = (el, name, value) => {
		if (!el) return;
		if (value === null) el.style.removeProperty(name);
		else if (el.style.getPropertyValue(name) !== value) {
			el.style.setProperty(name, value);
		}
	};

	const clearFabGeometry = (el) => {
		setVar(el, '--vrcwh-fab-top', null);
		setVar(el, '--vrcwh-fab-right', null);
		setVar(el, '--vrcwh-fab-size', null);
	};

	// The eye and the rocket dock leftwards off .friends-button, which is
	// fixed with a hard-coded top/right.
	const positionFab = () => {
		const friends = document.querySelector('.friends-button');
		const rect = friends?.getBoundingClientRect();

		// Narrow viewports hide the friends button. Drop back to the stylesheet
		// position instead of keeping geometry measured at desktop width.
		if (!rect?.width) {
			clearFabGeometry(fab);
			clearFabGeometry(launchFab);
			setVar(launchFab, '--vrcwh-fab-right', '175px');
			positionPanel();
			return;
		}

		// clientWidth, not innerWidth: innerWidth includes the scrollbar, which
		// is not part of the box a fixed element's `right` resolves against.
		const viewport = document.documentElement.clientWidth;
		const gap = 12;
		const edge = viewport - rect.right;

		for (const [index, el] of [fab, launchFab].entries()) {
			if (!el) continue;
			setVar(el, '--vrcwh-fab-top', `${rect.top}px`);
			setVar(
				el,
				'--vrcwh-fab-right',
				`${edge + (rect.width + gap) * (index + 1)}px`,
			);
			setVar(el, '--vrcwh-fab-size', `${rect.width}px`);
		}

		positionPanel();
	};

	const positionPanel = () => {
		if (!panel || !launchFab) return;

		const rect = launchFab.getBoundingClientRect();
		const viewport = document.documentElement.clientWidth;
		const width = panel.offsetWidth || 300;
		// Keep it on screen when the rocket sits near the left edge.
		const right = Math.max(8, Math.min(viewport - rect.right, viewport - width - 8));

		setVar(panel, '--vrcwh-panel-top', `${rect.bottom + 10}px`);
		setVar(panel, '--vrcwh-panel-right', `${right}px`);
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

	// ===========================================================

	let launchFab = null;
	let panel = null;
	let panelSignature = '';

	const persistLaunch = () => stateSet(KEY_LAUNCH, JSON.stringify(launch));

	// Anything unrecognised falls back to the default, so a stale or hand-
	// edited setting can never end up inside a built instance id.
	const sanitiseLaunch = (stored) => {
		const pick = (list, value, fallback) =>
			list.some((entry) => entry.id === value) ? value : fallback;

		return {
			type: pick(INSTANCE_TYPES, stored.type, DEFAULT_LAUNCH.type),
			region: pick(REGIONS, stored.region, DEFAULT_LAUNCH.region),
			inviteMe:
				typeof stored.inviteMe === 'boolean'
					? stored.inviteMe
					: DEFAULT_LAUNCH.inviteMe,
		};
	};

	const setLaunch = async (patch) => {
		launch = { ...launch, ...patch };
		await persistLaunch();
		applyAll();
	};

	const optionRow = (name, hint, selected, onPick) => {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'VRCWH-OPT';
		setClass(row, 'VRCWH-ON', selected);

		const title = document.createElement('span');
		title.className = 'VRCWH-OPT-NAME';
		title.textContent = name;
		row.appendChild(title);

		if (hint) {
			const note = document.createElement('span');
			note.className = 'VRCWH-OPT-HINT';
			note.textContent = hint;
			row.appendChild(note);
		}

		row.addEventListener('click', onPick);
		return row;
	};

	const chipRow = (entries, current, onPick) => {
		const wrap = document.createElement('div');
		wrap.className = 'VRCWH-CHIPS';

		for (const entry of entries) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'VRCWH-CHIP';
			chip.textContent = entry.label;
			setClass(chip, 'VRCWH-ON', entry.id === current);
			chip.addEventListener('click', () => onPick(entry.id));
			wrap.appendChild(chip);
		}
		return wrap;
	};

	const sectionTitle = (text) => {
		const title = document.createElement('div');
		title.className = 'VRCWH-PANEL-TITLE';
		title.textContent = text;
		return title;
	};

	const buildPanel = () => {
		const el = document.createElement('div');
		el.className = 'VRCWH-PANEL';

		el.appendChild(sectionTitle('Select Instance Type'));
		for (const type of INSTANCE_TYPES) {
			el.appendChild(
				optionRow(type.label, type.hint, type.id === launch.type, () =>
					setLaunch({ type: type.id }),
				),
			);
		}

		el.appendChild(sectionTitle('Select Region'));
		el.appendChild(
			chipRow(REGIONS, launch.region, (region) => setLaunch({ region })),
		);

		const check = document.createElement('button');
		check.type = 'button';
		check.className = 'VRCWH-CHECK';
		setClass(check, 'VRCWH-ON', launch.inviteMe);
		const box = document.createElement('span');
		box.className = 'VRCWH-CHECK-BOX';
		check.appendChild(box);
		const checkLabel = document.createElement('span');
		checkLabel.textContent = 'Also Invite Me';
		check.appendChild(checkLabel);
		check.addEventListener('click', () => setLaunch({ inviteMe: !launch.inviteMe }));
		el.appendChild(check);

		const note = document.createElement('div');
		note.className = 'VRCWH-PANEL-NOTE';
		note.textContent =
			"Opens VRChat's launch page in a new tab. Nothing starts the game " +
			'until you press Launch World there.';
		el.appendChild(note);

		return el;
	};

	const closePanel = () => {
		panel?.remove();
		panel = null;
	};

	const togglePanel = () => {
		if (panel) {
			closePanel();
			return;
		}
		panelSignature = JSON.stringify(launch);
		panel = buildPanel();
		document.body.appendChild(panel);
		positionFab();
	};

	// Rebuilt in place so an open panel reflects a change immediately, but
	// only when something it shows actually changed — applyAll runs on every
	// DOM mutation, and rebuilding under the cursor would eat hover and focus.
	const refreshPanel = () => {
		if (!panel) return;

		const signature = JSON.stringify(launch);
		if (signature === panelSignature) return;
		panelSignature = signature;

		const next = buildPanel();
		panel.replaceWith(next);
		panel = next;
	};

	const onDocumentClick = (event) => {
		if (!panel) return;
		if (panel.contains(event.target)) return;
		if (launchFab?.contains(event.target)) return;
		closePanel();
	};

	const renderLaunchFab = () => {
		if (!document.body) return;

		if (!launchFab?.isConnected) {
			launchFab = document.createElement('div');
			launchFab.className = 'VRCWH-FAB';
			launchFab.setAttribute('role', 'button');
			launchFab.setAttribute('tabindex', '0');

			const icon = document.createElement('span');
			icon.className = 'VRCWH-FAB-ICON';
			launchFab.appendChild(icon);

			launchFab.addEventListener('click', togglePanel);
			launchFab.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				togglePanel();
			});

			document.body.appendChild(launchFab);
		}

		setIcon(launchFab.querySelector('.VRCWH-FAB-ICON'), 'rocket');
		setAttr(
			launchFab,
			'title',
			`Instance settings: ${typeById(launch.type).label} in ${
				REGIONS.find((r) => r.id === launch.region)?.label || launch.region
			}`,
		);
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
		updateWorldPage();
		renderLaunchFab();
		renderFab();
		refreshPanel();
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
		// the FAB and the page button, and their rewrites are ours too.
		const isOurs = (node) =>
			!!(node?.nodeType === 1
				? node.closest?.(OWN_SELECTOR)
				: node?.parentElement?.closest?.(OWN_SELECTOR));

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
		hidden = parseStored(await stateGet(KEY_HIDDEN, '{}'));
		launch = sanitiseLaunch(parseStored(await stateGet(KEY_LAUNCH, '{}')));

		try {
			if (typeof GM_registerMenuCommand === 'function') {
				GM_registerMenuCommand('Un-hide all worlds', unhideAll);
			}
		} catch (_) {
			/* menu commands are optional */
		}

		window.addEventListener('resize', positionFab);
		document.addEventListener('click', onDocumentClick, true);
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') closePanel();
		});

		// VRChat is a SPA: rows lazy-load on scroll and the content pane swaps
		// on navigation, so re-run on any DOM change.
		observeDOM(document.body, run);

		applyAll();
	};

	start();
})();
