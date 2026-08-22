/*
 * .RAW Sessions — Host Badge (v2)
 * ---------------------------------------------------------------------------
 * A single HOST badge coordinated across every crew member who has the studio
 * console open, so exactly one person is the active director at a time, control
 * can be handed off, and if the host drops the badge passes down a ranked order
 * (Greg -> RJ -> RAFA).
 *
 * TWO TRANSPORTS, chosen by CONFIG.workerUrl:
 *   - "" (empty)  -> LOCAL mode: BroadcastChannel + localStorage. Works across
 *                    tabs on ONE machine. Client-authoritative (cooperative).
 *   - a wss URL   -> SERVER mode: connects to the Cloudflare Worker/Durable
 *                    Object. Cross-machine, server-ENFORCED. The server owns the
 *                    badge, presence, hand-off and succession; this client just
 *                    sends claim/pass and renders whatever state it receives.
 *
 * Only edit to the app is a single <script src="./host.js" defer> include.
 */

"use strict";

/* ========================================================================
 * CONFIG
 * ====================================================================== */
const CONFIG = {
	// Leave "" for local same-machine mode. To go cross-machine, paste your
	// deployed Worker origin, e.g. "wss://raw-studio-host.<subdomain>.workers.dev"
	workerUrl: "wss://raw-studio-host.rovelo-ga.workers.dev",
	// Optional shared key — must match the Worker's AUTH_KEY secret if you set one.
	workerKey: ""
};

/* Crew roster + ranked succession order. Must match the Worker's ROSTER. */
const ROSTER = [
	{ id: "greg", name: "Greg", rank: 1 },
	{ id: "rj",   name: "RJ",   rank: 2 },
	{ id: "rafa", name: "RAFA", rank: 3 }
];

const HEARTBEAT_MS    = 3000;  // local mode: presence announce interval
const HOST_TIMEOUT_MS = 8000;  // local mode: stale-host threshold
const CLAIM_JITTER_MS = 250;   // local mode: successor stagger
const RECONNECT_MIN_MS = 1000; // server mode: reconnect backoff floor
const RECONNECT_MAX_MS = 10000;
const IDENTITY_KEY = "raw.host.identity";
const CHANNEL_NAME = "raw.host.channel";

/* ========================================================================
 * PURE LOGIC (unit-testable, no DOM) — used by LOCAL mode + tests.
 * ====================================================================== */
function rankOf(id) {
	const member = ROSTER.find(m => m.id === id);
	return member ? member.rank : Infinity;
}
function isEligible(id) {
	return rankOf(id) !== Infinity;
}
function rightfulHost(presentEligibleIds) {
	let best = null, bestRank = Infinity;
	for (const id of presentEligibleIds) {
		const r = rankOf(id);
		if (r < bestRank) { bestRank = r; best = id; }
	}
	return best;
}
function pickBadge(a, b) {
	if (!a) return b;
	if (!b) return a;
	if (a.term !== b.term) return a.term > b.term ? a : b;
	if (rankOf(a.hostId) !== rankOf(b.hostId)) {
		return rankOf(a.hostId) <= rankOf(b.hostId) ? a : b;
	}
	return a;
}
const RawHostLogic = { rankOf, isEligible, rightfulHost, pickBadge, ROSTER };
if (typeof window !== "undefined") window.RawHostLogic = RawHostLogic;

/* ========================================================================
 * RUNTIME
 * ====================================================================== */
const runtime = {
	mode: "local",                 // "local" | "server"
	identity: null,
	badge: { hostId: null, term: 0, updatedAt: 0 },
	presence: new Map(),           // local mode: id -> last-seen ms
	serverPresent: [],             // server mode: ids present per server
	connected: false,              // server mode socket state
	transport: null,               // local mode transport
	socket: null,                  // server mode socket
	reconnectTimer: null,
	reconnectDelay: RECONNECT_MIN_MS,
	heartbeatTimer: null,
	reconcileTimer: null,
	started: false,
	el: {}
};

