# Handoff — stage video fix (2026-09-24)

Status: all three host feeds render live on the console stage, the standalone
program page, and (by extension) the OBS Browser Source. Verified in a real
session with RJ, Greg and Rafa on stage in TRIPLE.

## What was broken (two independent bugs stacked)

1. **The program viewers never got video.** `program.js` opened each tile as
   `vdo.ninja/?room=…&view=<streamID>`. VDO.Ninja does not treat `room`+`view`
   as "watch one guest" — it shows its Join Room chooser, which `cleanoutput`
   hides, so the tile was black. Meanwhile the hidden director iframe *did*
   receive video (that is why the rail thumbnails worked). Fix: add a
   single-guest flag. `solo=1` is what ships (VDO's own solo-link form);
   `scene` also works — both verified side by side. The earlier note that an
   empty `scene=` breaks it was a stale-cache artifact (see "Gotcha").

2. **The console painted a black wall over the program frame.** A leftover
   "no-feed static" script in `index.html` tags stage boxes `data-nofeed` when
   it finds no live source, and CSS painted those boxes opaque `#0a0908` at a
   higher z-index than `#program-frame`. It matched by `item.streamID`, which
   is always `''` under protocol 2 (seats bind by slot), so every box was
   tagged and the live program was hidden. Fix: resolve by slot, and make the
   overlay boxes transparent — `program.html` renders its own WAITING state.

## Commits on main (in order)

- `687b77a` program.js: viewer URL gets a single-guest flag (`scene`); also
  `frameCount` now matches VDO's `_decodeFrames` key (stall watchdog was dead
  before), console preview (`monitor`) requests `videobitrate=1200`, and a
  seated host with no camera reads WAITING FOR CAMERA instead of RECONNECTING.
- `86a53c0` program.js: `scene` → `solo=1`.
- `93139b1` program.js: comment correction (both forms work).
- `81bd6fb` index.html + styles.css: stage overlay no longer paints over the
  program frame; no-feed lookup by slot.

## Gotcha that cost both of us time

`_headers` sets `max-age=0, must-revalidate`, but an already-open tab keeps
running the copy of `program.js` it loaded. Both false diagnoses today
("scene= shows the chooser") came from a tab still executing the pre-fix
file. After any deploy: hard-refresh (Cmd-Shift-R) every open console/program
tab before drawing conclusions, and confirm with
`fetch('/program.js',{cache:'no-store'})` that the live text has the change.

## Known / next

- Rail thumbnails are 5-second stills via the director iframe's
  `getVideoFrame`, not video. They will always look "laggy"; they are not a
  stage problem. The real cost is that the director iframe subscribes to every
  host's full video just to snapshot it.
- Load: VDO is peer-to-peer. With 3 consoles + OBS each host uploads to ~7
  peers; Greg's phone was sending 720x1280 @ ~4 Mbps per peer. If uploads
  strain, the fix is VDO Meshcast (`&meshcast`), not more tuning.
- On first mount a tile may show the video as a small square in its corner for
  up to ~30 s until VDO's layout pass runs; it resolves on its own.
- Consider pinning a VDO.Ninja version path so an upstream change cannot
  silently break the viewer URL again — this failure had exactly that shape.
- Untracked, do not commit unless wanted: IMPLEMENTATION-PLAN.md,
  STUDIO-AUDIT-2026-09-11.md, __v4probe.txt.
