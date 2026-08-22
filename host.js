/*
 * .RAW Sessions — Host Badge (v3, universal identity)
 * ---------------------------------------------------------------------------
 * A single HOST badge coordinated across everyone who opens the studio console.
 * Universal identity: each person self-submits a display name at a small join
 * card; an optional CREW CODE makes them "crew" (host-eligible). Guests connect
 * but can never hold the badge. Succession is by SENIORITY — if the host drops,
 * the earliest-joined crew member still present becomes host.
 *
 * TWO TRANSPORTS, chosen by CONFIG.workerUrl:
 *   - "" (empty)  -> LOCAL mode: BroadcastChannel + localStorage (one machine,
 *                    everyone treated as crew; for offline testing).
 *   - a wss URL   -> SERVER mode: Cloudflare Worker / Durable Object. Server
 *                    owns roles, presence, hand-off and seniority succession.
 *
 * Only edit to the app is a single <script src="./host.js" defer> include.
 */

"use strict";

/* ========================================================================
 * CONFIG
 * ====================================================================== */
const CONFIG = {
	// "" = local same-machine mode. Set to your deployed Worker for cross-machine.
	workerUrl: "wss://raw-studio-host.rovelo-ga.workers.dev",
};

const HEARTBEAT_MS     = 3000;   // local mode presence announce
const PRESENCE_TTL_MS  = 8000;   // local mode stale threshold
const RECONNECT_MIN_MS = 1000;   // server mode reconnect backoff floor
const RECONNECT_MAX_MS = 10000;
const CLIENT_ID_KEY = "raw.host.clientId";
const IDENTITY_KEY  = "raw.host.identity";   // { name, code }
const CHANNEL_NAME  = "raw.host.channel";

/* ========================================================================
 * RUNTIME
 * ====================================================================== */
const runtime = {
	mode: "local",
	clientId: null,
	name: null,                    // self-submitted display name (null until joined)
	code: "",                      // crew code (kept in memory / localStorage)
	badge: { hostId: null, term: 0, updatedAt: 0 },
	members: [],                   // [{id,name,role}] — from server, or derived locally
	connected: false,
	socket: null,
	transport: null,               // local transport
	localPresence: new Map(),      // local mode: id -> {name, joinedAt, ts}
	reconnectTimer: null,
	reconnectDelay: RECONNECT_MIN_MS,
	heartbeatTimer: null,
	reconcileTimer: null,
	joinedAt: 0,
	started: false,
	el: {}
};

function now() { return Date.now(); }
function amHost() { return runtime.clientId && runtime.badge.hostId === runtime.clientId; }
function memberById(id) { return runtime.members.find(m => m.id === id) || null; }
function myMember() { return memberById(runtime.clientId); }
function myRole() { const m = myMember(); return m ? m.role : (runtime.name ? "crew" : null); }
function nameOfId(id) { const m = memberById(id); return m ? m.name : (id ? "…" : "—"); }
function presentCrew() {
	return runtime.members.filter(m => m.role === "crew").sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

/* ---- identity persistence ---- */
function getClientId() {
	try {
		let v = localStorage.getItem(CLIENT_ID_KEY);
		if (!v) {
			v = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("c" + now() + Math.floor(Math.random() * 1e9));
			localStorage.setItem(CLIENT_ID_KEY, v);
		}
		return v;
	} catch (e) {
		return "c" + now() + Math.floor(Math.random() * 1e9);
	}
}
function loadIdentity() {
	try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null"); } catch (e) { return null; }
}
function saveIdentity(name, code) {
	try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name, code })); } catch (e) {}
}
function clearIdentity() {
	try { localStorage.removeItem(IDENTITY_KEY); } catch (e) {}
}

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
 * PUBLIC ACTIONS
 * ====================================================================== */
function claimHost() {
	if (myRole() !== "crew") return;
	if (runtime.mode === "server") sendSocket({ type: "claim" });
	else { runtime.badge = { hostId: runtime.clientId, term: runtime.badge.term + 1, updatedAt: now() }; broadcastLocalState(); render(); }
}
function passHostTo(targetId) {
	if (!amHost() || !targetId || targetId === runtime.clientId) return;
	if (runtime.mode === "server") sendSocket({ type: "pass", target: targetId });
	else { runtime.badge = { hostId: targetId, term: runtime.badge.term + 1, updatedAt: now() }; broadcastLocalState(); render(); }
}
/* Host-only: let a knocking guest in, or turn them away (server mode). */
function admitGuest(id) { if (myRole() === "crew") sendSocket({ type: "admit", target: id }); }
function denyGuest(id)  { if (myRole() === "crew") sendSocket({ type: "deny",  target: id }); }
function knockingGuests() { return runtime.members.filter(m => m.role === "guest" && !m.admitted); }