function now() { return Date.now(); }
function amHost() { return runtime.identity && runtime.badge.hostId === runtime.identity; }
function nameOf(id) { const m = ROSTER.find(x => x.id === id); return m ? m.name : (id || "—"); }

function loadIdentity() {
	try {
		const saved = localStorage.getItem(IDENTITY_KEY);
		if (saved && ROSTER.some(m => m.id === saved)) return saved;
	} catch (e) {}
	return null;
}
function saveIdentity(id) { try { localStorage.setItem(IDENTITY_KEY, id); } catch (e) {} }

function getRoom() {
	try {
		if (window.studioApp && window.studioApp.state && window.studioApp.state.room) {
			return window.studioApp.state.room;
		}
	} catch (e) {}
	const p = new URLSearchParams(window.location.search);
	return p.get("room") || p.get("r") || p.get("director") || p.get("dir") || "default";
}

/* ========================================================================
 * PUBLIC ACTIONS (branch by transport mode)
 * ====================================================================== */
function claimHost(reason) {
	if (!isEligible(runtime.identity)) return;
	if (runtime.mode === "server") {
		sendSocket({ type: "claim" });
	} else {
		runtime.badge = { hostId: runtime.identity, term: runtime.badge.term + 1, updatedAt: now() };
		broadcastLocalState();
		render();
	}
}
function passHostTo(targetId) {
	if (!amHost() || !isEligible(targetId) || targetId === runtime.identity) return;
	if (runtime.mode === "server") {
		sendSocket({ type: "pass", target: targetId });
	} else {
		runtime.badge = { hostId: targetId, term: runtime.badge.term + 1, updatedAt: now() };
		broadcastLocalState();
		render();
	}
}

/* ========================================================================
 * SERVER MODE — Cloudflare Worker / Durable Object over WebSocket
 * ====================================================================== */
function sendSocket(obj) {
	if (runtime.socket && runtime.socket.readyState === WebSocket.OPEN) {
		try { runtime.socket.send(JSON.stringify(obj)); } catch (e) {}
	}
}

function connectSocket() {
	if (!runtime.identity) return;
	closeSocket();
	const base = CONFIG.workerUrl.replace(/\/+$/, "");
	const room = encodeURIComponent(getRoom());
	const params = new URLSearchParams({ id: runtime.identity, name: nameOf(runtime.identity) });
	if (CONFIG.workerKey) params.set("key", CONFIG.workerKey);
	const url = `${base}/room/${room}?${params.toString()}`;

	let socket;
	try { socket = new WebSocket(url); }
	catch (e) { scheduleReconnect(); return; }
	runtime.socket = socket;

	socket.addEventListener("open", () => {
		runtime.connected = true;
		runtime.reconnectDelay = RECONNECT_MIN_MS;
		render();
	});
	socket.addEventListener("message", event => {
		let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
		if (msg.type === "state") {
			runtime.badge = msg.badge || { hostId: null, term: 0, updatedAt: 0 };
			runtime.serverPresent = Array.isArray(msg.present) ? msg.present : [];
			render();
		}
	});
	socket.addEventListener("close", () => {
		runtime.connected = false;
		render();
		scheduleReconnect();
	});
	socket.addEventListener("error", () => {
		try { socket.close(); } catch (e) {}
	});
}

function closeSocket() {
	if (runtime.socket) {
		try { runtime.socket.onclose = null; runtime.socket.close(); } catch (e) {}
		runtime.socket = null;
	}
}

function scheduleReconnect() {
	if (!runtime.identity || runtime.mode !== "server") return;
	clearTimeout(runtime.reconnectTimer);
	runtime.reconnectTimer = setTimeout(connectSocket, runtime.reconnectDelay);
	runtime.reconnectDelay = Math.min(runtime.reconnectDelay * 2, RECONNECT_MAX_MS);
}

/* ========================================================================
 * LOCAL MODE — BroadcastChannel + localStorage (client-authoritative)
 * ====================================================================== */
