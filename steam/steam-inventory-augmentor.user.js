// ==UserScript==
// @name         Steam Inventory Augmentor Modern
// @namespace    https://github.com/ceeprus
// @version      3.25.0
// @description  Steam inventory & trading enhancements with backpack.tf pricing: item value badges, sorting, duplicate grouping, trade tools.
// @author       ceeprus
// @icon         https://steamcommunity.com/favicon.ico
// @match        *://steamcommunity.com/id/*/inventory*
// @match        *://steamcommunity.com/profiles/*/inventory*
// @match        *://steamcommunity.com/tradeoffer/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      backpack.tf
// @connect      raw.githubusercontent.com
// @connect      github.com
// @updateURL    https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-inventory-augmentor.user.js
// @downloadURL  https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-inventory-augmentor.user.js
// ==/UserScript==

(() => {
	'use strict';

	// page context (Steam globals, element expandos)
	const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

	// ------------------------------------------------------------------
	// Config
	// ------------------------------------------------------------------
	const CONFIG = {
		tf2Badges: true,       // paint dots, KS tier, unusual star, spells, festivized, series, gift
		markUncraftable: true, // dashed outline on non-craftable TF2 items
		markUntradable: true,  // red bottom bar on untradable items (any app)
		duplicateFilter: true, // "Duplicate" tag in inventory filters
		gemify: true,          // one-click "Turn into Gems" (Steam Community items)
		multiSell: true,       // "Sell Multiple" link for commodity items
		sortButton: true,      // Sort dropdown (Default/Name/Type/Quality)
		stacking: true,        // "Stack dupes" toggle — collapse identical items into one box with ×N
		metalCounter: true,    // TF2 metal totals (ref/rec/scrap + total in ref, keys)
		priceIndicator: true,  // market price bottom-right on marketable items
		priceCooldownMs: 2500, // delay between price requests (Steam rate-limits hard)
		priceCacheMins: 1440,  // how long a fetched price stays valid (24h)
		tradeLockBadge: true,  // "6D" countdown on trade-locked items
		shrinkRenameWarning: true, // smaller red "!" on renamed items
		backpackTfKey: '',     // backpack.tf API key — set yours in the ⚙ settings panel
		tradeMetalHelper: true, // "Add metal" amount box on trade offer pages
		tradeEmptyButtons: true, // "Empty mine"/"Empty theirs" buttons on trade pages
		shiftClickAdd: true,   // shift+click an inventory item on trade pages to add it
		panelLinks: true,      // bp.tf + market icons on the selected-item panel
		quicksellButtons: false, // ⚡ instant-sell/undercut listing buttons (own inventory)
		showBuyOrders: false,  // green badge shows highest buy order (instant-sell value)
		                       // instead of the lowest listing — doubles market requests
		tradeCompare: true,    // live "Give ≈ X ref · Get ≈ Y ref" totals on trade pages
		cheapPriceThreshold: 0.03, // at/below this, prices refresh on the slow cycle
		cheapPriceCacheMins: 1440, // slow cycle: cheap items refresh once a day
		afterFeesValue: false, // Value line also shows proceeds after Steam's ~15% cut
		partnerValue: true,    // show trade partner's visible backpack value
		draftSaver: true,      // restore your trade selection after the window closes
		settingsPanel: true,   // gear button opens a settings UI (no file editing)
		updateURL: 'https://raw.githubusercontent.com/ceeprus/userscript/main/steam/steam-inventory-augmentor.user.js',
	};
	try { Object.assign(CONFIG, JSON.parse(localStorage.getItem('siaSettings')) || {}); } catch { /* defaults */ }

	const METAL_REF = { 'Refined Metal': 1, 'Reclaimed Metal': 1 / 3, 'Scrap Metal': 1 / 9 };

	const BPTF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC00lEQVR4AZRSXUhUQRg9M7u6GVlLRSFZWFj0kNEmCZIkG+b2o6alWUoaRpIPPlSSDz64LxVEUZI9BIKgkYSJP5jKBmomiaZutpU/tckKqShpboravTvTd9cUCyEa5tz5ud85c75vhksp/wcMfzVe29QRUttq/yfqmt/urW9v95fAHyK8ormjq+LFa/tKKG9otT+uttnLamz2J7bGrur6tso7OTmrl4twvY5LAvPR6xhjkknhYdpaCpUd2B3ICnIvseIbV1nozkCucoPZuWZL+b0rSasWRSh/QAiBdQaG4+EhCAnaDK0Z/fTIOncS641rYXv1BpPuGUBK9hOGowP+4WUPsrN9KY6RgMTMDzdiIsNwOjoSmzYYMTvtRvDWADDKts/pQnGlDYOjkxBSkoZg88w39oNxe8mjzEw9V1QViVHhOBS2z0tIiTuC4pvXkJUSD8459uzagbK7efDhZFrrgkSE5HPMJ7FzY3ARl3RKT78Trq+j5Ahw9DlRXt+MTkcfnSYxOj6Bp3WNUDwCHikgIBcgQPbFGKc1BoYn4Rwa9grYez/jedt7tL/rJQFgeGwcVS3dgM4XWq0WIKVOzLUEGLryuBCaL4KXTh9tqoGmS51sStojAyBIeNSRILcrJd9arniLSK8Rqurxxvut8sX0zDQFEoN2NKIg1jIoRnUyNb+wcITRvXDNANfp8fGLC5pQXFQErJfPUGbSuyYNGgEtjsog/ZSp/I1r9C0aWftHAoKCgdaeAZRW2fBpcAjjE1OY+O6GY1lxhRDSIGZrtvmz21arVWhkDVxRVDavKGRSL581dcnrBaXyflmD7HaOyFyaF1W/lEynE0KZdwXO9l/Mt1qlRlwEP2s5GJoeazalxZlNqSeiTBkJMab0OIvpfEy0KeNUjOlC/DFTmsW8PznWHHHrYcm3RetLAsmWCEeCOcyLZEuYYyUk0H7S4fCFe15k/h5/AQAA///sKIwVAAAABklEQVQDAIXGwCQOPvQKAAAAAElFTkSuQmCC';
	const STEAM_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABv0lEQVR4AYSST0gUYRjGn/ebHXfdnSa2Vijz5rFLFARR0SEKNjoVHYuFwEOHsFtBnfNYFARJh0S8uSdRES+KHsSLIAge9qK4XhwPIir+mc/3fdcZdvVTB37zvPN9z/N8MzAGjutq152YsadxWNFSENy6FzP2yHrE4DSyx8TNRWlB7uZ9exh7xOASSLxJiRb4Nx7ERzbDJ7rZrc8hgbys+iQjJVpgyCdDGbjYX59FrvMJRiYaurM6feLzSQtynU8tkQ8XgC8e7NWn8PL5Q9V81zNV8UvWGA6fx159Uguab8Y0StOMl22Hl82fISwW01zY/Qp/B8YQdr/G9sqoapIxW7UqtmrD6Pv2HhkuS1hfHEoLxNPzrqy+67fftvhM4vpQeYHNpUGF2tqT5VRLd3sgEB9icnmklB71pqZkiBb6sX9wqI//qjMoPf4EFApOTDT7kzrKXyFo4uTW5md0+tw/DgoKTqKZH9T4hEJgEQToeNOH+eU11d4/o6qy7kQyfIQWbAx/MZZfUSh/r0J0cK6mKrMLyXAeWiBD9P8jIQwtgwu5Elr1SohJC3hG9KtiGEKxaHGN/4NmeE32ot+VlswxAAAA//+WslJ1AAAABklEQVQDAOsRwKnOCKgSAAAAAElFTkSuQmCC';
	// Steam economy item images (hashes are long-term stable, CSP allows https:)
	const CUR_IMG = (hash) => `https://community.fastly.steamstatic.com/economy/image/${hash}/28fx28f`;
	const CUR_ICONS = {
		ref: CUR_IMG('fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsO1Mv6NGucF1Ygzt8ZQijJukFMiMrbhYDEwI1yRVKNfD6xorQ3qW3Jr6546DNPuou9IOVK4p4kWJaA'),
		rec: CUR_IMG('fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsO0Mv6NGucF1YJlscMEgDdvxVYsMLPkMmFjI1OSUvMHDPBp9lu0CnVluZQxA9Gwp-hIOVK4sMMNWF4'),
		scrap: CUR_IMG('fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsPZAfOeD-VOn4phtsdQ32ZtxFYoN7PkYmVmIgeaUKNaX_Rjpwy8UHMz6pcxAIfnovUWJ1t9nYFqYw'),
		key: CUR_IMG('fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEAaR4uURrwvz0N252yVaDVWrRTno9m4ccG2GNqxlQoZrC2aG9hcVGUWflbX_drrVu5UGki5sAij6tOtQ'),
		robot: CUR_IMG('fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEGegouTxTgsSxQt5iwMv6NGucF1Y4wtsRXjmVuyVcuYrGxNGY-IwGVUqEGDKA-oA3uDSFq7JNnVYayrr5IOVK4CVyuuBM'),
	};
	const curIcon = (kind, title) =>
		`<img class="sia-cur" src="${CUR_ICONS[kind]}" title="${title}" alt="${title}">`;

	const MARKET_ICON = 'data:image/svg+xml;base64,' + btoa(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
		'<path fill="#66C0F4" d="M1 1h2.5l.6 2H15l-1.8 7H4.9L3.2 3.6 2.7 2H1zM5.3 9h6.9l1-4H4.6zM6 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm7 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/></svg>');

	// ------------------------------------------------------------------
	// Styles
	// ------------------------------------------------------------------
	const style = document.createElement('style');
	style.textContent = `
		.item { position: relative; }
		.sia-b { position: absolute; inset: 1px; display: flex; flex-direction: column;
			justify-content: space-between; pointer-events: none; z-index: 5;
			font: bold 10px/1 "Motiva Sans", Arial, sans-serif; }
		.sia-row { display: flex; justify-content: space-between; align-items: flex-start; }
		.sia-row > span { display: flex; gap: 2px; align-items: center; }
		.sia-tag { color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; padding: 1px; }
		.sia-star { color: #B07EDC; font-size: 12px; text-shadow: 0 0 3px #000; }
		.sia-ks { color: #9FD3F6; background: rgba(42, 71, 94, .9); border-radius: 2px;
			padding: 1px 3px; font-size: 9px; text-shadow: none; }
		.sia-series { color: #C6C4C2; background: rgba(0, 0, 0, .55); border-radius: 2px;
			padding: 1px 3px; font-size: 9px; text-shadow: none; }
		.sia-uncraft { outline: 1px dashed rgba(255,255,255,.45); outline-offset: -3px; }
		.sia-untrade::after { content: ""; position: absolute; left: 2px; right: 2px; bottom: 1px;
			height: 2px; background: #A94847; z-index: 5; pointer-events: none; }
		.sia-gems::before { display: block; position: absolute; content: "+" attr(data-gemcount) " GEMS";
			color: #fff; text-align: center; font-size: 15px; width: 100%; z-index: 6;
			font-family: "Motiva Sans Light", Arial, sans-serif; padding-top: 30px; }
		.sia-gems > img { opacity: .2; }
		#sia-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; row-gap: 5px;
			margin: 8px 0; padding: 6px 8px; background: #1a1d21;
			border: 1px solid #262a2e; border-radius: 3px; color: #b8b6b4;
			font: 12px "Motiva Sans", Arial, sans-serif; }
		#sia-bar button, #sia-bar select, #sia-bar input { height: 24px; box-sizing: border-box; }
		#sia-bar select { max-width: 128px; }
		#sia-bar button { padding: 3px 8px; }
		#sia-bar select { background: #24282e; color: #dcdedf; border: 1px solid #000; padding: 2px 4px; }
		#sia-bar input { background: #24282e; color: #dcdedf; border: 1px solid #000;
			padding: 2px 4px; width: 60px; }
		#sia-bar button { background: rgba(103, 112, 123, .2); color: #d2d8de; border: 0;
			border-radius: 2px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
		#sia-bar button:hover { background: rgba(103, 112, 123, .45); color: #fff; }
		#sia-bar .sia-stack-on { background: #67c1f5; color: #16202d; }
		#sia-bar .sia-stack-on:hover { background: #8ed1f8; color: #16202d; }
		#sia-bptf-toggle { padding: 3px 6px; }
		#sia-bptf-toggle img { width: 16px; height: 16px; display: block; }
		.sia-btn-ico { width: 16px; height: 16px; display: block; }
		#sia-bptf-toggle.sia-bptf-off img { filter: grayscale(1); opacity: .35; }
		.sia-cur { width: 16px; height: 16px; vertical-align: text-bottom; margin: 0 1px 0 4px; }
		#tabcontent_inventory { position: relative; }
		#sia-value-top { position: absolute; top: 36px; right: 10px; z-index: 50;
			background: rgba(0, 0, 0, .4); border: 1px solid #262a2e;
			border-radius: 3px; padding: 6px 10px; text-align: right;
			color: #b8b6b4; font: 12px "Motiva Sans", Arial, sans-serif; }
		#sia-value-top .sia-vc-metal { color: #d5d3d1; white-space: nowrap; }
		#sia-value-top .sia-vc-money { color: #9CC83B; font-size: 16px; font-weight: bold;
			margin-top: 2px; display: flex; align-items: center; justify-content: flex-end; gap: 3px; }
		#sia-value-top .sia-vc-money img { width: 12px; height: 12px; }
		#sia-value-top .sia-vc-sub { color: #7a8b99; font-size: 10px; font-weight: normal; }
		#sia-value-top .sia-vc-trad { color: #E8A33D; font-size: 11px; margin-top: 2px;
			display: flex; align-items: center; justify-content: flex-end; gap: 3px; }
		#sia-value-top .sia-vc-trad img { width: 11px; height: 11px; }
		#sia-value-top .sia-vc-note { color: #777; font-size: 10px; margin-top: 2px; }
		.sia-progressbar { height: 3px; margin-top: 3px; border-radius: 2px;
			background: rgba(255,255,255,.12); overflow: hidden; }
		.sia-progressbar > div { height: 100%; background: #66c0f4; transition: width .5s; }
		.sia-vc-note { position: relative; cursor: default; }
		.sia-queue-tip { display: none; position: absolute; right: 0; top: 100%; z-index: 210;
			background: #3d4450; border: 1px solid #262a2e; border-radius: 3px;
			padding: 6px 10px; margin-top: 3px; text-align: left; white-space: nowrap;
			color: #c7d5e0; font-size: 11px; line-height: 1.5; }
		.sia-vc-note:hover .sia-queue-tip { display: block; }
		.sia-queue-tip .sia-tip-cur { color: #66c0f4; font-weight: bold; }
		.sia-stacked-holder { display: none !important; }
		.sia-count { position: absolute; right: 2px; top: 2px; z-index: 6; color: #FFD700;
			background: rgba(0, 0, 0, .55); border-radius: 2px; padding: 1px 3px;
			font: bold 11px/1 "Motiva Sans", Arial, sans-serif; pointer-events: none; }
		.sia-price { position: absolute; right: 2px; bottom: 1px; z-index: 6; color: #9CC83B;
			font: bold 9px/1 "Motiva Sans", Arial, sans-serif; display: flex;
			align-items: center; gap: 2px;
			text-shadow: 0 0 2px #000, 0 0 3px #000; pointer-events: none; }
		.sia-price img { width: 10px !important; height: 10px !important;
			flex: 0 0 10px; object-fit: contain; }
		.sia-bptf { position: absolute; right: 2px; bottom: 1px; z-index: 6; color: #E8A33D;
			font: bold 9px/1 "Motiva Sans", Arial, sans-serif; display: flex;
			align-items: center; gap: 2px;
			text-shadow: 0 0 2px #000, 0 0 3px #000; pointer-events: none; }
		.sia-bptf img { width: 10px !important; height: 10px !important;
			flex: 0 0 10px; object-fit: contain; }
		.sia-price.sia-pending { color: #777; }
		.sia-hide-bptf .sia-bptf { display: none; }
		.sia-panel-links .sia-qs { color: #9CC83B; font: bold 11px/16px Arial;
			text-decoration: none; white-space: nowrap; }
		.sia-panel-links { position: absolute; top: 10px; right: 44px; display: flex;
			gap: 8px; z-index: 10; }
		.sia-panel-links a img { width: 16px; height: 16px; opacity: .75; }
		.sia-panel-links a:hover img { opacity: 1; }
		.sia-panel-links .sia-addall { color: #9CC83B; font: bold 12px/16px Arial;
			text-decoration: none; }
		.sia-lock { position: absolute; left: 2px; top: 2px; z-index: 6; color: #fff;
			background: #CD3B3B; border-radius: 2px; padding: 2px 3px;
			font: bold 9px/1 "Motiva Sans", Arial, sans-serif; pointer-events: none; }
		#sia-settings { position: absolute; z-index: 200; background: #3d4450;
			border: 1px solid #262a2e; border-radius: 3px; padding: 10px 14px;
			color: #dcdedf; font: 12px "Motiva Sans", Arial, sans-serif;
			max-height: 420px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,.6); }
		#sia-settings label { display: block; margin: 4px 0; padding: 1px 4px; cursor: pointer; border-radius: 2px; }
		#sia-settings label:hover { background: #67c1f5; color: #16202d; }
		#sia-settings input[type=number] { width: 70px; }
		#sia-settings input[type=text] { width: 190px; }
		.item:has(.sia-lock) .sia-b .sia-row:first-child > span:first-child { margin-left: 22px; }
		${CONFIG.shrinkRenameWarning ? `.item .slot_app_fraudwarning {
			width: 12px !important; height: 12px !important;
			background-size: 12px 12px !important; }` : ''}
		/* trade offer message box: two lines by default, user-resizable */
		#trade_offer_note { resize: vertical; min-height: 34px; height: 34px; }
		.sia-break { flex-basis: 100%; height: 0; }
		/* game icon: bottom-right belongs to prices now; park it top-right */
		.trade_slot .slot_applogo { top: 2px !important; right: 2px !important;
			bottom: auto !important; left: auto !important; }
		/* the per-slot dropdown arrow menu (Item Wiki/Inspect) is dead weight */
		.slot_actionmenu_button { display: none !important; }
		.sia-side-summary { display: flex; justify-content: space-between; gap: 10px;
			align-items: center; min-height: 24px; padding: 4px 10px; margin: 3px 0;
			background: rgba(0, 0, 0, .35); border: 1px solid #262a2e;
			border-radius: 3px; color: #b8b6b4;
			font: 11px "Motiva Sans", Arial, sans-serif; }
		.sia-side-summary .sia-big { font-size: 15px; font-weight: bold; color: #fff; }
		#sia-bar-note { margin-left: auto; }
		#sia-bar-note .sia-vc-note { min-width: 120px; color: #777; font-size: 10px; }
	`;
	document.head.appendChild(style);

	// ------------------------------------------------------------------
	// Item helpers
	// ------------------------------------------------------------------

	// Inventory page assets look like {assetid, classid, description: {...}};
	// trade offer page items are old-style with descriptions/tags at top level.
	const descOf = (item) => (item && (item.description || item)) || null;

	// market-priceable: marketable now, or merely on a temporary trade/market hold
	// (held CS2 items still have real market prices for their type)
	const priceable = (d) => !!(d && d.market_hash_name && (d.marketable || lockDaysCached(d) > 0));

	const descLines = (d) =>
		(d.descriptions || []).map((x) => String(x.value || '').replace(/<[^>]*>/g, '').trim());

	// "Tradable After: Monday, July 27, 2026 (7:00:00) GMT" -> days remaining
	function lockDaysOf(d) {
		if (d.cache_expiration) { // CS2 ships the hold end as an ISO timestamp
			const days = Math.ceil((Date.parse(d.cache_expiration) - Date.now()) / 864e5);
			if (days > 0) return days;
		}
		const all = [...(d.descriptions || []), ...(d.owner_descriptions || [])];
		for (const x of all) {
			const m = String(x.value || '').match(/Tradable(?:\s*[&\/]\s*Marketable)? After:?\s*(.+)/i);
			if (!m) continue;
			const ts = Date.parse(m[1].trim().replace(/\((.*?)\)/, '$1'));
			if (!Number.isNaN(ts)) {
				const days = Math.ceil((ts - Date.now()) / 864e5);
				if (days > 0) return days;
			}
		}
		return 0;
	}

	function tf2Info(d) {
		const lines = descLines(d);
		const info = {
			effect: null, ks: null, spells: 0,
			festivized: false, series: null,
			uncraftable: false, untradable: d.tradable === 0 || d.tradable === false,
		};

		for (const line of lines) {
			let m;
			if ((m = line.match(/^★ Unusual Effect: (.+)$/))) info.effect = m[1];
			else if (/^\(?Killstreaker: /.test(line)) info.ks = 'PK';
			else if (/^\(?Sheen: /.test(line) && info.ks !== 'PK') info.ks = info.ks || 'SK';
			else if (/^Killstreaks Active/.test(line)) info.ks = info.ks || 'K';
			else if (/\(spell only active during event\)/.test(line)) info.spells++;
			else if (line === 'Festivized') info.festivized = true;
			else if ((m = line.match(/Crate Series #(\d+)/))) info.series = m[1];
			else if (/Usable in Crafting/.test(line)) info.uncraftable = true;
			if (/Not Tradable/.test(line)) info.untradable = true;
		}

		// Kit/fabricator names carry the tier even when desc lines are missing
		const name = d.market_hash_name || d.name || '';
		if (!info.ks) {
			if (/^Professional Killstreak /.test(name)) info.ks = 'PK';
			else if (/^Specialized Killstreak /.test(name)) info.ks = 'SK';
			else if (/^Killstreak /.test(name)) info.ks = 'K';
		}
		return info;
	}

	function badge(cls, text, title) {
		const el = document.createElement('span');
		el.className = `sia-tag ${cls}`;
		el.textContent = text;
		if (title) el.title = title;
		return el;
	}

	function augment(el) {
		const item = el.rgItem;
		if (!item) return; // element not wired up by Steam yet; retry on next scan
		el.dataset.sia = '1';

		const d = descOf(item);
		if (!d) return;

		// trade-locked = temporary; show countdown instead of the red untradable bar
		const lockDays = CONFIG.tradeLockBadge ? lockDaysCached(d) : 0;
		if (lockDays > 0 && !el.querySelector('.sia-lock')) {
			const lock = document.createElement('span');
			lock.className = 'sia-lock';
			lock.textContent = `${lockDays}D`;
			lock.title = `Tradable in ${lockDays} day${lockDays > 1 ? 's' : ''}`;
			el.appendChild(lock);
		}
		if (lockDays <= 0 && CONFIG.markUntradable &&
			(d.tradable === 0 || d.tradable === false)) {
			el.classList.add('sia-untrade');
		}

		if (CONFIG.priceIndicator && priceable(d)) {
			requestPrice(el, d);
		}

		if (String(d.appid) !== '440' || !CONFIG.tf2Badges) return;

		const info = tf2Info(d);

		if (CONFIG.markUncraftable && info.uncraftable) el.classList.add('sia-uncraft');
		if (CONFIG.markUntradable && info.untradable && lockDays <= 0) el.classList.add('sia-untrade');

		// bp.tf ref value: own badge for unmarketable items, tooltip data otherwise;
		// permanently untradable items don't need a value — they can't move anyway
		if (bptf && !el.dataset.siaBptf && !el.querySelector('.sia-bptf') &&
			!(info.untradable && lockDays <= 0) &&
			!/^(Refined|Reclaimed|Scrap) Metal$/.test(d.name || '')) {
			const rv = bptfRefOf(d, info);
			if (rv != null) {
				el.dataset.siaBptf = String(rv);
				if (!(d.marketable && d.market_hash_name)) {
					const span = document.createElement('span');
					span.className = 'sia-bptf';
					const ico = document.createElement('img');
					ico.src = BPTF_ICON;
					// inline-lock the size: Steam CSS occasionally beats the stylesheet
					ico.style.cssText = 'width:10px !important;height:10px !important;flex:0 0 10px;object-fit:contain';
					span.append(ico, formatRef(rv));
					span.title = `backpack.tf: ${rv} ref`;
					el.appendChild(span);
				} else {
					// marketable: show bp.tf value while the market price loads
					const pending = el.querySelector('.sia-price.sia-pending');
					if (pending) {
						pending.textContent = formatRef(rv);
						pending.title = `backpack.tf: ${rv} ref · market price loading…`;
					}
				}
			}
		}

		const hasBadge = info.effect || info.ks || info.spells || info.series;
		if (!hasBadge || el.querySelector('.sia-b')) return;

		const wrap = document.createElement('div');
		wrap.className = 'sia-b';
		const top = document.createElement('div');
		const bottom = document.createElement('div');
		top.className = bottom.className = 'sia-row';
		const tl = document.createElement('span'), tr = document.createElement('span');
		const bl = document.createElement('span'), br = document.createElement('span');
		top.append(tl, tr);
		bottom.append(bl, br);
		wrap.append(top, bottom);

		if (info.effect) tl.append(badge('sia-star', '★', `Unusual: ${info.effect}`));
		if (info.spells) tr.append(badge('', info.spells > 1 ? `🎃${info.spells}` : '🎃', 'Spelled'));
		if (info.series) bl.append(badge('sia-series', `#${info.series}`, `Crate Series #${info.series}`));
		if (info.ks) bl.append(badge('sia-ks', info.ks === 'K' ? 'KS' : info.ks,
			{ K: 'Killstreak', SK: 'Specialized Killstreak', PK: 'Professional Killstreak' }[info.ks]));

		el.appendChild(wrap);
	}

	// ------------------------------------------------------------------
	// backpack.tf pricing — daily dump reduced to name -> {quality+craft: refined}
	// ------------------------------------------------------------------
	const BPTF_LS_KEY = 'siaBptf';
	let bptf = null;
	try { bptf = JSON.parse(localStorage.getItem(BPTF_LS_KEY)); } catch { /* fresh */ }

	const BPTF_QUALITY = {
		Normal: 0, Genuine: 1, Vintage: 3, Unusual: 5, Unique: 6, Community: 7,
		Valve: 8, 'Self-Made': 9, Strange: 11, Haunted: 13, "Collector's": 14,
		'Decorated Weapon': 15,
	};

	// unusual effect name -> schema id (bp.tf keys unusual prices by this)
	const EFFECT_IDS = {
		'Green Confetti': 6, 'Purple Confetti': 7, 'Haze': 8, 'Green Energy': 9,
		'Purple Energy': 10, 'Circling TF Logo': 11, 'Massed Flies': 12,
		'Burning Flames': 13, 'Scorching Flames': 14, 'Searing Plasma': 15,
		'Vivid Plasma': 16, 'Sunbeams': 17, 'Circling Peace Sign': 18,
		'Circling Heart': 19, 'Stormy Storm': 29, 'Blizzardy Storm': 30,
		'Nuts n\' Bolts': 31, 'Orbiting Planets': 32, 'Orbiting Fire': 33,
		'Bubbling': 34, 'Smoking': 35, 'Steaming': 36, 'Flaming Lantern': 37,
		'Cloudy Moon': 38, 'Cauldron Bubbles': 39, 'Eerie Orbiting Fire': 40,
		'Knifestorm': 43, 'Misty Skull': 44, 'Harvest Moon': 45,
		"It's A Secret To Everybody": 46, 'Stormy 13th Hour': 47,
		'Kill-a-Watt': 56, 'Terror-Watt': 57, 'Cloud 9': 58, 'Aces High': 59,
		'Dead Presidents': 60, 'Miami Nights': 61, 'Disco Beat Down': 62,
		'Phosphorous': 63, 'Sulphurous': 64, 'Memory Leak': 65, 'Overclocked': 66,
		'Electrostatic': 67, 'Power Surge': 68, 'Anti-Freeze': 69, 'Time Warp': 70,
		'Green Black Hole': 71, 'Roboactive': 72, 'Arcana': 73, 'Spellbound': 74,
		'Chiroptera Venenata': 75, 'Poisoned Shadows': 76,
		'Something Burning This Way Comes': 77, 'Hellfire': 78, 'Darkblaze': 79,
		'Demonflame': 80, 'Bonzo The All-Gnawing': 81, 'Amaranthine': 82,
		'Stare From Beyond': 83, 'The Ooze': 84, 'Ghastly Ghosts Jr': 85,
		'Haunted Phantasm Jr': 86, 'Frostbite': 87, 'Molten Mallard': 88,
		'Morning Glory': 89, 'Death at Dusk': 90,
		'Showstopper': 3001, 'Holy Grail': 3003, "'72": 3004,
		'Fountain of Delight': 3005, 'Screaming Tiger': 3006,
		'Skill Gotten Gains': 3007, 'Midnight Whirlwind': 3008,
		'Silver Cyclone': 3009, 'Mega Strike': 3010, 'Haunted Phantasm': 3011,
		'Ghastly Ghosts': 3012,
	};

	// Steam's CSP blocks page-context fetches to other hosts; go through the
	// a privileged request channel when available
	const gmFetchText = (url) => new Promise((resolve) => {
		const gmReq = (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
			(typeof GM !== 'undefined' && GM.xmlHttpRequest);
		if (gmReq) {
			gmReq({
				method: 'GET',
				url,
				onload: (r) => resolve(r.responseText),
				onerror: () => resolve(null),
				ontimeout: () => resolve(null),
			});
		} else {
			fetch(url).then((r) => r.text()).then(resolve, () => resolve(null));
		}
	});

	const bpFetchJson = async (url) => {
		const txt = await gmFetchText(url);
		try { return JSON.parse(txt); } catch { return null; }
	};

	async function refreshBptf() {
		if (!CONFIG.backpackTfKey) return;
		if (bptf && Date.now() - bptf.t < 24 * 3600e3) return;
		try {
			const [curJson, priceJson] = await Promise.all([
				bpFetchJson(`https://backpack.tf/api/IGetCurrencies/v1?key=${CONFIG.backpackTfKey}`),
				bpFetchJson(`https://backpack.tf/api/IGetPrices/v4?raw=1&key=${CONFIG.backpackTfKey}`),
			]);
			const cur = curJson?.response;
			const prices = priceJson?.response;
			if (!cur?.success || !prices?.success) return;
			const items = {};
			for (const [name, data] of Object.entries(prices.items || {})) {
				const out = {};
				for (const [q, byTradable] of Object.entries(data.prices || {})) {
					const byCraft = byTradable.Tradable;
					if (!byCraft) continue;
					for (const [craft, entry] of Object.entries(byCraft)) {
						const ck = craft === 'Craftable' ? 'c' : 'u';
						if (Array.isArray(entry)) {
							if (entry[0]?.value_raw != null) out[q + ck] = Math.round(entry[0].value_raw * 100) / 100;
						} else if (entry && typeof entry === 'object') {
							// keyed by priceindex: crate series / unusual effect id
							const sub = {};
							for (const [idx, e] of Object.entries(entry)) {
								if (e?.value_raw != null) sub[idx] = Math.round(e.value_raw * 100) / 100;
							}
							if (Object.keys(sub).length) out[q + ck + 'x'] = sub;
						}
					}
				}
				if (Object.keys(out).length) items[name] = out;
			}
			bptf = {
				t: Date.now(),
				keyRefined: cur.currencies?.keys?.price?.value ?? null,
				items,
			};
			try { localStorage.setItem(BPTF_LS_KEY, JSON.stringify(bptf)); } catch { /* quota */ }
			// re-augment so already-scanned items pick up bp.tf values
			document.querySelectorAll('.item[data-sia]').forEach((el) => {
				if (!el.querySelector('.sia-bptf') && !el.dataset.siaBptf) delete el.dataset.sia;
			});
			valEpoch++;
			queueScan();
			resortIfNeeded();
		} catch { /* bp.tf unreachable or bad key; retry next session */ }
	}

	// bp.tf keys items by schema base name: no "The", no quality/killstreak/
	// festivized prefixes, no wear suffix — try progressively stripped candidates
	function bptfRecOf(d) {
		if (!bptf?.items) return null;
		const seen = new Set();
		const candidates = [];
		const push = (n) => { if (n && !seen.has(n)) { seen.add(n); candidates.push(n); } };
		for (const raw of [d.market_hash_name, d.name]) {
			if (!raw) continue;
			let n = String(raw);
			push(n);
			n = n.replace(/^(Strange|Vintage|Genuine|Haunted|Collector's|Normal|Unusual) /, '');
			push(n);
			n = n.replace(/^Festivized /, '')
				.replace(/^(Professional Killstreak|Specialized Killstreak|Killstreak) /, '');
			push(n);
			push(n.replace(/^The /, ''));
			push(n.replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle Scarred)\)$/, ''));
		}
		for (const n of candidates) {
			if (bptf.items[n]) return bptf.items[n];
		}
		return null;
	}

	// refined value for a TF2 description, or null
	function bptfRefOf(d, info) {
		const rec = bptfRecOf(d);
		if (!rec) return null;
		const q = BPTF_QUALITY[tagName(tagOf(d, 'Quality'))] ?? 6;
		const ck = info?.uncraftable ? 'u' : 'c';
		// unusuals are priced per effect id
		if (q === 5) {
			const id = info?.effect != null ? EFFECT_IDS[info.effect] : null;
			return (id != null ? rec['5cx']?.[id] : null) ?? null;
		}
		let v = rec[q + ck];
		if (v == null && info?.series) v = rec[q + ck + 'x']?.[info.series];
		if (v == null && ck === 'u') v = rec[q + 'c'];
		return v ?? null;
	}

	const formatRef = (rv) => {
		if (bptf?.keyRefined && rv >= bptf.keyRefined) {
			return (rv / bptf.keyRefined).toFixed(1) + ' keys';
		}
		return (rv >= 100 ? Math.round(rv) : rv.toFixed(2)) + ' ref';
	};

	// ------------------------------------------------------------------
	// Trade draft saver — your side survives a closed window
	// ------------------------------------------------------------------
	const tradePartnerKey = () =>
		'siaDraft_' + ((new URLSearchParams(location.search)).get('partner') ||
			String(location.pathname.match(/tradeoffer\/(\w+)/)?.[1] || 'x'));

	function saveDraft() {
		if (!CONFIG.draftSaver || !document.getElementById('trade_yours')) return;
		const ids = [...document.querySelectorAll('#your_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)).filter(Boolean);
		try {
			if (ids.length) localStorage.setItem(tradePartnerKey(), JSON.stringify(ids));
		} catch { /* quota */ }
	}

	function ensureDraftButton(bar) {
		if (!CONFIG.draftSaver || !document.getElementById('trade_yours')) return;
		if (document.getElementById('sia-draft') ||
			document.querySelectorAll('#your_slots .item').length) return;
		let ids = [];
		try { ids = JSON.parse(localStorage.getItem(tradePartnerKey())) || []; } catch { /* none */ }
		if (!ids.length) return;
		const btn = document.createElement('button');
		btn.id = 'sia-draft';
		btn.type = 'button';
		btn.textContent = `🕐${ids.length}`;
		btn.title = `Restore draft: put your last ${ids.length} selected items back into the trade`;
		btn.addEventListener('click', () => {
			const inv = W.g_ActiveInventory;
			const assets = (inv && (inv.rgInventory || inv.m_rgAssets)) || {};
			for (const id of ids) {
				const a = assets[id];
				if (a && a.element) moveToTradeSafe(a.element);
			}
			afterTradeBatch();
			btn.remove();
		});
		bar.appendChild(btn);
	}

	// ------------------------------------------------------------------
	// Update checker — daily, only when updateURL is set
	// ------------------------------------------------------------------
	async function checkForUpdate() {
		if (!CONFIG.updateURL) return;
		const last = +localStorage.getItem('siaUpdateChecked') || 0;
		if (Date.now() - last < 86400e3) return;
		localStorage.setItem('siaUpdateChecked', String(Date.now()));
		const txt = await gmFetchText(CONFIG.updateURL);
		const remote = txt?.match(/@version\s+([\d.]+)/)?.[1];
		const local = (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0';
		if (!remote) return;
		const cmp = (a, b) => {
			const A = a.split('.').map(Number), B = b.split('.').map(Number);
			for (let i = 0; i < 3; i++) {
				const d = (A[i] || 0) - (B[i] || 0);
				if (d) return d;
			}
			return 0;
		};
		if (cmp(remote, local) <= 0) return;
		const bar = document.getElementById('sia-bar');
		if (bar && !document.getElementById('sia-update')) {
			const a = document.createElement('a');
			a.id = 'sia-update';
			a.href = CONFIG.updateURL;
			a.target = '_blank';
			a.textContent = `Update ${remote} available`;
			a.style.color = '#FFD700';
			bar.appendChild(a);
		}
	}

	// ------------------------------------------------------------------
	// Price indicator — per-item queue with cooldown, cached in localStorage
	// ------------------------------------------------------------------
	const PRICE_LS_KEY = 'siaPriceCache';
	let priceCache = {};
	try { priceCache = JSON.parse(localStorage.getItem(PRICE_LS_KEY)) || {}; } catch { /* fresh */ }
	const savePriceCache = () => {
		try { localStorage.setItem(PRICE_LS_KEY, JSON.stringify(priceCache)); } catch { /* full */ }
	};

	const priceQueue = [];
	const priceQueued = new Set();
	let pricePumpRunning = false;
	let priceCurrentJob = null; // mhn being fetched right now, for the hover list
	let priceBackoffUntil = 0;  // 429 cool-off deadline, shown in the progress note

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// "$1.23" / "1,23₺" / "1.250,50 pуб." -> number (2-digit tail = decimals)
	function parsePrice(s) {
		const cleaned = String(s || '').replace(/[^\d.,]/g, '');
		if (!cleaned) return NaN;
		const dec = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
		if (dec === -1) return Number(cleaned);
		const frac = cleaned.slice(dec + 1).replace(/\D/g, '');
		const intDigits = cleaned.slice(0, dec).replace(/\D/g, '');
		return frac.length === 2
			? Number(intDigits) + Number(frac) / 100
			: Number(intDigits + frac);
	}

	const cachedPriceOf = (d) => {
		const rec = priceCache[`${d.appid}||${d.market_hash_name}`];
		return rec ? parsePrice(rec.lp || rec.mp) : NaN;
	};

	// cheap items live on a slow refresh cycle; everything else on the fast one
	const priceFresh = (rec) => {
		if (!rec) return false;
		const n = parsePrice(rec.lp || rec.mp);
		const mins = (!Number.isNaN(n) && n <= CONFIG.cheapPriceThreshold)
			? CONFIG.cheapPriceCacheMins
			: CONFIG.priceCacheMins;
		return (Date.now() - rec.t) < mins * 60000;
	};

	// after the main queue drains, quietly re-queue stale visible items —
	// oldest first, cheapest last
	let lastStaleSweep = 0;
	function refreshStalePrices() {
		if (pricePumpRunning || priceQueue.length) return;
		if (Date.now() - lastStaleSweep < 5 * 60000) return;
		lastStaleSweep = Date.now();
		const jobs = [];
		for (const el of document.querySelectorAll('[data-sia-pk]')) {
			const key = el.dataset.siaPk;
			const rec = priceCache[key];
			if (!rec || priceFresh(rec) || priceQueued.has(key)) continue;
			const n = parsePrice(rec.lp || rec.mp);
			const cheap = !Number.isNaN(n) && n <= CONFIG.cheapPriceThreshold;
			const [appid, mhn] = key.split('||');
			priceQueued.add(key);
			jobs.push({ key, appid, mhn, cheap, t: rec.t });
		}
		jobs.sort((a, b) => (a.cheap - b.cheap) || (a.t - b.t));
		priceQueue.push(...jobs);
		if (jobs.length) pumpPrices();
	}

	function renderPrice(el, rec) {
		let text = rec.lp || rec.mp;
		if (!text) return;
		let span = el.querySelector('.sia-price');
		if (!span) {
			span = document.createElement('span');
			span.className = 'sia-price';
			el.appendChild(span);
		}
		span.classList.remove('sia-pending');
		// optionally show the highest buy order — the instant-sell value
		if (CONFIG.showBuyOrders && rec.bo) {
			text = fmtMoney(rec.bo, rec.lp || rec.mp || '$');
		}
		span.innerHTML = '';
		const ico = document.createElement('img');
		ico.src = STEAM_ICON;
		ico.style.cssText = 'width:10px !important;height:10px !important;flex:0 0 10px;object-fit:contain';
		span.append(ico, text);
		span.title = (rec.bo ? `Buy order: ${fmtMoney(rec.bo, rec.lp || rec.mp || '$')} · ` : '') +
			`Lowest: ${rec.lp || '?'} · Median: ${rec.mp || '?'}` +
			(el.dataset.siaBptf ? ` · bp.tf: ${el.dataset.siaBptf} ref` : '');
	}

	// Valve market fee math: buyer pays net + 5% (min 1¢) + 10% (min 1¢)
	const marketFees = (net) => Math.max(1, Math.floor(net * 0.05)) + Math.max(1, Math.floor(net * 0.10));
	function sellerNetCents(grossCents) {
		let net = Math.floor(grossCents / 1.15);
		while (net > 1 && net + marketFees(net) > grossCents) net--;
		while (net + 1 + marketFees(net + 1) <= grossCents) net++;
		return Math.max(1, net);
	}

	function rerenderAllPrices() {
		document.querySelectorAll('[data-sia-pk]').forEach((el) => {
			const rec = priceCache[el.dataset.siaPk];
			if (rec) renderPrice(el, rec);
		});
	}

	let keyPriceQueued = false;
	function ensureKeyPrice() {
		// the key's market price anchors currency->ref conversion for value sorts
		if (!CONFIG.priceIndicator || keyPriceQueued) return;
		const key = '440||Mann Co. Supply Crate Key';
		if (priceFresh(priceCache[key]) || priceQueued.has(key)) { keyPriceQueued = true; return; }
		keyPriceQueued = true;
		priceQueued.add(key);
		priceQueue.unshift({ key, appid: 440, mhn: 'Mann Co. Supply Crate Key' });
		pumpPrices();
	}

	function requestPrice(el, d) {
		const key = `${d.appid}||${d.market_hash_name}`;
		el.dataset.siaPk = key;
		const rec = priceCache[key];
		if (priceFresh(rec)) {
			renderPrice(el, rec);
			// fresh price but buy order still missing: queue an orderbook backfill
			if (!(CONFIG.showBuyOrders && rec.bo == null && (rec.lp || rec.mp))) return;
		}
		// grey placeholder so it's visible the price is still loading
		if (!el.querySelector('.sia-price')) {
			const span = document.createElement('span');
			span.className = 'sia-price sia-pending';
			span.textContent = '…';
			span.title = 'Fetching market price…';
			el.appendChild(span);
		}
		if (!priceQueued.has(key)) {
			priceQueued.add(key);
			priceQueue.push({ key, appid: d.appid, mhn: d.market_hash_name });
		}
		pumpPrices();
	}

	async function pumpPrices() {
		if (pricePumpRunning) return;
		pricePumpRunning = true;
		let fetched = 0;
		try {
		while (priceQueue.length) {
			if (document.hidden) { await sleep(5000); continue; } // don't burn quota in background
			const job = priceQueue.shift();
			priceCurrentJob = job.mhn;
			try {
				// backfill-only job: price is fresh, just the buy order is missing
				const cachedRec = priceCache[job.key];
				// cheap junk doesn't need a buy-order request — mark checked
				if (CONFIG.showBuyOrders && cachedRec && cachedRec.bo == null) {
					const n0 = parsePrice(cachedRec.lp || cachedRec.mp);
					if (!Number.isNaN(n0) && n0 <= CONFIG.cheapPriceThreshold) cachedRec.bo = 0;
				}
				if (CONFIG.showBuyOrders && priceFresh(cachedRec) &&
					cachedRec.bo == null && (cachedRec.lp || cachedRec.mp)) {
					const ob = await fetchOrderbook(job.appid, job.mhn).catch(() => null);
					cachedRec.bo = ob?.buyCents ? ob.buyCents / 100 : 0; // 0 = checked, none
					savePriceCache();
					document.querySelectorAll(`[data-sia-pk="${CSS.escape(job.key)}"]`)
						.forEach((el2) => renderPrice(el2, cachedRec));
					priceQueued.delete(job.key);
					fetched++;
					await sleep(CONFIG.priceCooldownMs);
					continue;
				}
				const currency = W.g_rgWalletInfo?.wallet_currency || 1;
				const res = await fetch(`/market/priceoverview/?appid=${job.appid}` +
					`&currency=${currency}&market_hash_name=${encodeURIComponent(job.mhn)}`,
					{ credentials: 'same-origin' });
				if (res.status === 429) {
					priceQueue.unshift(job); // rate limited: retry after a minute
					priceBackoffUntil = Date.now() + 60000;
					await sleep(60000);
					priceBackoffUntil = 0;
					continue;
				}
				const j = res.ok ? await res.json() : null;
				// cache misses too (success:false = not on market) so we don't refetch them
				const rec = { lp: j?.lowest_price || null, mp: j?.median_price || null, t: Date.now() };
				// buy-order mode: one extra order-book request per item, same pacing;
				// cheap junk skips it — its buy order is a cent anyway
				if (CONFIG.showBuyOrders && (rec.lp || rec.mp)) {
					const n1 = parsePrice(rec.lp || rec.mp);
					if (!Number.isNaN(n1) && n1 <= CONFIG.cheapPriceThreshold) {
						rec.bo = 0;
					} else {
						await sleep(CONFIG.priceCooldownMs);
						const ob = await fetchOrderbook(job.appid, job.mhn).catch(() => null);
						rec.bo = ob?.buyCents ? ob.buyCents / 100 : 0; // 0 = checked, none
					}
				}
				priceCache[job.key] = rec;
				savePriceCache();
				priceQueued.delete(job.key); // allow future stale refreshes
				fetched++;
				if (job.mhn === 'Mann Co. Supply Crate Key') {
					valEpoch++; // the key rate anchors every currency->ref conversion
					rerenderAllPrices();
				} else {
					document.querySelectorAll(`[data-sia-pk="${CSS.escape(job.key)}"]`)
						.forEach((el) => renderPrice(el, rec));
				}
			} catch { /* network hiccup — item gets rediscovered next scan */ }
			await sleep(CONFIG.priceCooldownMs);
		}
		} finally {
			// whatever happens, the pump must be restartable — a stuck flag
			// freezes the queue and the progress bar forever
			pricePumpRunning = false;
			priceCurrentJob = null;
			priceBackoffUntil = 0;
		}
		// prices changed the ordering data: keep an active price sort truthful
		if (fetched) resortIfNeeded();
	}

	function resortIfNeeded() {
		// only the price sort depends on fetched data; name/type/quality never
		// change, and a full relayout of a big inventory is expensive
		const key = document.getElementById('sia-sort')?.value;
		if (key === 'price' && !document.hidden) runLayout();
	}

	// ------------------------------------------------------------------
	// Scanner — covers inventory pages and both sides of trade offers
	// ------------------------------------------------------------------
	function iconLink(href, src, title) {
		const a = document.createElement('a');
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		a.title = title;
		const img = document.createElement('img');
		img.src = src;
		a.appendChild(img);
		return a;
	}

	// bp.tf + market icons on the selected-item info panel (React mount #iteminfoN)
	function injectPanelLinks() {
		if (!CONFIG.panelLinks) return;
		const sel = W.g_ActiveInventory?.selectedItem;
		if (!sel) return;
		const d = descOf(sel);
		if (!d) return;
		for (const id of ['iteminfo0', 'iteminfo1']) {
			const panel = document.getElementById(id);
			if (!panel || panel.style.display === 'none' || !panel.firstElementChild?.firstElementChild) continue;
			let box = panel.querySelector('.sia-panel-links');
			if (!box) {
				box = document.createElement('div');
				box.className = 'sia-panel-links';
				panel.appendChild(box);
			}
			const selId = String(sel.assetid || sel.id || d.market_hash_name || d.name);
			if (box.dataset.for === selId) continue;
			box.dataset.for = selId;
			box.innerHTML = '';
			// selected item jumps the price queue
			if (d.market_hash_name) {
				const qi = priceQueue.findIndex((j) => j.key === `${d.appid}||${d.market_hash_name}`);
				if (qi > 0) priceQueue.unshift(priceQueue.splice(qi, 1)[0]);
			}
			if (String(d.appid) === '440') {
				const base = (d.market_hash_name || d.name || '')
					.replace(/^(Strange|Vintage|Genuine|Haunted|Collector's|Normal|Unusual) /, '');
				const q = tagName(tagOf(d, 'Quality')) || 'Unique';
				const info = tf2Info(d);
				let stats = `https://backpack.tf/stats/${encodeURIComponent(q)}/` +
					`${encodeURIComponent(base)}/Tradable/${info.uncraftable ? 'Non-Craftable' : 'Craftable'}`;
				if (info.series) stats += `/${info.series}`;
				box.appendChild(iconLink(stats, BPTF_ICON, 'backpack.tf price history'));
			}
			const mkt = d.marketable && d.market_hash_name
				? `https://steamcommunity.com/market/listings/${d.appid}/${encodeURIComponent(d.market_hash_name)}`
				: `https://steamcommunity.com/market/search?appid=${d.appid}&q=${encodeURIComponent(d.name || '')}`;
			box.appendChild(iconLink(mkt, MARKET_ICON, 'Steam market'));

			if (canQuicksell(d)) addQuicksellButton(box, sel, d);

			// "Add all N" on trade pages when you own several copies
			if (document.getElementById('trade_yours')) {
				const copies = copiesOf(sel);
				if (copies.length > 1) {
					const btn = document.createElement('a');
					btn.href = 'javascript:void(0)';
					btn.className = 'sia-addall';
					btn.textContent = `+${copies.length}`;
					btn.title = `Add all ${copies.length} copies to the trade`;
					btn.addEventListener('click', () => {
						copiesOf(sel).forEach((a) => moveToTradeSafe(a.element));
						afterTradeBatch();
					});
					box.appendChild(btn);
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// Quicksell — list at instant-sell (highest buy order)
	// or undercut (lowest listing − 0.01). Own inventory, logged in only.
	// ------------------------------------------------------------------
	const canQuicksell = (d) =>
		CONFIG.quicksellButtons && W.g_sessionID && d.marketable && d.market_hash_name &&
		!document.getElementById('trade_yours') &&
		String(W.g_steamID || '') !== '' &&
		String(W.g_ActiveInventory?.m_steamid || W.g_rgProfileData?.steamid || W.g_steamID) === String(W.g_steamID);

	async function fetchOrderbook(appid, mhn) {
		const params = new URLSearchParams();
		params.set('q', 'Load');
		params.set('qp', JSON.stringify([Number(appid), mhn]));
		const res = await fetch('/market/orderbook?' + params.toString(), {
			credentials: 'same-origin',
			headers: { 'X-Requested-With': 'SIAModern', 'X-Valve-Request-Type': 'queryAction' },
		});
		if (!res.ok) return null;
		const j = await res.json().catch(() => null);
		if (!j?.success || !j.data) return null;
		const d = j.data;
		// live shape (2026): amtMaxBuyOrder / amtMinSellOrder in cents,
		// eCurrency matches the requester's wallet; older field names as fallback
		const buy = Number(d.amtMaxBuyOrder) || Number(d.highest_buy_order) || 0;
		const sell = Number(d.amtMinSellOrder) || Number(d.lowest_sell_order) || 0;
		return { buyCents: buy, sellCents: sell };
	}

	async function listOnMarket(item, grossCents, label) {
		const d = descOf(item);
		const net = sellerNetCents(grossCents);
		const ok = confirm(`List "${d.name}" at ${(grossCents / 100).toFixed(2)} (${label})?\n` +
			`You receive ${(net / 100).toFixed(2)} after fees.`);
		if (!ok) return;
		const body = new URLSearchParams({
			sessionid: W.g_sessionID,
			appid: String(item.appid || d.appid),
			contextid: String(item.contextid || '2'),
			assetid: String(item.assetid || item.id),
			amount: '1',
			price: String(net),
		});
		try {
			const res = await fetch('https://steamcommunity.com/market/sellitem/', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
			const j = await res.json().catch(() => null);
			if (j?.success) {
				const extra = j.requires_confirmation || j.needs_mobile_confirmation || j.needs_email_confirmation
					? ' Confirm the listing in your Steam app/email.' : '';
				(W.ShowAlertDialog || ((t, m) => alert(m)))('Listed', `Listing created.${extra}`);
				if (item.element) item.element.style.opacity = '.35';
			} else {
				(W.ShowAlertDialog || ((t, m) => alert(m)))('Listing failed',
					j?.message || 'Steam rejected the listing (rate limit or trade restrictions).');
			}
		} catch {
			(W.ShowAlertDialog || ((t, m) => alert(m)))('Listing failed', 'Network error.');
		}
	}

	function addQuicksellButton(box, item, d) {
		const trigger = document.createElement('a');
		trigger.href = 'javascript:void(0)';
		trigger.className = 'sia-qs';
		trigger.textContent = '⚡';
		trigger.title = 'Quicksell: fetch buy orders and list this item';
		trigger.addEventListener('click', async () => {
			trigger.textContent = '…';
			const ob = await fetchOrderbook(d.appid, d.market_hash_name);
			trigger.remove();
			if (!ob || (!ob.buyCents && !ob.sellCents)) {
				box.appendChild(Object.assign(document.createElement('span'),
					{ className: 'sia-qs', textContent: 'no orders' }));
				return;
			}
			if (ob.buyCents) {
				const b = trigger.cloneNode();
				b.textContent = `⚡${(ob.buyCents / 100).toFixed(2)}`;
				b.title = 'Instant: list at the highest buy order';
				b.addEventListener('click', () => listOnMarket(item, ob.buyCents, 'instant'));
				box.appendChild(b);
			}
			if (ob.sellCents > 1) {
				const u = trigger.cloneNode();
				u.textContent = `↓${((ob.sellCents - 1) / 100).toFixed(2)}`;
				u.title = 'Undercut: list 0.01 under the lowest listing';
				u.addEventListener('click', () => listOnMarket(item, ob.sellCents - 1, 'undercut'));
				box.appendChild(u);
			}
		});
		box.appendChild(trigger);
	}

	// all copies (same stack key) of an item in the active inventory, not yet in trade
	function copiesOf(item) {
		const inv = W.g_ActiveInventory;
		const assets = Object.values((inv && (inv.m_rgAssets || inv.rgInventory)) || {});
		const key = stackKeyOf(item);
		const inTrade = new Set([...document.querySelectorAll('#your_slots .item, #their_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)));
		return assets.filter((a) => a && a.element && stackKeyOf(a) === key &&
			!inTrade.has(a.id || a.assetid));
	}

	// when items move in/out of trade slots while stacking is on, the stacked
	// layout goes stale (copies reappear unmerged) — re-apply it
	let lastSlotSig = '';
	function checkTradeSlots() {
		if (!document.getElementById('trade_yours')) return;
		const sig = [...document.querySelectorAll('#your_slots .item, #their_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)).join(',');
		if (sig !== lastSlotSig) {
			lastSlotSig = sig;
			if (stackOn) runLayout();
			updateTradeCompare();
			saveDraft();
		}
	}

	// price the items the user is actually looking at first; re-rank on page change
	let lastPageSig = '';
	function prioritizePriceQueue() {
		if (!priceQueue.length) return;
		const invEl = getActiveInvEl();
		if (!invEl) return;
		const visible = new Set();
		for (const p of invEl.querySelectorAll('.inventory_page')) {
			if (p.style.display === 'none') continue;
			for (const el of p.querySelectorAll('.item[data-sia-pk]')) visible.add(el.dataset.siaPk);
		}
		if (!visible.size) return;
		const sig = [...visible].join(',');
		if (sig === lastPageSig) return;
		lastPageSig = sig;
		priceQueue.sort((a, b) => (visible.has(b.key) ? 1 : 0) - (visible.has(a.key) ? 1 : 0));
	}

	// stacking artifacts (×N badges, hidden holders, stashed engine arrays) must
	// never survive with the toggle off — tab switches on trade pages can race
	// the normal cleanup, so self-heal on every scan
	function healStackState() {
		if (stackOn) return;
		const leftovers = document.querySelector('.sia-count, .sia-stacked-holder');
		const inv = W.g_ActiveInventory;
		const stashed = inv && v2Stashes.has(inv);
		if (!leftovers && !stashed) return;
		clearStackBadges();
		document.querySelectorAll('.sia-stacked-holder').forEach((h) => {
			h.classList.remove('sia-stacked-holder');
		});
		document.querySelectorAll('[data-sia-stacked]').forEach((h) => {
			delete h.dataset.siaStacked;
			h.filtered = false;
			h.style.display = '';
		});
		if (stashed) runLayout(); // restores the engine arrays + repaginates
	}

	let scanQueued = false;
	function scan() {
		scanQueued = false;
		document.querySelectorAll('.item:not([data-sia])').forEach(augment);
		healStackState();
		if (priceQueue.length && !pricePumpRunning) pumpPrices(); // self-restart
		ensureKeyPrice();
		injectPanelLinks();
		checkTradeSlots();
		prioritizePriceQueue();
		refreshStalePrices();
		updateBarThrottled();
	}
	function queueScan() {
		if (scanQueued) return;
		scanQueued = true;
		setTimeout(scan, 250);
	}

	new MutationObserver(queueScan).observe(document.body,
		{ childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
	W.addEventListener('hashchange', queueScan);
	queueScan();
	refreshBptf();
	checkForUpdate();
	localStorage.removeItem('siaAltCache'); // alt-account feature removed

	// trade-page click helpers: shift+click = instant add;
	// click on a ×N stack (stacking on) = "how many?" then add that many
	if (CONFIG.shiftClickAdd || CONFIG.stacking) {
		document.addEventListener('click', (ev) => {
			if (!document.getElementById('trade_yours')) return;
			const item = ev.target.closest?.('.item');
			if (!item || !item.rgItem || !item.closest('#inventories')) return;
			if (ev.shiftKey && CONFIG.shiftClickAdd) {
				ev.preventDefault();
				ev.stopPropagation();
				moveToTradeSafe(item);
				afterTradeBatch();
			} else if (stackOn && item.querySelector('.sia-count')) {
				ev.preventDefault();
				ev.stopPropagation();
				const copies = copiesOf(item.rgItem);
				const raw = prompt(`Add how many? (1-${copies.length})`, '1');
				const n = Math.min(copies.length, Math.max(0, parseInt(raw, 10) || 0));
				copies.slice(0, n).forEach((a) => moveToTradeSafe(a.element));
				afterTradeBatch(); // also unsticks the hover the prompt froze
			}
		}, true);
	}

	// ------------------------------------------------------------------
	// Toolbar: sort, stack dupes, metal counter
	// ------------------------------------------------------------------
	const QUALITY_ORDER = ['Unusual', "Collector's", 'Decorated Weapon', 'Haunted', 'Strange',
		'Vintage', 'Genuine', 'Self-Made', 'Community', 'Valve', 'Unique', 'Normal'];

	const tagOf = (d, category) =>
		(d.tags || []).find((t) => (t.category || t.category_name) === category);
	const tagName = (t) => (t && (t.localized_tag_name || t.name)) || '';

	const getActiveInvEl = () => [...document.querySelectorAll('#inventories .inventory_ctn')]
		.find((el) => el.style.display !== 'none');

	const holdersOf = (invEl) => [...invEl.querySelectorAll('.inventory_page .itemHolder')];
	const itemsOf = (invEl) => [...invEl.querySelectorAll('.inventory_page .itemHolder > .item')]
		.filter((el) => el.rgItem);

	const SORTS = {
		name: (a, b) => a.name.localeCompare(b.name),
		type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
		quality: (a, b) => a.quality - b.quality || a.name.localeCompare(b.name),
		price: (a, b) => b.price - a.price || a.name.localeCompare(b.name),
	};

	// sortable value in refined: metal at face value, bp.tf value for TF2 items,
	// market price converted through the key rate as fallback
	function refValueFor(d) {
		const mv = METAL_REF[d.name];
		if (mv) return mv;
		if (String(d.appid) === '440' && bptf) {
			const rv = bptfRefOf(d, tf2Info(d));
			if (rv != null) return rv;
		}
		if (priceable(d)) {
			const n = cachedPriceOf(d);
			if (!Number.isNaN(n)) {
				const keyRec = priceCache['440||Mann Co. Supply Crate Key'];
				const keyNum = keyRec ? parsePrice(keyRec.lp || keyRec.mp) : NaN;
				return keyNum > 0 && bptf?.keyRefined ? n / (keyNum / bptf.keyRefined) : n;
			}
		}
		return -1;
	}

	// per-description caches: these run over whole inventories every card tick,
	// and the underlying regex/lookup work never changes until bp.tf or the key
	// rate refreshes (valEpoch) — cache aggressively
	let valEpoch = 0;
	const refValCache = new WeakMap();
	function refValueCached(d) {
		const hit = refValCache.get(d);
		if (hit && hit.e === valEpoch) return hit.v;
		const v = refValueFor(d);
		refValCache.set(d, { e: valEpoch, v });
		return v;
	}
	const lockCache = new WeakMap();
	function lockDaysCached(d) {
		if (lockCache.has(d)) return lockCache.get(d);
		const v = lockDaysOf(d);
		lockCache.set(d, v);
		return v;
	}

	function entryFor(el) {
		const d = descOf(el.rgItem) || {};
		const q = tagName(tagOf(d, 'Quality') || tagOf(d, 'Rarity'));
		const qIdx = QUALITY_ORDER.indexOf(q);
		return {
			el,
			name: String(d.name || '').toLowerCase(),
			type: tagName(tagOf(d, 'Type')) || String(d.type || ''),
			quality: qIdx === -1 ? 99 : qIdx,
			price: refValueCached(d),
		};
	}

	const stackKeyOf = (item) => {
		const d = descOf(item) || {};
		return d.market_hash_name || d.name || String(item.classid || '?');
	};

	function addCountBadge(holderOrItem, count) {
		const item = holderOrItem.classList?.contains('item')
			? holderOrItem : holderOrItem.querySelector('.item');
		if (!item) return;
		const c = document.createElement('span');
		c.className = 'sia-count';
		c.textContent = `×${count}`;
		item.appendChild(c);
	}

	const clearStackBadges = () =>
		document.querySelectorAll('.sia-count').forEach((el) => el.remove());

	const refilter = () => {
		try { W.Filter?.ReApplyFilter?.(); } catch { /* filter UI not present */ }
	};

	// --- v2 engine (economy_v2.js): m_rgItemElements is the source of truth ---

	// holders in m_rgItemElements are jQuery objects; be tolerant of raw elements too
	const holderEl = (h) => (h && h[0] instanceof Element) ? h[0]
		: (h instanceof Element ? h : null);

	const v2Stashes = new WeakMap();     // inv -> {elements, mItems, mNext} while stacked
	const v2StackCounts = new WeakMap(); // inv -> Map(stackKey -> count) while stacked

	function restoreV2Stack(inv) {
		const st = v2Stashes.get(inv);
		if (!st) return;
		inv.m_rgItemElements = st.elements;
		inv.m_cItems = st.mItems;
		inv.m_iNextEmptyItemElement = st.mNext;
		v2Stashes.delete(inv);
		v2StackCounts.delete(inv);
	}

	function applyV2(inv, sortKey, stack) {
		restoreV2Stack(inv);
		// re-capture if the inventory grew since we first saw it (late loads)
		if (!inv._siaOrig || inv._siaOrig.length !== inv.m_rgItemElements.length) {
			inv._siaOrig = inv.m_rgItemElements.slice();
		}
		clearStackBadges();

		let arr;
		if (sortKey === 'default') {
			arr = inv._siaOrig.slice();
		} else {
			const withItem = [], rest = [];
			for (const h of inv._siaOrig) {
				const el = holderEl(h);
				(el && el.rgItem ? withItem : rest).push(h);
			}
			const entries = withItem.map((h) => ({ h, ...entryFor(holderEl(h)) }));
			entries.sort(SORTS[sortKey] || SORTS.name);
			arr = entries.map((e) => e.h).concat(rest);
		}

		if (stack) {
			const stash = {
				elements: arr.slice(),
				mItems: inv.m_cItems,
				mNext: inv.m_iNextEmptyItemElement,
			};
			const groups = new Map();
			const reps = [];
			for (const h of arr) {
				const el = holderEl(h);
				if (!el || !el.rgItem) continue;
				const key = stackKeyOf(el.rgItem);
				const rec = groups.get(key);
				if (rec) { rec.count++; continue; }
				const r = { h, count: 1 };
				groups.set(key, r);
				reps.push(r);
			}
			for (const r of reps) if (r.count > 1) addCountBadge(holderEl(r.h), r.count);
			inv.m_rgItemElements = reps.map((r) => r.h);
			inv.m_cItems = reps.length;
			inv.m_iNextEmptyItemElement = reps.length;
			v2Stashes.set(inv, stash);
			v2StackCounts.set(inv, new Map([...groups].map(([k, r]) => [k, r.count])));
		} else {
			inv.m_rgItemElements = arr;
		}

		const per = W.INVENTORY_PAGE_ITEMS || 25;
		const cPages = Math.max(1, Math.ceil(inv.m_rgItemElements.length / per));
		if (inv.m_iCurrentPage >= cPages) inv.m_iCurrentPage = 0;
		inv.m_bNeedsRepagination = true;
		inv.LayoutPages();
		inv.ShowPageControlsIfNeeded?.();
		// reordered-in items may never have had images loaded; the responsive
		// single page is reused across layouts and keeps its images-loaded flag
		const pg = inv.m_rgPages && inv.m_rgPages[inv.m_iCurrentPage];
		if (pg) {
			pg.m_bImagesLoaded = false;
			try { pg.LoadPageImages?.(); } catch { /* not built yet */ }
		}
		refilter();
	}

	// --- legacy engine (economy.js, trade offer pages): DOM pages in pageList ---

	const legacyItemOf = (h) => {
		const it = h.querySelector?.('.item');
		return it && it.rgItem ? it : null;
	};

	function applyLegacy(inv, sortKey, stack) {
		const per = W.INVENTORY_PAGE_ITEMS || 16;
		const pages = inv.pageList;
		if (!pages || !pages.length) return;

		const holders = [];
		for (const p of pages) {
			for (const c of [...p.children]) {
				if (c.classList.contains('itemHolder')) holders.push(c);
			}
		}
		holders.forEach((h, i) => { if (!h.dataset.siaIdx) h.dataset.siaIdx = String(i + 1); });
		clearStackBadges();
		for (const h of holders) {
			if (h.dataset.siaStacked) {
				delete h.dataset.siaStacked;
				h.filtered = false;
				h.style.display = '';
			}
		}

		const withItem = holders.filter(legacyItemOf);
		const rest = holders.filter((h) => !legacyItemOf(h));

		let ordered;
		if (sortKey === 'default') {
			ordered = withItem.slice().sort((a, b) => (+a.dataset.siaIdx) - (+b.dataset.siaIdx));
		} else {
			const entries = withItem.map((h) => ({ h, ...entryFor(legacyItemOf(h)) }));
			entries.sort(SORTS[sortKey] || SORTS.name);
			ordered = entries.map((e) => e.h);
		}

		if (stack) {
			const groups = new Map();
			const reps = [], extras = [];
			for (const h of ordered) {
				const key = stackKeyOf(legacyItemOf(h).rgItem);
				const rec = groups.get(key);
				if (rec) { rec.count++; extras.push(h); continue; }
				const r = { h, count: 1 };
				groups.set(key, r);
				reps.push(r);
			}
			for (const r of reps) if (r.count > 1) addCountBadge(r.h, r.count);
			for (const h of extras) {
				h.dataset.siaStacked = '1';
				h.filtered = true; // legacy filter counts it as filtered-out
				h.style.display = 'none';
			}
			ordered = reps.map((r) => r.h).concat(extras);
		}

		ordered = ordered.concat(rest);
		ordered.forEach((h, i) => {
			pages[Math.min(Math.floor(i / per), pages.length - 1)].appendChild(h);
		});

		const visible = ordered.filter((h) => !h.filtered && h.style.display !== 'none').length;
		inv.pageTotal = Math.max(1, Math.ceil(visible / per));
		// only the current page may stay visible — a stray visible page full of
		// hidden holders otherwise stretches the inventory box to double height
		const cur = inv.pageCurrent < inv.pageTotal ? inv.pageCurrent : 0;
		pages.forEach((p, i) => { p.style.display = i === cur ? '' : 'none'; });
		if (inv.pageCurrent >= inv.pageTotal) inv.SetActivePage?.(0);
		else inv.UpdatePageCounts?.();
		// items pulled in from never-visited pages have no image yet, and Steam's
		// per-page images_loaded flag would skip them — force a reload
		pages.forEach((p) => { p.images_loaded = false; });
		try { inv.LoadPageImages?.(pages[cur]); } catch { /* legacy only */ }
		refilter();
	}

	// --- dom fallback (no engine detected): CSS-hide only, no page-count change ---

	function applyDom(invEl, sortKey, stack) {
		const holders = holdersOf(invEl);
		const items = itemsOf(invEl);
		items.forEach((el, i) => { if (!el.dataset.siaIdx) el.dataset.siaIdx = String(i + 1); });
		holders.forEach((h) => h.classList.remove('sia-stacked-holder'));
		clearStackBadges();

		let entries = items.map(entryFor);
		if (sortKey === 'default') {
			entries.sort((a, b) => (+a.el.dataset.siaIdx) - (+b.el.dataset.siaIdx));
		} else {
			entries.sort(SORTS[sortKey] || SORTS.name);
		}

		let hiddenFrom = Infinity;
		if (stack) {
			const groups = new Map();
			const reps = [], extras = [];
			for (const e of entries) {
				const key = stackKeyOf(e.el.rgItem);
				const rec = groups.get(key);
				if (rec) { rec.count++; extras.push(e); continue; }
				const r = { e, count: 1 };
				groups.set(key, r);
				reps.push(r);
			}
			for (const r of reps) if (r.count > 1) addCountBadge(r.e.el, r.count);
			entries = reps.map((r) => r.e).concat(extras);
			hiddenFrom = reps.length;
		}

		entries.forEach((e, i) => {
			const h = holders[i];
			if (!h) return;
			if (e.el.parentElement !== h) h.appendChild(e.el);
			h.classList.toggle('sia-stacked-holder', i >= hiddenFrom);
		});
	}

	function applyFor(inv, sortKey, stack) {
		if (inv && Array.isArray(inv.m_rgItemElements) && typeof inv.LayoutPages === 'function') {
			if (inv.m_contextid === (W.APPWIDE_CONTEXT ?? 0)) return; // "all games" view
			applyV2(inv, sortKey, stack);
		} else if (inv && Array.isArray(inv.pageList)) {
			applyLegacy(inv, sortKey, stack);
		} else {
			const invEl = getActiveInvEl();
			if (invEl) applyDom(invEl, sortKey, stack);
		}
	}

	// keep Steam's own filter from resurrecting stacked-away holders (legacy engine)
	function wrapMatchItem() {
		const F = W.Filter;
		if (!F || !F.MatchItem || F._siaWrapped) return;
		const orig = F.MatchItem;
		F.MatchItem = function (elItem, ...rest) {
			const holder = elItem && elItem.closest ? elItem.closest('.itemHolder') : null;
			if (holder && holder.dataset.siaStacked) return false;
			return orig.call(this, elItem, ...rest);
		};
		F._siaWrapped = true;
	}
	wrapMatchItem();

	// descriptions of everything in the active inventory: engine assets when
	// loaded, rendered item elements otherwise (some tabs never fill assets)
	function activeDescs() {
		const inv = W.g_ActiveInventory;
		const assets = inv && (inv.m_rgAssets || inv.rgInventory);
		if (assets && Object.keys(assets).length) return Object.values(assets).map(descOf);
		const invEl = getActiveInvEl();
		return invEl ? itemsOf(invEl).map((el) => descOf(el.rgItem)) : [];
	}

	function metalCounts() {
		const c = { ref: 0, rec: 0, scrap: 0, keys: 0, is440: false };
		for (const d of activeDescs()) {
			if (!d) continue;
			if (String(d.appid) === '440') c.is440 = true;
			// permanently untradable metal can't be traded — don't count it
			// (trade-locked with a countdown still counts)
			if ((d.tradable === 0 || d.tradable === false) && lockDaysCached(d) <= 0) continue;
			const n = d.market_hash_name || d.name;
			if (n === 'Refined Metal') c.ref++;
			else if (n === 'Reclaimed Metal') c.rec++;
			else if (n === 'Scrap Metal') c.scrap++;
			else if (n === 'Mann Co. Supply Crate Key') c.keys++;
		}
		return c;
	}

	let stackOn = false;
	let lastInv = null;
	let lastInvEl = null;
	let bptfShow = localStorage.getItem('sia-bptf-show') !== '0';
	document.documentElement.classList.toggle('sia-hide-bptf', !bptfShow);

	function runLayout() {
		const sortKey = document.getElementById('sia-sort')?.value || 'default';
		const inv = W.g_ActiveInventory;
		const go = () => applyFor(inv, sortKey, stackOn);
		if (inv && typeof inv.BIsFullyLoaded === 'function' && inv.BIsFullyLoaded()) {
			go(); // already complete: lay out synchronously, no promise round-trip
		} else if (inv && typeof inv.LoadCompleteInventory === 'function') {
			// make sure every asset is loaded before reordering, else we'd sort a partial page
			Promise.resolve(inv.LoadCompleteInventory()).then(go, go);
		} else {
			go();
		}
	}

	// gear-button settings UI — writes overrides to localStorage, reload applies
	const SETTINGS_SCHEMA = [
		['Item badges', null, 'header'],
		['tf2Badges', 'TF2 badges (KS, unusual, spells…)'],
		['tradeLockBadge', 'Trade-lock “6D” badge'],
		['markUncraftable', 'Dashed outline on uncraftable'],
		['markUntradable', 'Red bar on untradable'],
		['shrinkRenameWarning', 'Small rename warning'],
		['Pricing', null, 'header'],
		['backpackTfKey', 'backpack.tf API key', 'text'],
		['Get a free key: log into backpack.tf → Settings → API Access', null, 'help'],
		['priceIndicator', 'Market price badges + value card'],
		['showBuyOrders', 'Badge shows buy order (instant sell)'],
		['metalCounter', 'Metal counter'],
		['afterFeesValue', 'After-fees value line'],
		['priceCooldownMs', 'Price request cooldown (ms)', 'number'],
		['priceCacheMins', 'Price cache (min)', 'number'],
		['Inventory tools', null, 'header'],
		['sortButton', 'Sort dropdown'],
		['stacking', 'Stack dupes toggle'],
		['duplicateFilter', 'Duplicate filter tag'],
		['panelLinks', 'bp.tf/market panel icons'],
		['quicksellButtons', 'Quicksell buttons (⚡)'],
		['Trading', null, 'header'],
		['tradeCompare', 'Trade side summaries'],
		['partnerValue', 'Partner backpack value'],
		['tradeMetalHelper', 'Add metal box'],
		['tradeEmptyButtons', 'Trade buttons (Take page…)'],
		['shiftClickAdd', 'Shift+click quick add'],
		['draftSaver', 'Trade draft saver'],
	];

	function toggleSettingsPanel(anchorBtn) {
		let panel = document.getElementById('sia-settings');
		if (panel) { panel.remove(); return; }
		panel = document.createElement('div');
		panel.id = 'sia-settings';
		const saved = (() => {
			try { return JSON.parse(localStorage.getItem('siaSettings')) || {}; } catch { return {}; }
		})();
		for (const [key, label, type] of SETTINGS_SCHEMA) {
			if (type === 'help') {
				const a = document.createElement('a');
				a.href = 'https://backpack.tf/developer';
				a.target = '_blank';
				a.rel = 'noopener';
				a.textContent = key;
				a.style.cssText = 'display:block;font-size:10px;color:#67c1f5;margin:0 0 4px 4px';
				panel.appendChild(a);
				continue;
			}
			if (type === 'header') {
				const h = document.createElement('div');
				h.textContent = key;
				h.style.cssText = 'font-weight:bold;color:#66c0f4;margin:8px 0 2px;' +
					'border-bottom:1px solid #2a475e;padding-bottom:2px';
				panel.appendChild(h);
				continue;
			}
			const row = document.createElement('label');
			const input = document.createElement('input');
			input.dataset.key = key;
			if (type === 'number' || type === 'text') {
				input.type = type;
				input.value = String(CONFIG[key] ?? '');
				row.append(label + ' ', input);
			} else {
				input.type = 'checkbox';
				input.checked = !!CONFIG[key];
				row.append(input, ' ' + label);
			}
			if (key === 'backpackTfKey') {
				// treat like a password: masked by default, eye to peek, verify to test
				input.type = 'password';
				const eye = document.createElement('button');
				eye.type = 'button';
				eye.textContent = '👁';
				eye.title = 'Show/hide key';
				eye.style.cssText = 'margin-left:4px;padding:1px 5px';
				eye.addEventListener('click', (e) => {
					e.preventDefault();
					input.type = input.type === 'password' ? 'text' : 'password';
				});
				const check = document.createElement('button');
				check.type = 'button';
				check.textContent = 'Verify';
				check.style.cssText = 'margin-left:4px;padding:1px 6px';
				const status = document.createElement('span');
				status.style.marginLeft = '6px';
				check.addEventListener('click', async (e) => {
					e.preventDefault();
					status.textContent = '…';
					status.style.color = '#b8b6b4';
					const k = input.value.trim();
					const j = k ? await bpFetchJson(
						`https://backpack.tf/api/IGetCurrencies/v1?key=${encodeURIComponent(k)}`) : null;
					const ok = j?.response?.success === 1;
					status.textContent = ok ? '✓ valid' : '✗ invalid';
					status.style.color = ok ? '#9CC83B' : '#D75A4A';
				});
				row.append(eye, check, status);
			}
			input.addEventListener('change', () => {
				saved[key] = type === 'number' ? Number(input.value)
					: type === 'text' ? input.value.trim() : input.checked;
				try { localStorage.setItem('siaSettings', JSON.stringify(saved)); } catch { /* quota */ }
				document.getElementById('sia-settings-note').style.display = '';
			});
			panel.appendChild(row);
		}
		const note = document.createElement('div');
		note.id = 'sia-settings-note';
		note.style.cssText = 'display:none;margin-top:8px';
		const reload = document.createElement('button');
		reload.type = 'button';
		reload.textContent = 'Reload to apply';
		reload.addEventListener('click', () => location.reload());
		note.appendChild(reload);
		panel.appendChild(note);
		const r = anchorBtn.getBoundingClientRect();
		panel.style.left = `${Math.round(r.left + scrollX)}px`;
		panel.style.top = `${Math.round(r.bottom + scrollY + 4)}px`;
		document.body.appendChild(panel);
	}

	function ensureBar() {
		wrapMatchItem(); // Filter may be defined after us; retry until wrapped
		if (!CONFIG.sortButton && !CONFIG.stacking && !CONFIG.metalCounter) return;
		const anchor = document.getElementById('inventories');
		if (!anchor || document.getElementById('sia-bar')) return;

		const bar = document.createElement('div');
		bar.id = 'sia-bar';
		bar.innerHTML =
			(CONFIG.sortButton
				? `<label>Sort: <select id="sia-sort">
						<option value="default">Default</option>
						<option value="name">Name</option>
						<option value="type">Type</option>
						<option value="quality">Quality</option>
						<option value="price" title="Highest value first">Price</option>
					</select></label>`
				: '') +
			(CONFIG.stacking ? '<button id="sia-stack" type="button" title="Group duplicate items into one box">Group</button>' : '') +
			(CONFIG.backpackTfKey
				? `<button id="sia-bptf-toggle" type="button" title="Toggle bp.tf values">` +
					`<img src="${BPTF_ICON}" alt="bp.tf"></button>`
				: '') +
			(CONFIG.settingsPanel ? '<button id="sia-gear" type="button" title="SIA settings">⚙</button>' : '');
		anchor.parentElement.insertBefore(bar, anchor);

		const sel = bar.querySelector('#sia-sort');
		if (sel) {
			sel.value = localStorage.getItem('sia-sort') || 'default';
			sel.addEventListener('change', () => {
				localStorage.setItem('sia-sort', sel.value);
				runLayout();
			});
		}
		const stackBtn = bar.querySelector('#sia-stack');
		if (stackBtn) {
			stackBtn.addEventListener('click', () => {
				stackOn = !stackOn;
				stackBtn.classList.toggle('sia-stack-on', stackOn);
				runLayout();
			});
		}
		const bptfBtn = bar.querySelector('#sia-bptf-toggle');
		if (bptfBtn) {
			bptfBtn.classList.toggle('sia-bptf-off', !bptfShow);
			bptfBtn.addEventListener('click', () => {
				bptfShow = !bptfShow;
				localStorage.setItem('sia-bptf-show', bptfShow ? '1' : '0');
				bptfBtn.classList.toggle('sia-bptf-off', !bptfShow);
				document.documentElement.classList.toggle('sia-hide-bptf', !bptfShow);
				lastBarUpdate = 0;
				updateBarThrottled();
			});
		}
		const gear = bar.querySelector('#sia-gear');
		gear?.addEventListener('click', () => toggleSettingsPanel(gear));
		ensureTradeMetalUI(bar);
		ensureDraftButton(bar);
	}

	// ------------------------------------------------------------------
	// Trade helper: add an exact metal amount to your side ("5.33" -> ref+rec+scrap)
	// ------------------------------------------------------------------
	function parseRefAmount(s) {
		const m = String(s).trim().match(/^(\d+)(?:[.,]([0-8])\2?)?$/);
		if (!m) return NaN;
		return Number(m[1]) * 9 + (m[2] ? Number(m[2]) : 0);
	}

	function addMetalToTrade() {
		const input = document.getElementById('sia-metal-amount');
		let need = parseRefAmount(input.value);
		if (Number.isNaN(need) || need <= 0) {
			input.style.borderColor = '#A94847';
			return;
		}
		input.style.borderColor = '';
		const inv = W.g_ActiveInventory;
		const assets = Object.values((inv && (inv.rgInventory || inv.m_rgAssets)) || {});
		const inTrade = new Set([...document.querySelectorAll('#your_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)));
		const pool = { 'Refined Metal': [], 'Reclaimed Metal': [], 'Scrap Metal': [] };
		for (const a of assets) {
			const d = descOf(a);
			const n = d && (d.market_hash_name || d.name);
			if (pool[n] && a.element && !inTrade.has(a.id || a.assetid)) pool[n].push(a);
		}
		for (const [n, units] of [['Refined Metal', 9], ['Reclaimed Metal', 3], ['Scrap Metal', 1]]) {
			for (const a of pool[n]) {
				if (need < units) break;
				moveToTradeSafe(a.element);
				need -= units;
			}
		}
		afterTradeBatch();
		if (need > 0) {
			const r = need % 9;
			(W.ShowAlertDialog || ((t, m) => alert(m)))('Add metal',
				`Short by ${Math.floor(need / 9)}.${r}${r} ref — not enough small metal to make the exact amount.`);
		}
	}

	function emptyTradeSide(slotsId) {
		document.querySelectorAll(`#${slotsId} .itemHolder .item`).forEach((el) => {
			if (el.rgItem) {
				try { W.GTradeStateManager?.RemoveItemFromTrade?.(el.rgItem); } catch { /* read-only */ }
			}
		});
	}

	// live totals for both trade sides: refined (bp.tf/metal) + wallet money (market)
	function tradeSideRef(slotsId) {
		let total = 0, money = 0, moneySample = '', unpriced = 0, items = 0;
		for (const el of document.querySelectorAll(`#${slotsId} .itemHolder .item`)) {
			const it = el.rgItem;
			if (!it) continue;
			items++;
			const d = descOf(it) || {};
			const v = refValueCached(d);
			if (v > 0) total += v;
			else unpriced++;
			if (priceable(d)) {
				const rec = priceCache[`${d.appid}||${d.market_hash_name}`];
				const n = rec ? parsePrice(rec.lp || rec.mp) : NaN;
				if (!Number.isNaN(n)) {
					money += n;
					if (!moneySample) moneySample = rec.lp || rec.mp;
				}
			}
		}
		return { total: Math.round(total * 100) / 100, money, moneySample, unpriced, items };
	}

	// partner's whole visible backpack value, computed once their inventory loads
	const partnerValues = new WeakMap();
	function partnerBackpackRef() {
		if (!CONFIG.partnerValue || !W.UserThem) return null;
		const inv = W.g_ActiveInventory;
		if (!inv || W.g_ActiveUser !== W.UserThem) {
			return partnerValues.get(W.UserThem) ?? null;
		}
		if (partnerValues.has(W.UserThem)) return partnerValues.get(W.UserThem);
		const assets = Object.values((inv.rgInventory || inv.m_rgAssets) || {});
		if (!assets.length) return null;
		let total = 0;
		for (const a of assets) {
			const v = refValueCached(descOf(a) || {});
			if (v > 0) total += v;
		}
		total = Math.round(total);
		partnerValues.set(W.UserThem, total);
		return total;
	}

	function fmtMoney(n, sample) {
		const prefix = (sample.match(/^[^\d]+/) || [''])[0].trim();
		const suffix = (sample.match(/[^\d]+$/) || [''])[0].trim();
		const decSep = /,\d\d\s*[^\d]*$/.test(sample) ? ',' : '.';
		return `${prefix}${n.toFixed(2).replace('.', decSep)}${suffix}`;
	}

	// engine-aware lazy-image load: legacy wants the raw element,
	// v2 wants a jQuery-wrapped one
	function loadItemImageSafe(el) {
		const inv = W.g_ActiveInventory;
		if (!inv || typeof inv.LoadItemImage !== 'function') return;
		try {
			if (Array.isArray(inv.m_rgItemElements) && W.$J) inv.LoadItemImage(W.$J(el));
			else inv.LoadItemImage(el);
		} catch { /* best effort */ }
	}

	// moving hidden/stacked copies needs their lazy image loaded first, and a
	// full slot must not abort the batch
	function moveToTradeSafe(el) {
		loadItemImageSafe(el);
		try { W.MoveItemToTrade?.(el); } catch { /* no free slot */ }
	}

	// repair slot images Steam leaves broken after rapid moves
	function fixSlotImages() {
		for (const slot of document.querySelectorAll('#your_slots .itemHolder, #their_slots .itemHolder')) {
			const itemEl = slot.querySelector('.item');
			if (!itemEl || !itemEl.rgItem) continue;
			const img = itemEl.querySelector('img');
			if (!img || !img.getAttribute('src') || img.src.includes('trans.gif')) {
				loadItemImageSafe(itemEl);
			}
			const logo = slot.querySelector('.slot_applogo_img');
			if (logo && (!logo.getAttribute('src') || logo.getAttribute('src') === 'undefined' ||
				(logo.complete && logo.naturalWidth === 0))) {
				const icon = W.g_rgAppContextData?.[itemEl.rgItem.appid]?.icon;
				if (icon) logo.src = icon;
				else logo.closest('.slot_applogo')?.style.setProperty('display', 'none');
			}
		}
	}

	function afterTradeBatch() {
		try { W.HideHover?.(); } catch { /* no hover system */ }
		fixSlotImages();
		queueScan();
	}

	// per-side value summaries injected into the trade boxes
	function sideSummaryEl(boxId, id) {
		const box = document.getElementById(boxId);
		if (!box) return null;
		let el = document.getElementById(id);
		if (!el) {
			el = document.createElement('div');
			el.id = id;
			el.className = 'sia-side-summary';
			el.style.display = 'none';
			box.insertBefore(el, box.firstChild);
		}
		return el;
	}

	// whole-side money estimate: the ref total (already covers bp.tf + market
	// items) converted through the key's market price
	function refToMoney(ref) {
		const keyRec = priceCache['440||Mann Co. Supply Crate Key'];
		const keyNum = keyRec ? parsePrice(keyRec.lp || keyRec.mp) : NaN;
		if (!(keyNum > 0) || !bptf?.keyRefined || !(ref > 0)) return null;
		return { v: ref * (keyNum / bptf.keyRefined), sample: keyRec.lp || keyRec.mp };
	}

	function updateTradeCompare() {
		if (!CONFIG.tradeCompare || !document.getElementById('trade_yours')) return;
		const give = tradeSideRef('your_slots');
		const get = tradeSideRef('their_slots');
		const sideMoney = (s) => refToMoney(s.total) ||
			(s.money ? { v: s.money, sample: s.moneySample } : null);

		const sidePart = (label, s, color) => {
			const span = document.createElement('span');
			const money = sideMoney(s);
			span.append(`${label} ≈ `);
			if (money) {
				const big = document.createElement('span');
				big.className = 'sia-big';
				big.textContent = fmtMoney(money.v, money.sample);
				big.style.color = color;
				span.append(big, ' · ');
			}
			span.append(`${s.total} ref` +
				(s.unpriced ? ` · +${s.unpriced} unpriced` : '') +
				` · ${s.items} item${s.items === 1 ? '' : 's'}`);
			return span;
		};

		const gm = sideMoney(give), tm = sideMoney(get);
		const giveEl = sideSummaryEl('trade_yours', 'sia-give-summary');
		const getEl = sideSummaryEl('trade_theirs', 'sia-get-summary');
		if (giveEl) {
			const empty = !give.total && !give.money && !give.unpriced;
			giveEl.style.display = empty ? 'none' : '';
			giveEl.innerHTML = '';
			giveEl.appendChild(sidePart('You give', give, '#D75A4A')); // money out: red
			const right = document.createElement('span');
			let profitVal, profitBig, profitSmall;
			if (gm || tm) {
				profitVal = (tm?.v || 0) - (gm?.v || 0);
				const sample = (tm || gm).sample;
				profitBig = `${profitVal > 0 ? '+' : profitVal < 0 ? '-' : ''}${fmtMoney(Math.abs(profitVal), sample)}`;
				const refDelta = Math.round((get.total - give.total) * 100) / 100;
				profitSmall = ` (${refDelta > 0 ? '+' : ''}${refDelta} ref)`;
			} else {
				profitVal = Math.round((get.total - give.total) * 100) / 100;
				profitBig = `${profitVal > 0 ? '+' : ''}${profitVal} ref`;
				profitSmall = '';
			}
			right.append('Profit: ');
			const big = document.createElement('span');
			big.className = 'sia-big';
			big.textContent = profitBig;
			big.style.color = profitVal > 0 ? '#9CC83B' : (profitVal < 0 ? '#D75A4A' : '#fff');
			right.append(big, profitSmall);
			right.style.color = profitVal > 0 ? '#9CC83B' : (profitVal < 0 ? '#D75A4A' : '#b8b6b4');
			giveEl.appendChild(right);
		}
		if (getEl) {
			const bpRef = partnerBackpackRef();
			const empty = !get.total && !get.money && !get.unpriced && bpRef == null;
			getEl.style.display = empty ? 'none' : '';
			getEl.innerHTML = '';
			if (get.items) getEl.appendChild(sidePart('You get', get, '#9CC83B')); // money in: green
			if (bpRef != null) {
				const bp = document.createElement('span');
				bp.textContent = `Their backpack ≈ ${bpRef} ref`;
				getEl.appendChild(bp);
			}
		}
	}

	// add every item on the currently visible inventory page
	function addVisiblePage() {
		const invEl = getActiveInvEl();
		if (!invEl) return;
		const pages = [...invEl.querySelectorAll('.inventory_page')]
			.filter((p) => p.style.display !== 'none');
		for (const p of pages) {
			for (const el of p.querySelectorAll('.itemHolder .item')) {
				if (el.rgItem && el.offsetParent !== null) moveToTradeSafe(el);
			}
		}
		afterTradeBatch();
	}

	// the trade screen only loads tradable items; an untradable copy at home
	// still counts as "the one you keep" — learn which items have one
	let untradableKeys = null;
	async function loadUntradableKeys() {
		if (untradableKeys || !W.g_steamID) return;
		try {
			const cached = JSON.parse(localStorage.getItem('siaUntradKeys'));
			if (cached && Date.now() - cached.t < 30 * 60000 && cached.sid === String(W.g_steamID)) {
				untradableKeys = new Set(cached.keys);
				return;
			}
		} catch { /* refetch */ }
		try {
			const r = await fetch(
				`https://steamcommunity.com/inventory/${W.g_steamID}/440/2?l=english&count=2000`,
				{ credentials: 'same-origin' });
			const j = r.ok ? await r.json() : null;
			untradableKeys = new Set();
			if (!j?.descriptions) return;
			const byKey = {};
			for (const d of j.descriptions) byKey[d.classid + '_' + (d.instanceid || '0')] = d;
			for (const a of j.assets || []) {
				const d = byKey[a.classid + '_' + (a.instanceid || '0')];
				if (d && !d.tradable) untradableKeys.add(d.market_hash_name || d.name);
			}
			try {
				localStorage.setItem('siaUntradKeys', JSON.stringify(
					{ t: Date.now(), sid: String(W.g_steamID), keys: [...untradableKeys] }));
			} catch { /* quota */ }
		} catch { untradableKeys = new Set(); }
	}

	// keep one of each, trade away the rest
	async function giveAllDupes() {
		const inv = W.g_ActiveInventory;
		if (!inv) return;
		await loadUntradableKeys();
		const assets = Object.values((inv.rgInventory || inv.m_rgAssets) || {});
		const inTrade = new Set([...document.querySelectorAll('#your_slots .item, #their_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)));
		const groups = new Map();
		for (const a of assets) {
			if (!a || !a.element || inTrade.has(a.id || a.assetid)) continue;
			const d = descOf(a) || {};
			if (METAL_REF[d.name]) continue; // metal is currency — use "Add metal" instead
			const k = stackKeyOf(a);
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(a);
		}
		for (const [key, list] of groups) {
			// untradable copy exists at home: every tradable copy is a dupe
			const keep = untradableKeys?.has(key) ? 0 : 1;
			for (const a of list.slice(keep)) moveToTradeSafe(a.element);
		}
		afterTradeBatch();
	}

	// add every robot part (MvM crafting drops) from the active inventory
	function giveAllRobotParts() {
		const inv = W.g_ActiveInventory;
		if (!inv) return;
		const assets = Object.values((inv.rgInventory || inv.m_rgAssets) || {});
		const inTrade = new Set([...document.querySelectorAll('#your_slots .item, #their_slots .item')]
			.map((e) => e.rgItem && (e.rgItem.id || e.rgItem.assetid)));
		for (const a of assets) {
			if (!a || !a.element || inTrade.has(a.id || a.assetid)) continue;
			const d = descOf(a) || {};
			if (/^(Battle-Worn|Reinforced|Pristine) Robot /.test(d.name || '')) {
				moveToTradeSafe(a.element);
			}
		}
		afterTradeBatch();
	}

	// "Remove all" empties whichever side's inventory tab is open
	function removeAllActiveSide() {
		const theirs = !!(W.g_ActiveUser && W.UserThem && W.g_ActiveUser === W.UserThem);
		emptyTradeSide(theirs ? 'their_slots' : 'your_slots');
		afterTradeBatch();
	}

	function ensureTradeMetalUI(bar) {
		if (!document.getElementById('trade_yours') || document.getElementById('sia-trade-metal')) return;
		const wrap = document.createElement('span');
		wrap.id = 'sia-trade-metal';
		wrap.style.display = 'contents'; // children join the bar's flex flow
		wrap.innerHTML =
			// row 1, right of Sort: Take all | Remove all
			(CONFIG.tradeEmptyButtons
				? `<button id="sia-add-page" type="button" title="Add every item on the visible page">Take all</button>` +
					`<button id="sia-remove-all" type="button" title="Remove everything from this side">Remove all</button>`
				: '') +
			'<span class="sia-break"></span>' +
			// row 2: Add metal | Give dupes
			(CONFIG.tradeMetalHelper
				? `<input id="sia-metal-amount" type="text" placeholder="5.33" ` +
					`title="Metal amount to add to the trade, e.g. 5.33">` +
					`<button id="sia-metal-add" type="button">Add metal</button>`
				: '') +
			(CONFIG.tradeEmptyButtons
				? `<button id="sia-give-dupes" type="button" title="Keep one of each, add all extra copies">Give dupes</button>` +
					`<button id="sia-give-robot" type="button" title="Add all your robot parts to the trade">` +
					`<img class="sia-btn-ico" src="${CUR_ICONS.robot}" alt="robot parts"></button>`
				: '');
		if (!wrap.innerHTML) return;
		bar.appendChild(wrap);
		wrap.querySelector('#sia-metal-add')?.addEventListener('click', addMetalToTrade);
		wrap.querySelector('#sia-add-page')?.addEventListener('click', addVisiblePage);
		wrap.querySelector('#sia-give-dupes')?.addEventListener('click', giveAllDupes);
		wrap.querySelector('#sia-give-robot')?.addEventListener('click', giveAllRobotParts);
		wrap.querySelector('#sia-remove-all')?.addEventListener('click', removeAllActiveSide);
		// gear rides at the end of row 2 on trade pages
		const gearBtn = document.getElementById('sia-gear');
		if (gearBtn) bar.appendChild(gearBtn);

		// trade offer note: restore last size the user chose
		const note = document.getElementById('trade_offer_note');
		if (note && !note.dataset.siaResize) {
			note.dataset.siaResize = '1';
			const saved = localStorage.getItem('sia-note-h');
			if (saved) note.style.height = saved;
			new ResizeObserver(() => {
				if (note.style.height) localStorage.setItem('sia-note-h', note.style.height);
			}).observe(note);
		}
	}

	let priceBatchTotal = 0; // high-water mark of the current pricing batch

	// pricing progress note with live hover queue — shared by the value card
	// (inventory) and the toolbar (trade pages)
	function buildPricingNote() {
		if (!priceQueue.length && !priceCurrentJob) {
			priceBatchTotal = 0;
			return '';
		}
		priceBatchTotal = Math.max(priceBatchTotal, priceQueue.length);
		const pct = priceBatchTotal
			? Math.round((1 - priceQueue.length / priceBatchTotal) * 100) : 0;
		const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
		const upNext = priceQueue.slice(0, 12).map((j) => `· ${esc(j.mhn)}`);
		if (priceQueue.length > 12) upNext.push('…');
		const tip = `<div class="sia-queue-tip">` +
			(priceCurrentJob ? `<div class="sia-tip-cur">Checking: ${esc(priceCurrentJob)}</div>` : '') +
			upNext.join('<br>') + `</div>`;
		const label = priceBackoffUntil > Date.now()
			? `rate-limited · resuming in ${Math.ceil((priceBackoffUntil - Date.now()) / 1000)}s`
			: `${priceQueue.length} left to check`;
		return `<div class="sia-vc-note">${label}` +
			`<div class="sia-progressbar"><div style="width:${pct}%"></div></div>${tip}</div>`;
	}

	let lastBarUpdate = 0;
	function updateBarThrottled() {
		if (Date.now() - lastBarUpdate < 1000) return;
		lastBarUpdate = Date.now();
		ensureBar();
		// trade controls may become possible after the bar was first built
		const existingBar = document.getElementById('sia-bar');
		if (existingBar) ensureTradeMetalUI(existingBar);

		// stacking is a per-inventory layout; when the user switches app/context,
		// restore the previous inventory's real state and reset the toggle
		const inv = W.g_ActiveInventory;
		const invEl = getActiveInvEl();
		if (inv !== lastInv || invEl !== lastInvEl) {
			const prev = lastInv;
			lastInv = inv;
			lastInvEl = invEl;
			if (stackOn) {
				stackOn = false;
				document.getElementById('sia-stack')?.classList.remove('sia-stack-on');
				if (prev) {
					try { applyFor(prev, document.getElementById('sia-sort')?.value || 'default', false); }
					catch { /* previous inventory may be mid-teardown */ }
				}
			}
		}

		// trade buttons follow the selected inventory tab: yours vs theirs
		if (document.getElementById('trade_yours')) {
			const theirs = !!(W.g_ActiveUser && W.UserThem && W.g_ActiveUser === W.UserThem);
			const setVis = (id, show) => {
				const b = document.getElementById(id);
				if (b) b.style.display = show ? '' : 'none';
			};
			setVis('sia-give-dupes', !theirs);
			// metal box works on whichever TF2 inventory is open — theirs included
			const activeTf2 = String(W.g_ActiveInventory?.m_appid ?? W.g_ActiveInventory?.appid ?? '') === '440';
			setVis('sia-metal-amount', activeTf2);
			setVis('sia-metal-add', activeTf2);
			setVis('sia-give-robot', !theirs && activeTf2);

			// pricing progress lives in the toolbar here — no value card on trades
			const bar2 = document.getElementById('sia-bar');
			if (bar2) {
				let note = document.getElementById('sia-bar-note');
				if (!note) {
					note = document.createElement('span');
					note.id = 'sia-bar-note';
					bar2.appendChild(note);
				}
				const nh = buildPricingNote();
				if (note.dataset.last !== nh) {
					note.dataset.last = nh;
					note.innerHTML = nh;
				}
			}

			// Steam hides the "Show advanced filters" link on trade pages; restore it
			// only in the untouched initial state so Steam's own toggling still works
			const showLink = document.getElementById('filter_tag_show');
			const hideLink = document.getElementById('filter_tag_hide');
			if (showLink && getComputedStyle(showLink).visibility === 'hidden' &&
				(!hideLink || getComputedStyle(hideLink).visibility === 'hidden')) {
				showLink.style.visibility = 'visible';
			}
		}

		// bp.tf toggle only makes sense on the TF2 tab
		const bptfToggle = document.getElementById('sia-bptf-toggle');
		if (bptfToggle) {
			const on440 = String(inv?.m_appid ?? inv?.appid ?? '') === '440' ||
				!!document.querySelector('#inventories .inventory_ctn[id*="_440_"]:not([style*="display: none"])');
			bptfToggle.style.display = on440 ? '' : 'none';
		}
		updateTradeCompare();

		// combined value card, top-right of the inventory area (inventory pages only)
		const tab = document.getElementById('tabcontent_inventory');
		if (!tab) return;
		let card = document.getElementById('sia-value-top');
		if (!card) {
			card = document.createElement('div');
			card.id = 'sia-value-top';
			tab.appendChild(card);
		}

		const parts = [];

		if (CONFIG.metalCounter) {
			const c = metalCounts();
			if (c.is440) {
				const scrapTotal = c.ref * 9 + c.rec * 3 + c.scrap;
				const r = scrapTotal % 9;
				parts.push(`<div class="sia-vc-metal">` +
					`${curIcon('ref', 'Refined Metal')}${c.ref}` +
					`${curIcon('rec', 'Reclaimed Metal')}${c.rec}` +
					`${curIcon('scrap', 'Scrap Metal')}${c.scrap}` +
					` = ${Math.floor(scrapTotal / 9)}.${r}${r}` +
					(bptfShow && bptf?.keyRefined
						? ` ≈ ${(scrapTotal / 9 / bptf.keyRefined).toFixed(2)}${curIcon('key', 'in keys (bp.tf rate)')}`
						: '') +
					(c.keys ? ` · ${c.keys}${curIcon('key', 'keys owned')}` : '') +
					`</div>`);
			}
		}

		if (CONFIG.priceIndicator) {
			const inv2 = W.g_ActiveInventory;
			const descs = activeDescs();
			let sum = 0, priced = 0, marketable = 0, sample = '';
			for (const d of descs) {
				if (!priceable(d)) continue;
				// permanently untradable can't be sold or traded — don't count it
				// (temporary trade/market holds still count)
				if ((d.tradable === 0 || d.tradable === false) && lockDaysCached(d) <= 0) continue;
				marketable++;
				const rec = priceCache[`${d.appid}||${d.market_hash_name}`];
				const n = rec ? parsePrice(rec.lp || rec.mp) : NaN;
				if (!Number.isNaN(n)) {
					sum += n;
					priced++;
					if (!sample) sample = rec.lp || rec.mp;
				}
			}
			if (priced) {
				parts.push(`<div class="sia-vc-money"><img src="${STEAM_ICON}">` +
					`${fmtMoney(sum, sample)} <span class="sia-vc-sub">(${priced}/${marketable})</span></div>`);
				if (CONFIG.afterFeesValue) {
					parts.push(`<div class="sia-vc-sub">after fees ≈ ${fmtMoney(sum / 1.15, sample)}</div>`);
				}
			}

			// tradable worth: bp.tf values of everything you can actually trade away
			// (marketable or not — bp.tf trading covers it); perm-untradables excluded.
			// TF2 only — ref values mean nothing for gems or CS2 skins
			const activeIs440 = String(inv2?.m_appid ?? inv2?.appid ?? '') === '440' ||
				!!document.querySelector('#inventories .inventory_ctn[id*="_440_"]:not([style*="display: none"])');
			if (!CONFIG.backpackTfKey && activeIs440) {
				parts.push('<div class="sia-vc-sub"><a href="https://backpack.tf/developer" target="_blank" rel="noopener" ' +
					'style="color:#E8A33D">bp.tf values off — add your free API key in ⚙</a></div>');
			}
			if (bptf && bptfShow && activeIs440) {
				let tradRef = 0, tradCount = 0;
				for (const d of descs) {
					if (!d) continue;
					if ((d.tradable === 0 || d.tradable === false) && lockDaysCached(d) <= 0) continue;
					const v = refValueCached(d);
					if (v > 0) {
						tradRef += v;
						tradCount++;
					}
				}
				if (tradCount) {
					tradRef = Math.round(tradRef * 100) / 100;
					const m = refToMoney(tradRef);
					parts.push(`<div class="sia-vc-trad"><img src="${BPTF_ICON}">` +
						`${tradRef} ref${m ? ` · ${fmtMoney(m.v, m.sample)}` : ''}` +
						` <span class="sia-vc-sub">· ${tradCount} tradable</span></div>`);
				}
			}

			const noteHtml = buildPricingNote();
			if (noteHtml) parts.push(noteHtml);
		}

		const html = parts.join('');
		card.style.display = html ? '' : 'none';
		if (card.dataset.last !== html) {
			card.dataset.last = html;
			card.innerHTML = html;
			card.title = 'Metal · Steam market value (marketable) · bp.tf value of tradables';
		}
	}

	// ------------------------------------------------------------------
	// Duplicate tag filter (inventory pages only)
	// ------------------------------------------------------------------
	if (CONFIG.duplicateFilter && W.CInventory && W.Filter) {
		const belongsTo = (inv, item) =>
			item.appid == inv.appid && (inv.contextid == 0 || item.contextid == inv.contextid);

		const fromInventory = (inv, item) =>
			inv.contextid == item.contextid
				? inv.m_rgAssets[item.assetid]
				: fromInventory(inv.m_rgChildInventories[item.contextid], item);

		function tagDupes(inv, classids = {}) {
			if (inv._siaDupesTagged) return;
			for (const id of Object.keys(inv.m_rgAssets || {})) {
				const asset = inv.m_rgAssets[id];
				if (classids[asset.classid]) asset._siaDupe = true;
				else classids[asset.classid] = true;
			}
			for (const ctx of Object.keys(inv.m_rgChildInventories || {})) {
				tagDupes(inv.m_rgChildInventories[ctx], classids);
			}
			inv._siaDupesTagged = true;
		}

		const dupeCount = (inv) => {
			tagDupes(inv);
			return Object.values(inv.m_rgAssets || {}).filter((a) => a._siaDupe).length;
		};

		const origReadTags = W.CInventory.prototype.ReadTags;
		W.CInventory.prototype.ReadTags = function (...args) {
			origReadTags.apply(this, args);
			if (!this.tags) return;
			this.tags.misc = this.tags.misc || { name: 'Misc', tags: {} };
			this.tags.misc.tags._duplicate = {
				name: 'Duplicate',
				internal_name: '_duplicate',
				count: dupeCount(this),
			};
			// count trade-locked items into "Tradable" to match the filter behavior
			const tradableTag = this.tags.misc.tags.tradable;
			if (tradableTag) {
				const locked = Object.values(this.m_rgAssets || {})
					.filter((a) => a && a.description && lockDaysCached(a.description) > 0).length;
				tradableTag.count += locked;
			}
		};

		const origMatch = W.Filter.MatchItemTags;
		W.Filter.MatchItemTags = function (elItem, rgTags, ...rest) {
			const tags = [...rgTags];
			const idx = tags.indexOf('_duplicate');
			if (idx > -1) tags.splice(idx, 1);

			let matched = tags.length === 0 || origMatch.call(this, elItem, tags, ...rest);

			// trade-locked items become tradable soon; "Tradable" filter should show them
			if (!matched && tags.includes('tradable') && elItem.rgItem) {
				const d = descOf(elItem.rgItem);
				if (d && lockDaysCached(d) > 0) matched = true;
			}

			if (idx > -1 && belongsTo(W.g_ActiveInventory, elItem.rgItem)) {
				const inv = W.g_ActiveInventory;
				const counts = v2StackCounts.get(inv);
				if (counts) {
					// stacked: dupes are collapsed into their representative, so
					// "Duplicate" matches any stack that holds more than one copy
					matched = matched && (counts.get(stackKeyOf(elItem.rgItem)) || 0) > 1;
				} else {
					tagDupes(inv);
					matched = matched && !!fromInventory(inv, elItem.rgItem)._siaDupe;
				}
			}
			return matched;
		};
	}

	// ------------------------------------------------------------------
	// One-click gemify (Steam Community items, appid 753)
	// ------------------------------------------------------------------
	if (CONFIG.gemify && W.g_strProfileURL) {
		const fail = (msg) =>
			(W.ShowAlertDialog || ((t, m) => alert(m)))(
				'Action Failed', msg || 'There was an error communicating with the network. Please try again later.');

		W.GrindIntoGoo = async function (appid, contextid, assetid) {
			const params = {
				sessionid: W.g_sessionID,
				appid: String(appid),
				contextid: String(contextid),
				assetid: String(assetid),
			};
			try {
				const gooRes = await fetch(
					`${W.g_strProfileURL}/ajaxgetgoovalue/?${new URLSearchParams(params)}`,
					{ credentials: 'same-origin' });
				const goo = await gooRes.json();
				if (!gooRes.ok || !goo.goo_value) return fail(goo.message);

				params.goo_value_expected = goo.goo_value;
				const grindRes = await fetch(`${W.g_strProfileURL}/ajaxgrindintogoo/`, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams(params),
				});
				const result = await grindRes.json();
				if (!grindRes.ok || result.success !== 1) return fail(result.message);

				const el = document.getElementById(`753_6_${assetid}`);
				if (el) {
					el.classList.add('sia-gems');
					el.dataset.gemcount = goo.goo_value;
				}
			} catch {
				fail();
			}
		};
	}

	// ------------------------------------------------------------------
	// Multi-sell links (inventory pages only)
	// ------------------------------------------------------------------
	if (CONFIG.multiSell && W.PopulateMarketActions) {
		const origPopulate = W.PopulateMarketActions;
		W.PopulateMarketActions = function (elActions, item, ...rest) {
			origPopulate.call(this, elActions, item, ...rest);

			setTimeout(() => {
				const d = descOf(item);
				if (!d || !d.marketable || !d.market_hash_name || !d.commodity) return;

				const assets = W.g_ActiveInventory?.m_rgAssets || {};
				const count = Object.values(assets).filter((a) => {
					const ad = descOf(a);
					return ad && ad.marketable && ad.market_hash_name === d.market_hash_name;
				}).length;
				if (count < 2) return;

				const target = elActions.querySelector('div > div:nth-child(2)');
				if (!target || elActions.querySelector('.sia-multisell')) return;

				const link = document.createElement('div');
				link.className = 'sia-multisell';
				link.style.height = '24px';
				const a = document.createElement('a');
				a.href = `https://steamcommunity.com/market/multisell?appid=${item.appid}` +
					`&contextid=${item.contextid}&items[]=${encodeURIComponent(d.market_hash_name)}`;
				a.textContent = `Sell Multiple (${count})`;
				link.appendChild(a);
				target.parentNode.insertBefore(link, target);
			}, 1000);
		};
	}
})();
