# .RAW Studio — full audit & execution plan (2026-09-24)

For: Opus (executor). From: Fable (auditor). Baseline: `main` @ `29496e3` — stage video
working (see HANDOFF-2026-09-24-video.md). Four parallel reviews (correctness, performance,
UI/UX+CSS, join-flow+security) were run over the full source; every item below was
re-verified against the code by me, and false positives were dropped (listed at the end).

Rules for executing this plan
- Ship in the phase order below. Each phase is independently deployable; do not mix phases
  in one commit. One commit per numbered item where practical.
- Anything marked **TEST** needs a real 3-host session before it ships to a show.
- After every deploy: hard-refresh every open console/program tab and confirm with
  `fetch('/program.js',{cache:'no-store'})` before diagnosing anything.
- Never change the VDO viewer URL shape (`room`+`view`+`solo=1`) without re-verifying
  tiles render (that is the bug we just fixed).
- Worker and static site must ship together when the protocol changes (client refuses a
  mismatch). Phase 2 has a worker change; deploy worker first, then push.

---------------------------------------------------------------------------------------

## Phase 1 — show continuity (breaks a live show today)

### 1.1 OBS output blacks out on any control-channel blip
`program.js:94` `offline → render()`; `render()` shows the standby card
("Studio connection interrupted") and `volume()` mutes every tile whenever the WebSocket
is down. The media (VDO P2P) is unaffected — only the control channel dropped — yet the
audience sees a black card and hears nothing during a 0.5–8 s reconnect, a DO
restart/deploy, or a `4000 Presence expired` close.
Fix: keep rendering the last snapshot on `offline`; do NOT mute on `offline`; start a
`setTimeout` (20 s) before showing the interruption card and cancel it on `state`. In
`!monitor` (OBS) mode never show connection wording at all — show the branded hold only
when `program.standby` is true.
Accept: kill the worker WS (DevTools → offline 5 s) with a tile live → OBS page keeps
video and audio, no card.

### 1.2 Any WS drop kills every host camera (and guest cameras)
`host.js:162` `offline → window.rawHostCam?.stop(false)` removes the publisher iframe;
`greenroom.html` does the same for guests. The seat reservation survives 30 s server-side
(`index.js:72`), but the client tears down its own VDO publisher instantly; on reconnect
VDO renegotiates (seconds of black). Compounded by `program.js:70` dropping the viewer
after only 6 s of member absence.
Fix: keep the publisher alive across `offline`; stop it only on `fatal` (`replaced`),
explicit stop, or when the rejoined member has a different `streamID`. Raise program.js
drop grace to ~25 s (≈ PRESENCE_MS). Same in greenroom for admitted guests.
Accept: same offline test with a console open → the host's tile on OBS never drops.