function createLocalTransport(onMessage) {
	let channel = null;
	try {
		channel = new BroadcastChannel(CHANNEL_NAME);
		channel.onmessage = event => onMessage(event.data);
	} catch (e) { channel = null; }
	return {
		post(msg) {
			try { channel && channel.postMessage(msg); } catch (e) {}
			if (msg.type === "state") {
				try { localStorage.setItem(CHANNEL_NAME, JSON.stringify(msg.state)); } catch (e) {}
			}
		},
		readPersisted() {
			try { return JSON.parse(localStorage.getItem(CHANNEL_NAME) || "null"); }
			catch (e) { return null; }
		}
	};
}
function broadcastLocalState() {
	runtime.transport.post({ type: "state", state: runtime.badge });
}
function setBadgeLocal(next) {
	const winner = pickBadge(runtime.badge, next);
	if (winner === runtime.badge && !(next.term === runtime.badge.term && next.hostId === runtime.badge.hostId)) return;
	runtime.badge = { hostId: winner.hostId, term: winner.term, updatedAt: winner.updatedAt || now() };
	render();
}
function localHeartbeat() {
	if (!runtime.identity) return;
	runtime.presence.set(runtime.identity, now());
	runtime.transport.post({ type: "heartbeat", id: runtime.identity, ts: now() });
}
function localPresentEligible() {
	const cutoff = now() - HOST_TIMEOUT_MS;
	const ids = [];
	for (const [id, ts] of runtime.presence.entries()) {
		if (isEligible(id) && ts >= cutoff) ids.push(id);
	}
	return ids;
}
function localReconcile() {
	if (!runtime.identity) return;
	const hostAlive = runtime.badge.hostId &&
		runtime.presence.has(runtime.badge.hostId) &&
		(now() - runtime.presence.get(runtime.badge.hostId)) < HOST_TIMEOUT_MS;
	if (hostAlive) { render(); return; }
	const successor = rightfulHost(localPresentEligible());
	if (successor && successor === runtime.identity) {
		setTimeout(() => {
			const stillVacant = !(runtime.badge.hostId &&
				runtime.presence.has(runtime.badge.hostId) &&
				(now() - runtime.presence.get(runtime.badge.hostId)) < HOST_TIMEOUT_MS);
			if (stillVacant && rightfulHost(localPresentEligible()) === runtime.identity) {
				runtime.badge = { hostId: runtime.identity, term: runtime.badge.term + 1, updatedAt: now() };
				broadcastLocalState();
				render();
			}
		}, CLAIM_JITTER_MS * rankOf(runtime.identity));
	}
	render();
}
function handleLocalMessage(msg) {
	if (!msg || typeof msg !== "object") return;
	if (msg.type === "state" && msg.state) setBadgeLocal(msg.state);
	else if (msg.type === "heartbeat" && msg.id) runtime.presence.set(msg.id, msg.ts || now());
	else if (msg.type === "hello") { if (runtime.badge.hostId) broadcastLocalState(); localHeartbeat(); }
}

/* Start whichever transport this console is configured for, once identity set. */
function startTransport() {
	if (runtime.mode === "server") {
		connectSocket();
	} else {
		clearInterval(runtime.heartbeatTimer);
		clearInterval(runtime.reconcileTimer);
		localHeartbeat();
		runtime.transport.post({ type: "hello" });
		runtime.heartbeatTimer = setInterval(localHeartbeat, HEARTBEAT_MS);
		runtime.reconcileTimer = setInterval(localReconcile, 1500);
	}
}

function chooseIdentity(id) {
	runtime.identity = id;
	if (isEligible(id)) saveIdentity(id);
	startTransport();
	render();
}

/* =======================================================================
 * UI (injected)
 * ===================================================================== */
