/*
 * .RAW Sessions — Host Badge coordination Worker
 * ---------------------------------------------------------------------------
 * A Cloudflare Worker + Durable Object that holds the authoritative HOST badge
 * for each studio room and fans state out to every connected console over
 * WebSockets. This makes the host model server-enforced (not just cooperative):
 * the Durable Object is the single source of truth for who holds control.
 *
 *   Client connects:  wss://<worker>/room/<ROOM>?id=<crewId>&name=<Name>[&key=<AUTH_KEY>]
 *
 *   Client -> server messages (JSON):
 *     { "type": "claim" }               take control (must be eligible)
 *     { "type": "pass", "target": id }  hand off (only the current host may)
 *     { "type": "ping" }                keepalive (optional)
 *
 *   Server -> client messages (JSON):
 *     { "type": "state", "badge": {hostId,term,updatedAt}, "present": [ids] }
 *     { "type": "pong" }
 *
 * Presence is derived from live WebSocket connections — no heartbeats needed.
 * When the host's connection drops, the badge auto-passes to the lowest-rank
 * crew member still connected (Greg -> RJ -> RAFA).
 */

import { DurableObject } from "cloudflare:workers";

/* ---- Crew roster + ranked succession order (server is the authority) ---- */
const ROSTER = [
	{ id: "greg", rank: 1 },
	{ id: "rj",   rank: 2 },
	{ id: "rafa", rank: 3 }
];
function rankOf(id) {
	const m = ROSTER.find(x => x.id === id);
	return m ? m.rank : Infinity;
}
function isEligible(id) {
	return rankOf(id) !== Infinity;
}

export class RawStudioRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.badge = { hostId: null, term: 0, updatedAt: 0 };
		ctx.blockConcurrencyWhile(async () => {
			const saved = await ctx.storage.get("badge");
			if (saved) this.badge = saved;
		});
	}

	async fetch(request) {
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const url = new URL(request.url);
		const id = (url.searchParams.get("id") || "").slice(0, 40);
		const name = (url.searchParams.get("name") || id).slice(0, 40);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id, name });

		this.sendTo(server, this.stateMsg());
		await this.reconcile();
		this.broadcast(this.stateMsg());

		return new Response(null, { status: 101, webSocket: client });
	}

	presentIds(exclude) {
		const ids = new Set();
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === exclude) continue;
			const a = ws.deserializeAttachment();
			if (a && a.id) ids.add(a.id);
		}
		return [...ids];
	}
	rightfulHost(exclude) {
		let best = null, bestRank = Infinity;
		for (const id of this.presentIds(exclude)) {
			const r = rankOf(id);
			if (r < bestRank) { bestRank = r; best = id; }
		}
		return best;
	}

	stateMsg() {
		return { type: "state", badge: this.badge, present: this.presentIds() };
	}

	async setBadge(hostId) {
		this.badge = { hostId: hostId, term: this.badge.term + 1, updatedAt: Date.now() };
		await this.ctx.storage.put("badge", this.badge);
	}

	async reconcile(exclude) {
		const present = this.presentIds(exclude);
		const hostAlive = this.badge.hostId && isEligible(this.badge.hostId) && present.includes(this.badge.hostId);
		if (hostAlive) return false;
		const successor = this.rightfulHost(exclude);
		if (successor) { await this.setBadge(successor); return true; }
		if (this.badge.hostId) { await this.setBadge(null); return true; }
		return false;
	}

	async webSocketMessage(ws, raw) {
		let msg;
		try { msg = JSON.parse(raw); } catch (e) { return; }
		const me = (ws.deserializeAttachment() || {}).id;

		if (msg.type === "claim") {
			if (isEligible(me)) { await this.setBadge(me); this.broadcast(this.stateMsg()); }
		} else if (msg.type === "pass") {
			const target = msg.target;
			if (this.badge.hostId === me && isEligible(target) && this.presentIds().includes(target)) {
				await this.setBadge(target);
				this.broadcast(this.stateMsg());
			}
		} else if (msg.type === "ping") {
			this.sendTo(ws, { type: "pong" });
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		await this.reconcile(ws);
		this.broadcast(this.stateMsg(), ws);
		try { ws.close(code, reason); } catch (e) {}
	}

	async webSocketError(ws) {
		await this.reconcile(ws);
		this.broadcast(this.stateMsg(), ws);
	}

	sendTo(ws, obj) {
		try { ws.send(JSON.stringify(obj)); } catch (e) {}
	}
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

		if (env.AUTH_KEY && url.searchParams.get("key") !== env.AUTH_KEY) {
			return new Response("Unauthorized", { status: 401 });
		}

		const stub = env.RAW_ROOM.get(env.RAW_ROOM.idFromName(match[1]));
		return stub.fetch(request);
	}
};
