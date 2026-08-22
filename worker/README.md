# .RAW Sessions — Host Badge Worker

A Cloudflare Worker + Durable Object that holds the authoritative **HOST badge**
for each studio room and syncs it to every crew console over WebSockets. This is
what makes the host model work **across machines** and be **server-enforced**
(one host at a time, hand-off, and Greg → RJ → RAFA succession).

## What it does

- One Durable Object per room (`/room/<ROOM>`), keyed by the studio room name.
- Presence = live WebSocket connections (no heartbeats).
- The server owns the badge: assigns by rank, honors hand-off, and auto-passes
  down the ranked order when the host disconnects.
- SQLite-backed DO with WebSocket Hibernation — cheap, and runs on the Workers
  **Free plan**.

## Deploy (one time)

```bash
cd raw-worker
npm install
npx wrangler login          # opens your browser; pick the Cloudflare account
npx wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://raw-studio-host.<your-subdomain>.workers.dev`.

## Wire it into the studio

In `../host.js`, set `CONFIG.workerUrl` to that origin **with the `wss://` scheme**:

```js
const CONFIG = {
  workerUrl: "wss://raw-studio-host.<your-subdomain>.workers.dev",
  workerKey: ""   // leave empty unless you set AUTH_KEY below
};
```

Reload the studio. The HOST badge now syncs across every machine that opens the
console. Leaving `workerUrl` empty falls back to same-machine (BroadcastChannel)
mode — handy for local testing.

## Optional: lock it with a shared key

```bash
npx wrangler secret put AUTH_KEY      # enter a random string
```

Then set the same value as `CONFIG.workerKey` in `host.js`. Consoles without the
key get rejected (401).

## Change the crew / order

The roster lives in **two** places and must match:

- `src/index.js` → `ROSTER` (server authority)
- `../host.js`   → `ROSTER` (client display)

Edit both, then `npx wrangler deploy` again.

## Notes

- Free-plan limits apply (plenty for a small crew). See Cloudflare's Durable
  Objects pricing page.
- `npm run tail` streams live logs while debugging.
- The room name comes from the studio (`window.studioApp.state.room`), so each
  `.RAW` room automatically gets its own isolated badge.