/* Called from the join card. */
function joinAs(name, code) {
	name = (name || "").trim().slice(0, 60);
	if (!name) return;
	runtime.name = name;
	runtime.code = code || "";
	runtime.joinedAt = now();
	saveIdentity(runtime.name, runtime.code);
	startTransport();
	render();
}
function leave() {
	clearIdentity();
	runtime.name = null;
	runtime.code = "";
	closeSocket();
	clearInterval(runtime.heartbeatTimer);
	clearInterval(runtime.reconcileTimer);
	runtime.localPresence.clear();
	render();
}

/* ========================================================================
 * SERVER MODE
 * ====================================================================== */
function sendSocket(obj) {
	if (runtime.socket && runtime.socket.readyState === WebSocket.OPEN) {
		try { runtime.socket.send(JSON.stringify(obj)); } catch (e) {}
	}
}
function connectSocket() {
	if (!runtime.name) return;
	closeSocket();
	const base = CONFIG.workerUrl.replace(/\/+$/, "");
	const params = new URLSearchParams({ id: runtime.clientId, name: runtime.name, code: runtime.code || "" });
	const url = `${base}/room/${encodeURIComponent(getRoom())}?${params.toString()}`;

	let socket;
	try { socket = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
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
			runtime.members = Array.isArray(msg.members) ? msg.members : [];
			// Guests belong in the branded greenroom, not the director console.
			if (myRole() === "guest" && !runtime._redirected) {
				runtime._redirected = true;
				location.replace("greenroom.html?room=" + encodeURIComponent(getRoom()) + "&name=" + encodeURIComponent(runtime.name || ""));
				return;
			}
			render();
		}
	});
	socket.addEventListener("close", () => { runtime.connected = false; render(); scheduleReconnect(); });
	socket.addEventListener("error", () => { try { socket.close(); } catch (e) {} });
}
function closeSocket() {
	if (runtime.socket) {
		try { runtime.socket.onclose = null; runtime.socket.close(); } catch (e) {}
		runtime.socket = null;
	}
	runtime.connected = false;
}
function scheduleReconnect() {
	if (!runtime.name || runtime.mode !== "server") return;
	clearTimeout(runtime.reconnectTimer);
	runtime.reconnectTimer = setTimeout(connectSocket, runtime.reconnectDelay);
	runtime.reconnectDelay = Math.min(runtime.reconnectDelay * 2, RECONNECT_MAX_MS);
}

/* ========================================================================
 * LOCAL MODE (offline fallback; everyone treated as crew)
 * ====================================================================== */
function createLocalTransport(onMessage) {
	let channel = null;
	try { channel = new BroadcastChannel(CHANNEL_NAME); channel.onmessage = e => onMessage(e.data); }
	catch (e) { channel = null; }
	return {
		post(msg) {
			try { channel && channel.postMessage(msg); } catch (e) {}
			if (msg.type === "state") { try { localStorage.setItem(CHANNEL_NAME, JSON.stringify(msg.state)); } catch (e) {} }
		},
		readPersisted() { try { return JSON.parse(localStorage.getItem(CHANNEL_NAME) || "null"); } catch (e) { return null; } }
	};
}
function broadcastLocalState() { runtime.transport.post({ type: "state", state: runtime.badge }); }
function localHeartbeat() {
	if (!runtime.name) return;
	runtime.localPresence.set(runtime.clientId, { name: runtime.name, joinedAt: runtime.joinedAt, ts: now() });
	runtime.transport.post({ type: "heartbeat", id: runtime.clientId, name: runtime.name, joinedAt: runtime.joinedAt, ts: now() });
	rebuildLocalMembers();
}
function rebuildLocalMembers() {
	const cutoff = now() - PRESENCE_TTL_MS;
	const list = [];
	for (const [id, p] of runtime.localPresence.entries()) {
		if (p.ts >= cutoff) list.push({ id, name: p.name, role: "crew", joinedAt: p.joinedAt });
	}
	runtime.members = list;
}
function localReconcile() {
	if (!runtime.name) return;
	rebuildLocalMembers();
	const hostAlive = runtime.badge.hostId && runtime.members.some(m => m.id === runtime.badge.hostId);
	if (!hostAlive) {
		const succ = presentCrew()[0];
		if (succ && succ.id === runtime.clientId) {
			runtime.badge = { hostId: runtime.clientId, term: runtime.badge.term + 1, updatedAt: now() };
			broadcastLocalState();
		}
	}
	render();
}
function handleLocalMessage(msg) {
	if (!msg || typeof msg !== "object") return;
	if (msg.type === "state" && msg.state) {
		if (!runtime.badge || msg.state.term >= runtime.badge.term) { runtime.badge = msg.state; render(); }
	} else if (msg.type === "heartbeat" && msg.id) {
		runtime.localPresence.set(msg.id, { name: msg.name, joinedAt: msg.joinedAt, ts: msg.ts || now() });
		rebuildLocalMembers(); render();
	} else if (msg.type === "hello") {
		if (runtime.badge.hostId) broadcastLocalState();
		localHeartbeat();
	}
}

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