### 1.3 Refresh = Leave (seat released, control jumps, host must re-onboard)
`host.js:499-504` `beforeunload → closeSocket() → client.close(true)` sends `leave`;
`index.js:92` deletes the seat reservation and reconciles the badge. Auto-rejoin is
disabled (`host.js:494-497`), so a refreshed RJ goes chooser → greenroom → retype code →
Take control. 20–60 s off air per refresh.
Fix: for crew, on `beforeunload` close WITHOUT `leave` (the 30 s reservation keyed by
id/token makes the same tab's return safe; a real Leave button still sends `leave`).
On load, if `raw.host.identity` + `raw.host.seat` exist in sessionStorage, rejoin
directly and auto-publish (skip greenroom).
Accept: refresh the RJ console mid-show → back on air in < 5 s, same streamID, badge
retained, no code prompt.

### 1.4 Controller badge jumps the instant the holder's socket closes
`index.js:129` `webSocketClose → reconcile()` → `model.js:23-26` picks a new controller
immediately; the 20 s lease is never consulted for succession, and `controller()` keeps
whoever holds it, so the returning holder lands in standby. With the RJ gate
(`index.js:100`) a blipping Greg silently loses control to RJ.
Fix: in `reconcile`, keep `badge` while `expiresAt > now` and the holder has not sent
`leave` (track `leftAt` on the attachment); reassign only after lease lapse. Add a
model test for this succession. Also let any ready crew claim when `badge.expiresAt<now`
(today a dead holder blocks everyone but RJ for up to 30 s).
Accept: Greg controlling, drop Greg's WS for 5 s → Greg still controller on return.

### 1.5 Layout switch remounts every tile on OBS (black flash on air)
`index.html:822` `sc.layout=[]; app.applyPreset('grid')` and the capture-phase handler
`index.html:845-851` regenerate box ids (`createId("box")`, `app.js:1366`); `program.js`
keys tiles by `box.id` (`:57`) and removes unknown keys (`:76`), so Duo→Triple mounts three
fresh VDO iframes (2–5 s "CONNECTING MEDIA" on the stream).
Fix: in `program.js render()`, match an existing tile by `streamID` (fall back to slot),
restyle/re-parent it, and only `mountView` when no tile has that stream. (Belt and braces:
make `setMode` reuse box ids per slot instead of clearing `layout`.)
Accept: switch Spotlight↔Triple with 3 live → no tile goes black; watchdog log shows no
remount.

### 1.6 Stale `lastPong` kills the first reconnect after a long outage
`room-client.js:32` closes the socket if `lastPong` is >15 s old; `lastPong` is never
reset in the `close` handler (`:29`), so after sleep/wake or a long outage the first ping
on the fresh socket closes it → another `offline` → 1.2 again.
Fix: `this.lastPong=0` in the close handler and on `joined`.

### 1.7 Rejected write leaves the console showing the rejected layout
`app.js:174` `raw-room-error → receiveRoom(roomSnapshot)` passes the SAME object, so the
early-return at `:155` fires and nothing re-renders. `forbidden`/`invalid` responses leave
the local stage disagreeing with the program.
Fix: `receiveRoom(snapshot, {force:true})` bypasses the early return. On `conflict`, keep
the outgoing draft and re-send with the new revision instead of dropping the edit.

### 1.8 Unauthenticated seat lock (anyone can block a host's seat)  — WORKER, one line
`index.js:52-55`: `host` is resolved from `m.seat` before role; `viewer:true` skips the
code check; `:72` then reserves the seat and pings keep it alive; `:61` rejects the real
host. Scriptable from any origin (empty Origin allowed, `:42`).
Fix: `if(m.viewer && m.seat) return this.error(ws,'seat','Viewers cannot claim seats')`,
compute `host` only when `!m.viewer`, and make the `:61` check `a.role==='crew'`.
Deploy the worker for this; no protocol change.

---------------------------------------------------------------------------------------

## Phase 2 — media load (the "laggy across three tabs" problem)

Inventory (verified): per console tab = 1 director iframe (receives EVERY host's video),
1 publisher iframe (`room+webcam+push` with no `novideo`, so it ALSO receives every other
host's video+audio into a 2 px offscreen frame), and program.html with up to 3 viewer
iframes. VDO is P2P: each host encodes once per peer. With 3 consoles + OBS a host encodes
for up to 3 directors + 3 monitor tiles + 2 hostcam guest-views + 1 OBS = ~9 peers, and
Greg's phone was sending 720x1280 @ ~4 Mbps per peer. This — not DOM work — is the freeze.

### 2.1 Publisher must not receive other hosts' video — `hostcam.js:11`
Add `novideo:''` to the publisher params (audio stays so hosts hear each other).
Gain: −2 encoders per host, −2 decoders per console. **TEST**: hosts still hear each
other; push unaffected. Same call for `greenroom.html:246` if guests don't need to see
hosts (or `scale=25` as the compromise).

### 2.2 Director iframe should not receive full video — `app.js:317-337`
Option A: add `novideo` to `buildDirectorUrl` and relay thumbnails from the monitor tiles
(app.js posts `{rawGetFrame:streamID}` into the same-origin `#program-frame`; program.js
forwards `{getVideoFrame:true}` to the matching tile and relays `image-frame-capture`
back). Off-stage hosts get "backstage" instead of a thumbnail.
Option B (fallback if VDO's director ignores `novideo`): `scale=10&videobitrate=150` on
the director URL and lower `ltb` from 1500 to ~600 (`ltb` limits what the director
RECEIVES, so it is doing real work today — keep it).
**TEST** which option VDO honours.

### 2.3 Cap what publishers send — `hostcam.js:11`, `greenroom.html:246`
Add `quality=1` (720p), `maxframerate=30`, `limittotalbitrate=6000`; consider
`codec=h264` on viewer links so phones use the hardware encoder (**TEST** on Android).

### 2.4 Meshcast — `hostcam.js`, `greenroom.html`  **TEST, do not ship blind**
`meshcast:''` on publishers → one upload per host regardless of viewer count. The only
fix that scales with console count. Adds ~0.5–1 s latency; confirm audio path and
availability in a rehearsal.

### 2.5 Render storm on fader moves
`index.js:119` bumps `program.revision` on every `mix`; desk.js sends every 80 ms while
sliding; every console runs full `renderAll()` per revision (`app.js:150-172`), the DO
`persist()`s per message, program.js re-renders + 6 postMessages.
Fix: in `receiveRoom`, run `renderAll()` only when `{scenes,activeSceneId,brand}` changed
(mix/standby/logo consumers read the snapshot themselves); desk debounce 150 ms + final
on `change`; worker: don't bump `revision` for mix (or a separate `mixRevision`), and
coalesce `persist()` to ≤ 2/s.

### 2.6 program.js cadence
Make `volume()` idempotent (cache last `{gain,muted}` per tile, post only on change, 10 s
keepalive). Watchdog `getStats` every 5 s with `STALL_MS=12000`. Back off remounts
15→30→60 s and `console.info('[program] remount', streamID, reason)` so a remount loop
is visible. Treat a stall as a stall only if audio stats also freeze (camera-off hosts
must not be remounted every 15 s — **TEST** with Camera Off).

### 2.7 Console polling
`app.js:385-394` + `:415-416` apply every `detailedState` twice — guard it. Poll every
4 s instead of 1.4 s (VDO already pushes `guest-connected`/`view-connection`/`slot-updated`
which trigger an immediate refresh). Pause thumbnails/polls on `visibilitychange` hidden
(console only — NEVER in the OBS program page). Monitor tiles: `videobitrate=500` and
`noaudio` (audio is force-muted there anyway).

### 2.8 Small, safe
`styles.css:807-824` drop `will-change` and left/top/width/height transitions on
`.layout-box` (3 compositor layers over the video for boxes that are pointer-events:none).
`index.html:697` dismiss button: `URL.revokeObjectURL` before deleting the source.
Worker alarm (`index.js:131-137`): broadcast only when reconcile changed something.
`rawoverlay.html:310-341` redraw only when dirty. `standby.html:117-133` pre-bake 4–6
noise frames instead of 57k `Math.random()` per 66 ms.

Needs profiling before deciding: `chrome://webrtc-internals` on Greg's phone (per-peer
frameWidth, qualityLimitationReason, encoder count) — decides 2.2 vs 2.3 priority;
a 5-minute remount log (2.6); does the desk VU actually move with `noaudio` on the
director (if not, drop `getLoudness`).

---------------------------------------------------------------------------------------

## Phase 3 — trust boundary

### 3.1 Media layer is open to anyone with the room name  (P1, but a design change)
Publishers use `room=master_sessions_raw` with no password unless the URL had one. The
worker broadcasts every member's `streamID` to every socket including unauthenticated
viewers and pending sockets (`index.js:33-37`). A stranger can open the WS, read
streamIDs, and view any host with the exact URL program.js uses — or open their own
`?director=` for the room. `framePost`'s `rawCanControl` gate is client-side.
Fix (in order): (a) worker generates a VDO room password, stored in DO state, delivered
only on `joined` to crew/admitted guests; publishers and viewers append it; the OBS
program URL carries a separate long random viewer token that the worker checks before
sending member streamIDs; (b) viewer/pending sockets get NO `streamID`s (only what they
need after presenting the token); (c) do not mount the director/program iframes until
joined as crew (also removes observer load on hosts). Protocol bump → worker + site
together.

### 3.2 Crew code leaks into the browser password manager
`greenroom.html:148` `<input type="password" autocomplete="current-password">` beside a
username field, inside a page that navigates on success → browsers offer to save
"RJ / <code>", and then autofill it into the host.js gate on the same origin. That is why
a fresh tab showed "YOUR NAME: RJ" with a prefilled code. In-app persistence is
sessionStorage only (plaintext, per tab).
Fix: `autocomplete="one-time-code"` (or a text input with `-webkit-text-security:disc`),
not inside a `<form>`; drop the code field from the host.js gate (seat+code are only
legitimate via greenroom); keep `code` in memory, not in `raw.host.identity`.
Longer term: per-host codes or a worker-issued short-lived seat token.

### 3.3 Hygiene
Rate-limit joins per IP (`cf-connecting-ip`) and restrict `/room/` to known rooms.
`index.js:106-107` use `Object.hasOwn(this.guests, m.target)` (prototype-pollution shape).
`_headers`: add `Content-Security-Policy: frame-ancestors 'none'` and trim the director
iframe `allow` list (`index.html:134`) to `autoplay; camera; microphone`. VDO password
should not be written into the console's own URL (`app.js:2091-2100`) once 3.1 lands.
`wrangler.toml:15-17` describes an `AUTH_KEY` that does not exist — delete.

---------------------------------------------------------------------------------------

## Phase 4 — operator UX (a broadcast desk must never be ambiguous about what is live)

### 4.1 Mode buttons lie
`index.html:804` hard-codes SPOTLIGHT pressed at load while the default scene is TRIPLE
(`app.js:136`); `setMode` updates pressed state locally only. Derive the pressed state
from the room snapshot in a `raw-room-state` listener (box count + rects ⇒ mode); never
set it optimistically.

### 4.2 One vocabulary for "no picture"
Today: "N SOURCES"/"Ready" (pill), "Reserved on stage"/"Waiting for guest" (card),
"Waiting for media" (desk), "WAITING FOR RJ"/"CONNECTING MEDIA"/"WAITING FOR CAMERA"
(tile). Define one per-seat state — ABSENT / IN ROOM, NO CAM / LIVE / RECONNECTING — and
render it identically in card, strip, tile and pill (pill → "2/3 CAMS").

### 4.3 STANDBY must look dangerous
`broadcast.js:6` gives Standby the same class as Logo; `.raw-bcast--warn` is never
applied. Add it, and a persistent red "ON STANDBY" banner over the stage while
`program.standby` is true. Show the ⌘⇧. shortcut in the button title.

### 4.4 One-click show-breakers need a guard
`hostcam.js:19` camera button disconnects immediately; `host.js:440` Leave is a bare `⎋`
glyph; `index.html:635` the per-card seat icon is "Remove from Scene" and silently
rewrites the on-air layout; cards are still `draggable` onto the stage (`app.js:770`,
`:2220-2231`). Confirm (or two-step) camera-off and Leave when `session.live`; label
Leave in words; remove the stage-toggle from the quickbar and the drag/drop path (layout
is preset-driven now).

### 4.5 "Camera connected" is asserted before anything is published
`hostcam.js:17` labels on iframe existence. Drive it from VDO events
(`joined-room`/`video-created`) with a "Connecting…" state, and toast why `start()` bailed.

### 4.6 Feedback
`programPending` is never rendered — show a small "SENDING…" pill; toast when
`RawHost.send()` returns false. Toast (`z-index:50`) is hidden behind the standby ribbon
(`z-index:9998`) — move the toast top-centre with `z-index:10002`. Replace `alert()` at
`host.js:163` with the toast/ribbon (alert freezes every timer mid-show). Greenroom: on
`offline` while `!client.joined`, reset the button and say the room service is
unreachable (today it is stuck disabled). Denied guests must see "not admitted", not
"Waiting for admission" (server sends a `denied` flag). Add a "Remove" action for
admitted guests (`RawHost.denyGuest`) — there is none today.

### 4.7 Stage aspect on short/narrow windows
`styles.css:2435-2439` forces `height:100%` then clamps width — on 1024x768 the preview is
~1.46:1 and no longer matches OBS. Go back to width-driven:
`height:auto; width:min(100%, calc((100vh - 56px - 58px - 310px) * 16 / 9))`.

### 4.8 Smaller polish
Pass-host `<select>` acts on `change` → button + confirm. "Sound Off" reads as a command →
"Join sound: off/on". Star = "Solo", toolbar = "Spotlight", card menu = "Spotlight"
(different thing) → retire the card one, rename star to "Fullscreen". Transcript panel
collapsed by default and capped at 200 px; it transcribes the operator's own mic — say so
("Local transcript · your mic"). Knock tray overlaps the rail tabs → render inline at the
top of Crew. Copy buttons flip to ✓ without checking `writeText` → reuse `copyText`.
Contrast: `--soft` on `#131211` ≈ 3.4:1 at 9–11 px; floor at 10 px / 4.5:1. Overlays
need `role="dialog" aria-modal`; drop `aria-live` on the rebuilt source list; transcript
`role="log"`. "+ Add guest slot" adds a phantom that the next snapshot erases — hide it.
"Show editor labels" is actually the on-air label switch — rename.

---------------------------------------------------------------------------------------

## Phase 5 — code hygiene (do last, one PR, no behaviour change)

- Delete dead code: `host.js` local-mode transport (`:29-35`, `:170-237`,
  `scheduleReconnect`, `getClientId`); `app.js` `defaultScenes`, `saveSession`/
  `STORAGE_PREFIX`/`APP_STATE_VERSION` (written, never read), `exportLayoutItem`/
  `buildLayoutPayload`, sample sources + placeholders (wiped by every snapshot),
  `activateQueuedGuest` + all `queued` branches, `programPending` if 4.6 doesn't use it,
  `framePost({mute:true})` at `:2115`, `setOutputStatus`/`openUrl` for hidden buttons; the
  room gate form (`app.js:2257` is always truthy — episode/title fields are dead);
  scene-key shortcuts (`index.html:672-677`) that click hidden cards; `#yt-stream-title`
  references; hidden legacy markup (scene toolbar, Design tab, WHIP/recorder buttons,
  duplicate OBS cards).
- `styles.css`: nine layered patches, ~40% dead, 63 `!important`, `.source-card` defined
  5×, `.raw-fader` 3×, `.raw-hostcam-pub` defined twice contradicting, `#director-frame`
  twice. Consolidate; declare `--bronze/--smoke/--offwhite` (every use relies on the
  fallback today); move host.js's injected CSS into the stylesheet with palette tokens.
- `index.html` inline MutationObserver patches (9 of them) decorate app.js output by
  matching BUTTON TEXT and moving app.js's nodes; the `data-nofeed` wall was exactly this
  class of bug. Fold the working ones into app.js render functions (emit `data-state`
  attributes) and delete the "dismiss ghost" patch, which can never match
  (`buildSourceList` filters disconnected sources).
- Unguarded local mutators reachable by standby/observer consoles (`soloSource`,
  `addScene`, `renameActiveScene`, `toggleSelectedBoxFit`, `resetSelectedBox`,
  `moveSelectedBoxLayer`, `updateActiveBrand`, `addPlaceholder`, and the capture-phase
  preset handler): add `if(!window.rawCanControl?.())return;`. Pass-host list should
  filter on `m.ready` (`host.js:413`). Clear `raw.host.seat` in `leave()`.
- Tests: `worker/test/model.test.mjs` covers `controller()`/`sanitizeProgram` only. Add
  reconcile/lease succession (1.4) and the viewer-seat rejection (1.8).

---------------------------------------------------------------------------------------

## Dropped as false positives (so nobody re-chases them)
- "VDO `volume` expects 0–100, program audio is at 1%": VDO's iframe API takes 0–1
  (`"volume": 0.5` in the docs); program.js is correct.
- "`ltb=1500` on the director does nothing": `ltb` limits the director's INBOUND total,
  which is exactly the director's cost; keep it (lower it).
- "The `data-nofeed` tagger has no effect": true now that the CSS is transparent — it is
  dead code, listed for deletion, not a bug.

## Acceptance for the whole plan (rehearsal matrix, unchanged from the Sept 11 audit)
All three join in any order; RJ absent; RJ arrives mid-show (must not seize control);
intentional hand-off; controller WS blip; refresh each host mid-show; duplicate tab; same
seat on two devices; camera off / audio only; guest waits → admitted → removed; worker
outage while media stays up (OBS never blacks out); every console shows the identical
program; OBS reflects mix and standby; exactly three host channels + admitted guests.
