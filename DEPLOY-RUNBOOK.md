# .RAW Studio — Deploy Runbook (audit rollout)

## Where things stand

Everything that implements the Astra audit is committed to the branch
**`audit-implementation`** (your repo is checked out on it now). Two commits:

- `5dcb994` — the protocol-2 rewrite (authoritative room, seats, controller lease, single renderer).
- `27e992a` — hardening, cleanup, and worker logic tests (11/11 passing).

**`main` is untouched and still matches what's live.** Production today is the
old pre-audit code: the live site does not load `room-client.js` / `program.js`,
and the live worker's `/health` returns the old plain `ok`. So none of the fixes
are live yet — deploying is what makes them real.

I could not deploy from the assistant session (it has no GitHub access and no
Cloudflare login), so these steps run on your Mac. They are copy-paste. Do them
when the studio is **not** mid-show — there's a brief window where the worker and
site versions differ, and the client refuses a version mismatch.

## Before you start

- You'll deploy **two** things and they must match: the **worker** (Cloudflare)
  and the **static site** (the HTML/JS/CSS).
- Open Terminal and go to the folder:
  ```bash
  cd ~/Documents/studio-puntoraw
  git status          # should say: On branch audit-implementation
  ```

## Step 1 — Deploy the worker

```bash
cd ~/Documents/studio-puntoraw/worker
npm install                       # first time only
npx wrangler login                # opens a browser; pick your Cloudflare account
npx wrangler secret put CREW_CODE # type a STRONG code (see note below), press enter
npx wrangler deploy
```

**Crew code:** it's currently `123`, which anyone could guess. When `wrangler`
asks for `CREW_CODE`, enter something strong and share it privately with RJ, Greg
and Rafa. The code lives only as a Cloudflare secret — it is not in the code or
the repo. (If the secret is ever unset, the worker fail-closes and **no one can
host**, so don't skip this.)

**Check the worker:** open
`https://raw-studio-host.rovelo-ga.workers.dev/health` — it should now say
`{"ok":true,"protocol":2}` (not the old plain `ok`).

## Step 2 — Deploy the static site

Your site is a **Cloudflare Pages project named `studio-puntoraw`**, connected to
the GitHub repo **`markusclaw/studio-puntoraw`**. It auto-deploys
`studio.puntoraw.org` whenever the production branch (`main`) is pushed. So
publishing the site = merging the branch into `main` and pushing:

```bash
cd ~/Documents/studio-puntoraw
git checkout main
git merge audit-implementation
git push origin main
```

Cloudflare Pages picks up the push and rebuilds automatically — watch it under
Workers & Pages -> `studio-puntoraw` -> Deployments until the new build goes
live. (If `git push` asks for credentials, use your GitHub login / token.)

**Order matters:** do Step 1 (the worker) *first*, then this push, back to back,
while you're off-air. The new site speaks protocol 2 and needs the protocol-2
worker already live; and the moment you deploy the v2 worker, the *old* live site
stops working until this push lands — so keep the gap short and don't do it
mid-show.

## Step 3 — Verify the site (2 minutes)

1. Open `https://studio.puntoraw.org` and hard-refresh (Cmd-Shift-R).
2. View source (or DevTools → Sources) and confirm `room-client.js` and
   `program.js` are now loaded.
3. Open the console, pick a host seat, enter the new crew code in the greenroom,
   and confirm you land in the studio with your seat box active.
4. Open the program URL (the "Open program" / record link) in a second tab — it
   should mirror the console's program. This is also your OBS Browser Source.

## Step 4 — Rehearsal before the next real show

Run Astra's matrix with the three hosts (this needs real devices, so it's yours
to run — I can help interpret results):

- All three join in different orders; Greg before RJ; RJ absent; RJ arrives
  mid-show (should **not** seize control); intentional hand-off; controller
  disconnect/reconnect.
- Same seat opened on two devices (second should be refused); duplicate tab;
  camera-off / audio-only; a guest waits, is admitted, then removed.
- All consoles show the **same** program; OBS output reflects the mix and Standby.
- Check: exactly three host channels plus admitted guests in the mixer, and no
  raw VDO peer IDs showing up as people.

Still to do after this rollout (tracked, not blocking): a real performance
profiling pass across three studio tabs (the freeze investigation), and a
decision on whether to move from a shared crew code to per-host logins.

## If something looks wrong — rollback

- **Worker:** `cd worker && npx wrangler rollback` (or redeploy from `main`).
- **Site:** in the Cloudflare Pages project, "Rollback" to the previous
  deployment; or `git checkout main` and redeploy. Because `main` still holds the
  old, known-good code, you can always get back to today's behavior.
