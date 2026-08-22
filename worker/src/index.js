/*
 * .RAW Sessions — Host Badge coordination Worker (universal identity)
 * ---------------------------------------------------------------------------
 * A Cloudflare Worker + Durable Object that holds the authoritative HOST badge
 * for each studio room and fans state to every connected console over
 * WebSockets. Server-enforced: the Durable Object is the single source of
 * truth for who holds control.
 *
 * Universal identity:
 *   - Everyone self-submits a display name; anyone can connect.
 *   - A CREW CODE (server secret CREW_CODE) marks a connection as "crew".
 *     Crew are host-eligible; everyone else is a "guest" (never host).
 *     If CREW_CODE is not set, everyone is treated as crew (open mode).
 *   - Succession is by SENIORITY: if the host drops, the earliest-joined crew
 *     member still connected becomes host.
 *
 *   Connect:  wss://<worker>/room/<ROOM>?id=<clientId>&name=<Name>&code=<crewCode>
 *
 *   Client -> server:
 *     { "type": "claim" }               take control (crew only)
 *     { "type": "pass", "target": id }  hand off (current host only)
 *     { "type": "ping" }
 *
 *   Server -> client:
 *     { "type":"state", "badge":{hostId,term,updatedAt},
 *       "members":[{id,name,role}] }     // role: "crew" | "guest"
 *     { "type": "pong" }
 */

import { DurableObject } from "cloudflare:workers";

export class RawStudioRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.env = env;
		this.badge = { hostId: null, term: 0, updatedAt: 0 };
		this.admitted = new Set();   // guest ids the host has let in
		ctx.blockConcurrencyWhile(async () => {
			const saved = await ctx.storage.get("badge");
			if (saved) this.badge = saved;
			const adm = await ctx.storage.get("admitted");
			if (Array.isArray(adm)) this.admitted = new Set(adm);
		});
	}

	async saveAdmitted() {
		await this.ctx.storage.put("admitted", [...this.admitted]);
	}
	isAdmitted(id, role) {
		return role === "crew" ? true : this.admitted.has(id);
	}

	// Crew if no code is configured (open mode) or the supplied code matches.
	roleFor(code) {
		const required = this.env.CREW_CODE;
		return (!required || code === required) ? "crew" : "guest";
	}

	async fetch(request) {
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		// Origin allowlist — block cross-site WebSocket hijacking. Browsers always
		// send Origin; empty origin (server-to-server / tooling) is allowed through.
		const origin = request.headers.get("Origin") || "";
		const originOk = !origin
			|| origin === "https://studio.puntoraw.org"
			|| /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
		if (!originOk) return new Response("Forbidden origin", { status: 403 });

		const url = new URL(request.url);
		const id = (url.searchParams.get("id") || "").slice(0, 64);
		const name = ((url.searchParams.get("name") || "").trim() || "Guest").slice(0, 60);
		const role = this.roleFor(url.searchParams.get("code") || "");
		if (!id) return new Response("Missing id", { status: 400 });
		// Validate id charset (UUIDs / fallback ids only) — defense in depth against injection.
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return new Response("Bad id", { status: 400 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id, name, role, joinedAt: Date.now() });

		this.sendTo(server, this.stateMsg());
		await this.reconcile();
		this.broadcast(this.stateMsg());

		return new Response(null, { status: 101, webSocket: client });
	}

	/* Deduped member list (by id): earliest joinedAt wins, crew role wins. */
	members(exclude) {
		const map = new Map();
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === exclude) continue;
			const a = ws.deserializeAttachment();
			if (!a || !a.id) continue;
			const prev = map.get(a.id);
			if (!prev) {
				map.set(a.id, { id: a.id, name: a.name, role: a.role, joinedAt: a.joinedAt, admitted: this.isAdmitted(a.id, a.role) });
			} else {
				prev.joinedAt = Math.min(prev.joinedAt, a.joinedAt);
				if (a.role === "crew") { prev.role = "crew"; prev.admitted = true; }
			}
		}
		return [...map.values()];
	}
	presentCrew(exclude) {
		return this.members(exclude)
			.filter(m => m.role === "crew")
			.sort((a, b) => a.joinedAt - b.joinedAt);
	}
	rightfulHost(exclude) {
		const crew = this.presentCrew(exclude);
		return crew.length ? crew[0].id : null;
	}
	isCrewPresent(id, exclude) {
		return this.presentCrew(exclude).some(m => m.id === id);
	}

	stateMsg(exclude) {
		return { type: "state", badge: this.badge, members: this.members(exclude) };
	}

	async setBadge(hostId) {
		this.badge = { hostId: hostId, term: this.badge.term + 1, updatedAt: Date.now() };
		await this.ctx.storage.put("badge", this.badge);
	}

	/* Keep the badge valid: if the host is gone or not crew, pass to the
	 * most-senior present crew member (or vacate). */
	async reconcile(exclude) {
		const hostOk = this.badge.hostId && this.isCrewPresent(this.badge.hostId, exclude);
		if (hostOk) return false;
		const successor = this.rightfulHost(exclude);
		if (successor) { await this.setBadge(successor); return true; }
		if (this.badge.hostId) { await this.setBadge(null); return true; }
		return false;
	}

	async webSocketMessage(ws, raw) {
		let msg;
		try { msg = JSON.parse(raw); } catch (e) { return; }
		const a = ws.deserializeAttachment() || {};
		const me = a.id;

		if (msg.type === "claim") {
			if (a.role === "crew" && this.isCrewPresent(me)) {
				await this.setBadge(me);
				this.broadcast(this.stateMsg());
			}
		} else if (msg.type === "pass") {
			if (this.badge.hostId === me && this.isCrewPresent(msg.target)) {
				await this.setBadge(msg.target);
				this.broadcast(this.stateMsg());
			}
		} else if (msg.type === "admit") {
			// Only crew may admit/deny knocking guests.
			if (a.role === "crew" && msg.target) {
				this.admitted.add(msg.target);
				await this.saveAdmitted();
				this.broadcast(this.stateMsg());
			}
		} else if (msg.type === "deny") {
			if (a.role === "crew" && msg.target) {
				this.admitted.delete(msg.target);
				await this.saveAdmitted();
				this.broadcast(this.stateMsg());
			}
		} else if (msg.type === "ping") {
			this.sendTo(ws, { type: "pong" });
		}
	}

	async webSocketClose(ws, code, reason) {
		await this.reconcile(ws);
		this.broadcast(this.stateMsg(), ws);
		try { ws.close(code, reason); } catch (e) {}
	}
	async webSocketError(ws) {
		await this.reconcile(ws);
		this.broadcast(this.stateMsg(), ws);
	}

	sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
	broadcast(obj, exclude) {
		const s = JSON.stringify(obj);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === exclude) continue;
			try { ws.send(s); } catch (e) {}
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
		}
		const match = url.pathname.match(/^\/room\/([A-Za-z0-9_.\-]{1,80})$/);
		if (!match) return new Response("Not found", { status: 404 });
		const stub = env.RAW_ROOM.get(env.RAW_ROOM.idFromName(match[1]));
		return stub.fetch(request);
	}
};