function injectStyles() {
	const css = `
	.raw-host-badge{display:inline-flex;align-items:center;gap:8px;font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;
		font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#948B7E;padding:5px 10px;border:1px solid #2a2725;
		border-radius:6px;background:#141312;white-space:nowrap}
	.raw-host-badge .rh-dot{width:8px;height:8px;border-radius:50%;background:#3a3632;flex:0 0 auto}
	.raw-host-badge[data-self="host"]{border-color:rgba(214,65,43,.5);color:#E6DFD2}
	.raw-host-badge[data-self="host"] .rh-dot{background:#D6412B}
	.raw-host-badge[data-offline="true"]{opacity:.55}
	.raw-host-badge b{color:#E6DFD2;font-weight:500}
	.raw-host-control{display:flex;align-items:center;gap:6px;margin-left:8px}
	.raw-host-controls select,.raw-host-controls button{font:inherit;font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;
		font-size:11px;color:#E6DFD2;background:#1c1c1f;border:1px solid #3a3a3e;border-radius:4px;padding:4px 8px;cursor:pointer}
	.raw-host-controls button:hover{border-color:#C6763B}
	.raw-host-controls .rh-primary{border-color:rgba(214,65,43,.6)}
	.raw-identity-pick{display:flex;align-items:center;gap:6px}
	.studio-workspace[data-raw-self="standby"] .program-toolbar__actions,
	.studio-workspace[data-raw-self="standby"] .layout-strip,
	.studio-workspace[data-raw-self="standby"] .control-panel [data-panel] .source-card__actions,
	.studio-workspace[data-raw-self="standby"] .panel-heading__actions{
		opacity:.4;pointer-events:none;filter:grayscale(.4)}
	.raw-standby-ribbon{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9998;
		display:none;align-items:center;gap:12px;background:rgba(20,19,18,.94);border:1px solid rgba(198,118,59,.4);
		border-radius:8px;padding:9px 14px;font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;
		color:#E6DFD2;letter-spacing:.04em}
	body[data-raw-self="standby"] .raw-standby-ribbon{display:flex}
	.raw-standby-ribbon .rh-tag{color:#C6763B;text-transform:uppercase;letter-spacing:.2em;font-size:10px}
	.raw-standby-ribbon button{font:inherit;font-family:inherit;font-size:11px;color:#E6DFD2;background:#1c1c1f;
		border:1px solid #3a3a3e;border-radius:4px;padding:5px 10px;cursor:pointer}
	.raw-standby-ribbon button:hover{border-color:#D6412B}
	`;
	const style = document.createElement("style");
	style.id = "raw-host-styles";
	style.textContent = css;
	document.head.appendChild(style);
}

function buildUI() {
	const statusBar = document.querySelector(".topbar__status");
	const host = document.createElement("div");
	host.className = "raw-host-badge";
	host.innerHTML = `<span class="rh-dot"></span><span class="rh-label">HOST</span>&nbsp;<b class="rh-name">—</b>`;
	const controls = document.createElement("div");
	controls.className = "raw-host-controls";
	if (statusBar) {
		statusBar.insertBefore(host, statusBar.firstChild);
		statusBar.insertBefore(controls, host.nextSibling);
	}
	const ribbon = document.createElement("div");
	ribbon.className = "raw-standby-ribbon";
	ribbon.innerHTML = `<span class="rh-tag">Standby</span><span class="rh-msg"></span>
		<button type="button" class="rh-take">Take control</button>`;
	document.body.appendChild(ribbon);
	ribbon.querySelector(".rh-take").addEventListener("click", () => claimHost("manual take"));
	runtime.el = { host, controls, ribbon, name: host.querySelector(".rh-name") };
}

