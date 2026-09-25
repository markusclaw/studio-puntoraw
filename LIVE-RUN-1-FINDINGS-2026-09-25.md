# Live run #1 (2026-09-24 .RAW Sessions) — findings, root causes, fixes

Reported by Greg/RJ/Rafa after the first real show on the studio. Traced against `main`
@ `07bfb65`. Four symptoms, three root causes. Audio is the theme.

## What the audio topology actually is today (this explains most of it)

Every console tab has THREE things that can make sound:
1. **The hostcam publisher iframe** (`hostcam.js`, `room+push+novideo`). It is a VDO room
   guest, so it RECEIVES every other host's audio and plays it. This is the hosts'
   conversation channel. It has **no mute control anywhere in the UI**.
2. **The program preview** (`program.html?monitor=1`): tiles are `noaudio` + volume 0 now —
   silent. But `program.js:35` gives the monitor a quiet 1 kHz **standby tone** (−44 dB).
3. **The director iframe**: `noaudio` — silent, but see Spotlight below.

OBS loads `program.html` (no `monitor`) → plays every host's tile audio → OBS mix → YouTube.
The desk's MUTE buttons change `program.mix`, which only `program.js` consumes → **they mute
the OBS output, not what you hear in your headphones.** That is why "we couldn't mute the
sound": the sound you were fighting came from channel 1, which nothing controls.

Now add the Revelator io24. It exposes its loopback mixes as *input devices*. If Chrome's
mic for VDO is "Revelator IO 24 Loopback/Mix" instead of the plain mic input, OR OBS's
monitored output is routed back into the mix that feeds Chrome, then everything you hear
(other hosts, OBS program, the standby tone) is re-sent as *your* mic to everyone. Result:
you hear yourself twice (direct + round trip), RJ hears himself back through you, and any
sound that enters the loop keeps circulating.

## Symptom → cause → fix

### 1. Constant loopback / hearing yourself twice / couldn't mute
Cause A (routing, on your side): the loop above. Cause B (product): no monitor mute.
Product fixes (Opus):
- **Add a MONITOR control to the desk** ("Monitor: Hosts / Off", plus per-host mute for what
  *you* hear): post `{mute:true|false}` to the hostcam iframe (`window.rawHostCam` exposes
  `frame`) — VDO's iframe API speaker mute. Zero server involvement. Label the desk's existing
  MUTE column "PROGRAM" so the two are never confused again.
- Standby tone: remove it from `monitor` entirely (a tone in every host's headphones is the
  wrong signal; the ON STANDBY ribbon is the signal). See §2.
Routing checklist (Greg, in Universal Control + Chrome + OBS):
- Chrome/VDO mic = the Revelator **mic input** (Ch 1 or 1-2), never "Loopback 1/2" or a mix.
  Check in the greenroom device picker; it is remembered in `raw.host.mic`.
- Headphones = your direct mic monitor + Chrome playback (the conversation). **Nothing from
  OBS.** Set every OBS source's Audio Monitoring to *Monitor Off*. YouTube hears OBS; you don't.
- OBS audio for the show comes **only** from the `program.html` Browser Source with "Control
  audio via OBS" checked. Disable/mute any Desktop Audio or Revelator mic/loopback input in
  OBS — that is the most likely reason only your voice reached YouTube: OBS was carrying your
  Revelator mix (your mic + a faint round-trip of the others) instead of the tile audio.
- Sanity test before the next show: with the Browser Source selected, talk → its meter in the
  OBS mixer must move; have RJ talk → same meter must move. If RJ's does not, the tiles are not
  delivering audio into OBS and we look at `speakermute`/the `mute:false` command in
  `program.js:72` before going live.