/* ========================================================================
 * UI
 * ====================================================================== */
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
	.raw-host-controls{display:flex;align-items:center;gap:6px;margin-left:8px}
	.raw-host-controls select,.raw-host-controls button{font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;
		font-size:11px;color:#E6DFD2;background:#1c1c1f;border:1px solid #3a3a3e;border-radius:4px;padding:4px 8px;cursor:pointer}
	.raw-host-controls button:hover{border-color:#C6763B}
	.raw-host-controls .rh-primary{border-color:rgba(214,65,43,.6)}
	.raw-host-controls .rh-you{color:#948B7E;font-size:10px;letter-spacing:.14em;text-transform:uppercase}
	.raw-host-controls .rh-you b{color:#E6DFD2}
	.raw-host-controls .rh-leave{border:none;background:none;color:#6f685e;padding:2px 4px}
	.raw-host-controls .rh-leave:hover{color:#D6412B}
	.raw-host-controls .rh-guest{color:#948B7E;font-size:10px;letter-spacing:.14em;text-transform:uppercase;border:1px solid #2a2725;border-radius:4px;padding:4px 8px}
	/* Standby lock */
	.studio-workspace[data-raw-self="standby"] .program-toolbar__actions,
	.studio-workspace[data-raw-self="standby"] .layout-strip,
	.studio-workspace[data-raw-self="standby"] .control-panel [data-panel] .source-card__actions,
	.studio-workspace[data-raw-self="standby"] .panel-heading__actions{opacity:.4;pointer-events:none;filter:grayscale(.4)}
	.raw-standby-ribbon{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9998;display:none;align-items:center;
		gap:12px;background:rgba(20,19,18,.94);border:1px solid rgba(198,118,59,.4);border-radius:8px;padding:9px 14px;
		font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:#E6DFD2;letter-spacing:.04em}
	body[data-raw-self="standby"] .raw-standby-ribbon{display:flex}
	.raw-standby-ribbon .rh-tag{color:#C6763B;text-transform:uppercase;letter-spacing:.2em;font-size:10px}
	.raw-standby-ribbon button{font-family:inherit;font-size:11px;color:#E6DFD2;background:#1c1c1f;border:1px solid #3a3a3e;
		border-radius:4px;padding:5px 10px;cursor:pointer}
	.raw-standby-ribbon button:hover{border-color:#D6412B}
	/* Knocking tray (host sees guests waiting to be let in) */
	.raw-knock{position:fixed;right:18px;top:64px;z-index:9997;width:280px;display:none;flex-direction:column;
		background:rgba(20,19,18,.97);border:1px solid rgba(198,118,59,.35);border-radius:10px;overflow:hidden;
		box-shadow:0 18px 50px rgba(0,0,0,.5);font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace}
	.raw-knock[data-show="true"]{display:flex}
	.raw-knock .kh{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06);font-size:10px;letter-spacing:.2em;
		text-transform:uppercase;color:#C6763B;display:flex;align-items:center;gap:8px}
	.raw-knock .kh .n{margin-left:auto;color:#8f877b}
	.raw-knock .krow{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04)}
	.raw-knock .krow:last-child{border-bottom:0}
	.raw-knock .krow .nm{flex:1;min-width:0;font-size:13px;color:#E6DFD2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.raw-knock .krow button{font-family:inherit;font-size:11px;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
	.raw-knock .krow .admit{background:var(--accent,#C6763B);color:#1a120b;font-weight:600}
	.raw-knock .krow .deny{background:#1c1c1f;color:#8f877b}
	.raw-knock .krow .deny:hover{color:#D6412B}
	/* Join card (identity gate) */
	.raw-join-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;
		background:rgba(8,7,6,.72);backdrop-filter:blur(3px)}
	.raw-join-overlay[data-show="true"]{display:flex}
	.raw-join-card{width:340px;max-width:90vw;background:#141312;border:1px solid #2a2725;border-left:2px solid #C6763B;
		border-radius:10px;padding:22px 22px 20px;font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#E6DFD2;
		box-shadow:0 20px 60px rgba(0,0,0,.55)}
	.raw-join-card .rj-brand{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
	.raw-join-card .rj-brand .d{width:8px;height:8px;border-radius:50%;background:#D6412B;transform:translateY(-1px)}
	.raw-join-card .rj-brand .w{font-size:15px}.raw-join-card .rj-brand .w .a{color:#C6763B}
	.raw-join-card .rj-sub{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:#948B7E;margin-bottom:18px}
	.raw-join-card label{display:block;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#948B7E;margin:0 0 5px}
	.raw-join-card input{width:100%;box-sizing:border-box;background:#0d0c0b;border:1px solid #2a2725;border-radius:6px;
		color:#E6DFD2;font-family:inherit;font-size:14px;padding:9px 11px;margin-bottom:14px;letter-spacing:.02em}
	.raw-join-card input:focus{outline:none;border-color:#C6763B}
	.raw-join-card .rj-hint{font-size:10px;color:#6f685e;margin:-10px 0 14px}
	.raw-join-card button{width:100%;background:#1c1c1f;border:1px solid rgba(214,65,43,.6);border-radius:6px;color:#E6DFD2;
		font-family:inherit;font-size:13px;letter-spacing:.1em;text-transform:uppercase;padding:11px;cursor:pointer;
		display:flex;align-items:center;justify-content:center;gap:8px}
	.raw-join-card button:hover{background:#241614}
	.raw-join-card button .d{width:7px;height:7px;border-radius:50%;background:#D6412B}
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
	ribbon.querySelector(".rh-take").addEventListener("click", () => claimHost());

	// Knocking tray (host-only; shows guests waiting in the greenroom)
	const knock = document.createElement("div");
	knock.className = "raw-knock";
	document.body.appendChild(knock);

	// Join card (identity gate)
	const overlay = document.createElement("div");
	overlay.className = "raw-join-overlay";
	overlay.innerHTML = `
		<form class="raw-join-card" autocomplete="off">
			<div class="rj-brand"><span class="d"></span><span class="w"><span class="a">.RAW</span> SESSIONS</span></div>
			<div class="rj-sub">Enter the Studio</div>
			<label>Your name</label>
			<input class="rj-name" type="text" maxlength="60" placeholder="e.g. Greg" autocomplete="off" />
			<label>Crew code <span style="color:#6f685e">(optional)</span></label>
			<input class="rj-code" type="password" maxlength="80" placeholder="Leave blank to join as guest" autocomplete="off" />
			<div class="rj-hint">Crew can direct and hold the host badge. Guests join without control.</div>
			<button type="submit"><span class="d"></span> Enter Studio</button>
		</form>`;
	document.body.appendChild(overlay);
	overlay.querySelector("form").addEventListener("submit", e => {
		e.preventDefault();
		joinAs(overlay.querySelector(".rj-name").value, overlay.querySelector(".rj-code").value);
	});

	runtime.el = {
		host, controls, ribbon, overlay, knock,
		name: host.querySelector(".rh-name"),
		nameInput: overlay.querySelector(".rj-name"),
		codeInput: overlay.querySelector(".rj-code")
	};
}

function render() {
	const joined = Boolean(runtime.name);
	const role = myRole();
	const workspace = document.querySelector(".studio-workspace");
	const self = !joined ? "observer" : (amHost() ? "host" : (role === "crew" ? "standby" : "observer"));
	if (workspace) workspace.dataset.rawSelf = self;
	document.body.dataset.rawSelf = self;

	// Join card visibility
	if (runtime.el.overlay) runtime.el.overlay.dataset.show = joined ? "false" : "true";
	if (!joined && runtime.el.nameInput && document.activeElement !== runtime.el.nameInput) {
		// prefill focus once shown
		setTimeout(() => { try { runtime.el.nameInput.focus(); } catch (e) {} }, 50);
	}
	if (!runtime.el.host) return;

	const offline = joined && runtime.mode === "server" && !runtime.connected;
	runtime.el.host.dataset.self = amHost() ? "host" : "other";
	runtime.el.host.dataset.offline = offline ? "true" : "false";
	runtime.el.name.textContent = !joined ? "—"
		: offline ? "connecting…"
		: (runtime.badge.hostId ? nameOfId(runtime.badge.hostId) : "unclaimed");

	const c = runtime.el.controls;
	c.innerHTML = "";
	if (!joined) return;

	// "You are <name>" + leave
	const you = document.createElement("span");
	you.className = "rh-you";
	you.innerHTML = `You: <b>${escapeHtml(runtime.name)}</b>`;
	c.appendChild(you);

	if (role === "guest") {
		const g = document.createElement("span");
		g.className = "rh-guest";
		g.textContent = "Guest";
		c.appendChild(g);
	} else if (amHost()) {
		const others = presentCrew().filter(m => m.id !== runtime.clientId);
		const sel = document.createElement("select");
		sel.innerHTML = `<option value="">Pass host…</option>` +
			others.map(m => `<option value="${escapeHtml(m.id)}">→ ${escapeHtml(m.name)}</option>`).join("");
		sel.disabled = others.length === 0;
		sel.addEventListener("change", () => { if (sel.value) { passHostTo(sel.value); sel.value = ""; } });
		c.appendChild(sel);
	} else if (role === "crew") {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "rh-primary";
		btn.textContent = "Take control";
		btn.addEventListener("click", () => claimHost());
		c.appendChild(btn);
	}

	const leaveBtn = document.createElement("button");
	leaveBtn.type = "button";
	leaveBtn.className = "rh-leave";
	leaveBtn.title = "Leave / switch identity";
	leaveBtn.textContent = "⎋";
	leaveBtn.addEventListener("click", leave);
	c.appendChild(leaveBtn);

	if (runtime.el.ribbon) {
		const msg = runtime.el.ribbon.querySelector(".rh-msg");
		const take = runtime.el.ribbon.querySelector(".rh-take");
		if (msg) msg.innerHTML = runtime.badge.hostId ? `<b>${escapeHtml(nameOfId(runtime.badge.hostId))}</b> has control` : `No host yet`;
		if (take) take.style.display = role === "crew" ? "" : "none";
	}

	// Knocking tray — only crew can admit; hidden when nobody is waiting.
	if (runtime.el.knock) {
		const knockers = (role === "crew") ? knockingGuests() : [];
		runtime.el.knock.dataset.show = knockers.length ? "true" : "false";
		if (knockers.length) {
			runtime.el.knock.innerHTML =
				`<div class="kh">Greenroom<span class="n">${knockers.length} waiting</span></div>` +
				knockers.map(m =>
					`<div class="krow"><span class="nm">${escapeHtml(m.name)}</span>` +
					`<button class="admit" data-admit="${escapeHtml(m.id)}">Admit</button>` +
					`<button class="deny" data-deny="${escapeHtml(m.id)}">Deny</button></div>`
				).join("");
			runtime.el.knock.querySelectorAll("[data-admit]").forEach(b =>
				b.addEventListener("click", () => admitGuest(b.getAttribute("data-admit"))));
			runtime.el.knock.querySelectorAll("[data-deny]").forEach(b =>
				b.addEventListener("click", () => denyGuest(b.getAttribute("data-deny"))));
		}
	}
}

function escapeHtml(s) {
	return String(s || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/* ========================================================================
 * LIFECYCLE
 * ====================================================================== */
function init() {
	if (runtime.started) return;
	runtime.started = true;

	runtime.mode = CONFIG.workerUrl ? "server" : "local";
	runtime.clientId = getClientId();

	if (runtime.mode === "local") {
		runtime.transport = createLocalTransport(handleLocalMessage);
		const persisted = runtime.transport.readPersisted();
		if (persisted && persisted.hostId) runtime.badge = persisted;
	}

	injectStyles();
	buildUI();

	// Auto-rejoin if we have a saved identity.
	const saved = loadIdentity();
	if (saved && saved.name) {
		runtime.name = saved.name;
		runtime.code = saved.code || "";
		runtime.joinedAt = now();
		startTransport();
	}
	render();

	window.addEventListener("beforeunload", () => {
		clearInterval(runtime.heartbeatTimer);
		clearInterval(runtime.reconcileTimer);
		clearTimeout(runtime.reconnectTimer);
		closeSocket();
	});

	window.RawHost = {
		runtime, claimHost, passHostTo, joinAs, leave, admitGuest, denyGuest,
		state() {
			return {
				mode: runtime.mode, clientId: runtime.clientId, name: runtime.name,
				role: myRole(), badge: runtime.badge, members: runtime.members, connected: runtime.connected
			};
		}
	};
}

function waitForStudio() {
	const root = document.getElementById("studio-root");
	if (!root) { window.addEventListener("DOMContentLoaded", waitForStudio, { once: true }); return; }
	if (root.dataset.state === "studio") { init(); return; }
	const observer = new MutationObserver(() => {
		if (root.dataset.state === "studio") { observer.disconnect(); init(); }
	});
	observer.observe(root, { attributes: true, attributeFilter: ["data-state"] });
}

if (typeof document !== "undefined") { waitForStudio(); }