function render() {
	const workspace = document.querySelector(".studio-workspace");
	const self = !runtime.identity ? "observer" : amHost() ? "host" : "standby";
	if (workspace) workspace.dataset.rawSelf = self;
	document.body.dataset.rawSelf = self;
	if (!runtime.el.host) return;

	const offline = runtime.mode === "server" && !runtime.connected;
	runtime.el.host.dataset.self = amHost() ? "host" : "other";
	runtime.el.host.dataset.offline = offline ? "true" : "false";
	runtime.el.name.textContent = offline
		? "connecting…"
		: (runtime.badge.hostId ? nameOf(runtime.badge.hostId) : "unclaimed");

	const c = runtime.el.controls;
	c.innerHTML = "";

	if (!runtime.identity) {
		const wrap = document.createElement("div");
		wrap.className = "raw-identity-pick";
		const sel = document.createElement("select");
		sel.innerHTML = `<option value="">I am…</option>` +
			ROSTER.map(m => `<option value="${m.id}">${m.name}</option>`).join("") +
			`<option value="guest">Guest (no control)</option>`;
		sel.addEventListener("change", () => {
			if (!sel.value) return;
			chooseIdentity(sel.value === "guest" ? "guest" : sel.value);
		});
		wrap.appendChild(sel);
		c.appendChild(wrap);
		return;
	}

	if (amHost()) {
		const eligible = ROSTER.filter(m => m.id !== runtime.identity);
		const sel = document.createElement("select");
		sel.innerHTML = `<option value="">Pass host…</option>` +
			eligible.map(m => `<option value="${m.id}">→ ${m.name}</option>`).join("");
		sel.addEventListener("change", () => { if (sel.value) { passHostTo(sel.value); sel.value = ""; } });
		c.appendChild(sel);
	} else if (isEligible(runtime.identity)) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "rh-primary";
		btn.textContent = "Take control";
		btn.addEventListener("click", () => claimHost("manual take"));
		c.appendChild(btn);
	}

	if (runtime.el.ribbon) {
		const msg = runtime.el.ribbon.querySelector(".rh-msg");
		const take = runtime.el.ribbon.querySelector(".rh-take");
		if (msg) msg.innerHTML = runtime.badge.hostId ? `<b>${nameOf(runtime.badge.hostId)}</b> has control` : `No host yet`;
		if (take) take.style.display = isEligible(runtime.identity) ? "" : "none";
	}
}

/* =======================================================================
 * LIFECYCLE
 * ====================================================================== */
function init() {
	if (runtime.started) return;
	runtime.started = true;

	runtime.mode = CONFIG.workerUrl ? "server" : "local";

	if (runtime.mode === "local") {
		runtime.transport = createLocalTransport(handleLocalMessage);
		const persisted = runtime.transport.readPersisted();
		if (persisted && persisted.hostId) runtime.badge = persisted;
	}

	runtime.identity = loadIdentity();

	injectStyles();
	buildUI();
	render();

	if (runtime.identity) startTransport();

	window.addEventListener("beforeunload", () => {
		clearInterval(runtime.heartbeatTimer);
		clearInterval(runtime.reconcileTimer);
		clearTimeout(runtime.reconnectTimer);
		closeSocket();
	});

	window.RawHost = {
		runtime,
		claimHost,
		passHostTo,
		setIdentity: chooseIdentity,
		state() {
			return {
				mode: runtime.mode,
				identity: runtime.identity,
				badge: runtime.badge,
				present: runtime.mode === "server" ? runtime.serverPresent : localPresentEligible(),
				connected: runtime.connected
			};
		}
	};
}

/* Init once the studio workspace is showing (post-gate). */
function waitForStudio() {
	const root = document.getElementById("studio-root");
	if (!root) { window.addEventListener("DOMContentLoaded", waitForStudio, { once: true }); return; }
	if (root.dataset.state === "studio") { init(); return; }
	const observer = new MutationObserver(() => {
		if (root.dataset.state === "studio") { observer.disconnect(); init(); }
	});
	observer.observe(root, { attributes: true, attributeFilter: ["data-state"] });
}

if (typeof document !== "undefined") {
	waitForStudio();
}

// Node/CommonJS export so the pure succession logic can be unit-tested.
if (typeof module !== "undefined" && module.exports) {
	module.exports = RawHostLogic;
}
