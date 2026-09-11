# .RAW Sessions — Room Coordination Worker (protocol 2)

A Cloudflare Worker + Durable Object that holds the **authoritative room record**
for each studio room and syncs it to every console, greenroom and program
renderer over WebSockets. One Durable Object per room (`/room/<ROOM>`).

## What the room owns

- **Three reserved host seats** — `rj`, `greg`, `rafa` (see `src/model.js` `HOSTS`).
  Seats are claimed exclusively; a reconnect window (`PRESENCE_MS`) lets the same
  identity retake its seat, and a second device is refused with an `occupied` error.
- **Guests** — a roster with an `admitted` flag. A guest only publishes media once
  admitted; deny/leave clears it.
- **Program** — versioned snapshot: scenes/layout, brand, mix + master, standby,
  logo, and a session-timer flag. Every change bumps `revision`.
- **Controller lease** — a badge with a term and a 20s lease (`LEASE_MS`). Every
  state-changing command is gated **fail-closed**: only a crew member who is
  ready, holds the current badge, matches the term and has an unexpired lease may
  change program/mix/admission/standby or pass control. `rj` is preferred only
  when no controller exists; an arriving host never steals control mid-show.

Presence is heartbeat + `lastSeen` based (no label/thumbnail guessing). Auth
happens in the first WebSocket message, so no codes appear in URLs or access logs.

## Configure

- **Roster:** `src/model.js` → `HOSTS` (server authority). The client display
  lives in `../jumpin.js` and `../host.js`; keep them in sync.
- **Crew code (required):** the Worker fail-closes — if `CREW_CODE` is unset,
  **no one can take a host seat**. Set it as a secret (below). Use a strong value,
  not a guessable one.
- **Origin allow-list:** `src/index.js` accepts `https://studio.puntoraw.org` and
  localhost; other browser origins are rejected. (Empty-Origin, e.g. non-browser
  clients, is allowed and is backstopped by the crew code + admission.)

## Deploy

```bash
cd worker
npm install
npx wrangler login                 # opens a browser; pick the Cloudflare account
npx wrangler secret put CREW_CODE   # enter a strong host code (NOT "123")
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://raw-studio-host.<subdomain>.workers.dev`. The client points at it in
`../room-client.js` (`RAW_WORKER_URL`) and `../host.js` (`CONFIG.workerUrl`) with
the `wss://` scheme. Health check: `GET /health` → `{"ok":true,"protocol":2}`.

> The client refuses a protocol mismatch, so deploy the Worker **and** the static
> site together — a half-deploy takes the studio down.

## Test

```bash
npm test        # pure logic checks for model.js (no network, no deps)
```

## Change the crew / order

Edit `src/model.js` `HOSTS` (server) and the matching display in `../jumpin.js`
and `../host.js`, then `npx wrangler deploy` again.