### 2. Standby tone lingered after Standby was released
`program.js:43-53` ramps the oscillator to `0.0001` gain and leaves it running for the life
of the page (`osc.start()` is never stopped). Off = −80 dB, not silence. On the OBS machine
that is inaudible; but the tone also plays in **every console's monitor** (`TONE_LEVEL=0.006`
when `monitor`), and if it entered the Revelator loop it kept circulating after the ramp —
which is exactly "it stayed ringing until we all refreshed" (refresh broke the loop).
Fix (Opus):
- `monitor` → no tone, ever. Delete the monitor level.
- OBS output → tone **opt-in** via `&tone=1` on the program URL, default off (RJ is right: a
  continuous 1 kHz on the stream is a choice, not a default). When on, stop for real: on
  release `g.gain.setValueAtTime(0,t)` then `osc.stop()`, `ctx.suspend()`, and rebuild on the
  next standby. Never leave an oscillator running at −80 dB.

### 3. Rafa's MUTE on his own card did nothing
`app.js:1600` `toggleSourceControl` starts with `if(!window.rawCanControl?.())return;` — only
the badge holder can use ANY card mic/camera button, including on their own card. Rafa was
not the controller → silent no-op. Two further problems behind it:
- The card button routes through the **director iframe** (`{action:'mic',target,value}`).
  Every console opens `&director=<room>`; VDO honours one director per room unless
  co-directors are configured, so a non-first console's director commands may be ignored
  even for the controller. **TEST** which console is the real director; the fix below avoids
  the question for self-controls.
- The desk MUTE (which Rafa could not use either, not being controller) is the *program*
  mute, not his mic.
Fix (Opus):
- **Self-controls never go through the badge or the director.** On the card whose
  `member.id === RawHost.state().clientId`, mic/camera buttons post `{mic:false|true}` /
  `{camera:false|true}` to the local hostcam iframe (VDO iframe API), no `rawCanControl`
  check, and reflect the state from the iframe's `mic-state`/`camera-state` events.
- Add the same two buttons to the toolbar next to "Camera connected" so a host never has to
  find their own card to mute.
- Other-host mic/camera stays controller-only via the director; label it "request".

### 4. Auto-Spotlight (speaker talking >2 s takes the stage) didn't work
There is no such feature in the code. "SPOTLIGHT" is a static one-box preset
(`index.html setMode`), and the only "active speaker" text is a hidden legacy OBS card
description. Also the data it would need is currently dead: the director iframe is
`noaudio`, so VDO's `loudness` messages carry nothing (this was the open 2.2 question — the
desk VU meters are decorative right now; confirm on the next run).
Fix (Opus) — build it, it's small:
- Director URL: replace `noaudio` with `muted` (receive audio, don't play it) so `getLoudness`
  reports levels. Confirm the desk VU moves.
- New mode button **AUTO** (controller-only): every 250 ms take the loudest member above a
  floor (e.g. 12/100); if the same member has been loudest for `SWITCH_MS=2000`, and differs
  from the current spotlight, publish a Spotlight layout for that slot (reuse the existing
  spotlight box so `program.js` doesn't remount — tiles are keyed by slot, fine). Hold
  `MIN_HOLD_MS=4000` before switching again; fall back to Triple after `SILENCE_MS=8000`.
  Show the current AUTO target on the button ("AUTO · RJ"). Persist `program.autoSpotlight`
  in the snapshot so followers see the mode; only the controller runs the timer.

## Post-production note (this show)
The YouTube recording has your mic only. Ask RJ and Rafa whether their VDO tabs had any
local recording; otherwise the OBS recording (if it was on) has the same audio as the stream.
For next time: turn on OBS "Record" with a separate audio track per tile (Browser Source →
Advanced Audio → tracks 2/3/4) so a re-edit is a remix, not a rebuild.

## Order for Opus
1. §3 self-controls (hostcam iframe mic/camera) + §1 desk MONITOR control — one commit.
2. §2 tone: off in monitor, opt-in on OBS, real stop — one commit.
3. §4 director `muted` instead of `noaudio` + AUTO spotlight — one commit, TEST VU first.
Then the RE-AUDIT N1–N3 fixes. Greg runs the routing checklist before the next show.
