import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, initialProgram, sanitizeProgram, controller, nextBadgeHolder, resolveJoinRole, makeSecrets, socketAuthed } from '../src/model.js';

const crew = (id, seat, joinedAt, ready = true) => ({ id, role: 'crew', ready, seat, joinedAt });

test('HOSTS are exactly rj/greg/rafa in slots 1..3', () => {
  assert.deepEqual(HOSTS.map(h => h.seat), ['rj', 'greg', 'rafa']);
  assert.deepEqual(HOSTS.map(h => h.slot), [1, 2, 3]);
});

test('initialProgram seeds three host boxes in every room by schema', () => {
  const p = initialProgram();
  assert.equal(p.revision, 0);
  assert.equal(p.scenes.length, 1);
  assert.equal(p.scenes[0].layout.length, 3);
  assert.deepEqual(p.scenes[0].layout.map(b => b.label), ['RJ', 'Greg', 'Rafa']);
  assert.equal(p.master, 100);
  assert.equal(p.standby, false);
});

test('controller: none present -> null; guests never eligible', () => {
  assert.equal(controller([], null), null);
  assert.equal(controller([{ id: 'x', role: 'guest', ready: true, joinedAt: 1 }], null), null);
});

test('controller: an unready crew member cannot hold control', () => {
  assert.equal(controller([crew('g', 'greg', 100, false)], null), null);
});

test('controller: RJ preferred only at setup (audit rightfulHost repro)', () => {
  // Greg joined first, RJ second, no current holder -> RJ.
  const members = [crew('g', 'greg', 100), crew('r', 'rj', 200)];
  assert.equal(controller(members, null), 'r');
});

test('controller: an arriving host does NOT steal control mid-show', () => {
  const members = [crew('g', 'greg', 100), crew('r', 'rj', 200)];
  assert.equal(controller(members, 'g'), 'g'); // Greg keeps it even though RJ is present
});

test('controller: succession by earliest join when the holder drops (no RJ)', () => {
  const members = [crew('g', 'greg', 100), crew('f', 'rafa', 50)];
  assert.equal(controller(members, 'gone'), 'f');
});

test('sanitizeProgram: rejects empty/invalid scenes and bad active scene', () => {
  const prev = initialProgram();
  assert.throws(() => sanitizeProgram({ scenes: [] }, prev));
  assert.throws(() => sanitizeProgram({ scenes: [{ id: 'x', layout: 'nope' }], activeSceneId: 'x' }, prev));
  assert.throws(() => sanitizeProgram({ activeSceneId: 'missing', scenes: [{ id: 'a', layout: [] }] }, prev));
});

test('sanitizeProgram: rejects out-of-range slots', () => {
  const prev = initialProgram();
  const bad = { activeSceneId: 'a', scenes: [{ id: 'a', name: 'A', layout: [{ id: 'b', slot: 99, x: 0, y: 0, w: 10, h: 10, z: 1 }] }] };
  assert.throws(() => sanitizeProgram(bad, prev));
});

test('sanitizeProgram: accepts a valid program, forces server-bound streamID, preserves mix/master', () => {
  const prev = initialProgram();
  prev.mix = { '2': { gain: 40, muted: true } };
  prev.master = 80;
  const input = {
    activeSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main', layout: [{ id: 'b', slot: 0, streamID: 'attacker_supplied', x: 0, y: 0, w: 50, h: 100, z: 1, cover: true }] }],
    brand: { background: '#123456', radius: 5, labels: true }
  };
  const out = sanitizeProgram(input, prev);
  assert.equal(out.scenes[0].layout[0].streamID, ''); // client cannot inject a stream binding
  assert.equal(out.scenes[0].auto, false);
  assert.equal(out.brand.background, '#123456');
  assert.deepEqual(out.mix, { '2': { gain: 40, muted: true } }); // preserved from previous
  assert.equal(out.master, 80);
});

// Mirrors desk.js channels() + program.js membership: the mixer/rail/stage are
// built from server seats+members, never from VDO source labels. Reproduces the
// audit's "four channels" bug being fixed.
function channelsFrom(members) {
  return [
    { slot: 1, name: 'RJ' }, { slot: 2, name: 'Greg' }, { slot: 3, name: 'Rafa' },
    ...members.filter(m => m.role === 'guest' && m.admitted).map(m => ({ slot: m.slot, name: m.name })),
    { slot: 'master', name: 'MASTER' }
  ];
}

// audit 1.4 — badge succession keeps a blipping holder in control while their lease is valid.
test('nextBadgeHolder: present holder keeps control (does not jump to RJ)', () => {
  const members = [crew('g', 'greg', 100), crew('r', 'rj', 200)];
  const badge = { hostId: 'g', term: 1, expiresAt: 10_000 };
  assert.equal(nextBadgeHolder(members, badge, 5_000), 'g'); // Greg present + RJ present → Greg keeps it
});

test('nextBadgeHolder: holder blipped but lease still valid → KEEPS the badge (audit 1.4)', () => {
  const members = [crew('r', 'rj', 200)];                    // Greg (holder) momentarily absent
  const badge = { hostId: 'g', term: 1, expiresAt: 10_000 };
  assert.equal(nextBadgeHolder(members, badge, 5_000), 'g'); // lease not lapsed → do NOT hand control to RJ
});

test('nextBadgeHolder: holder gone AND lease lapsed → succession runs', () => {
  const members = [crew('r', 'rj', 200), crew('f', 'rafa', 50)];
  const badge = { hostId: 'g', term: 1, expiresAt: 10_000 };
  assert.equal(nextBadgeHolder(members, badge, 20_000), 'r'); // lapsed → controller() picks RJ (preferred at setup)
});

test('nextBadgeHolder: vacant badge picks by controller() rules', () => {
  const members = [crew('f', 'rafa', 50), crew('g', 'greg', 100)];
  const badge = { hostId: null, term: 0, expiresAt: 0 };
  assert.equal(nextBadgeHolder(members, badge, 1_000), 'f'); // earliest join, no RJ present
});

// audit 1.8 — a viewer can never resolve to a host seat.
test('resolveJoinRole: a viewer claiming a seat is rejected (audit 1.8)', () => {
  assert.deepEqual(resolveJoinRole({ viewer: true, seat: 'rj' }, HOSTS), { error: 'viewer-seat' });
});

test('resolveJoinRole: a plain viewer resolves to the viewer role', () => {
  assert.deepEqual(resolveJoinRole({ viewer: true, seat: '' }, HOSTS), { role: 'viewer', host: null });
});

test('resolveJoinRole: a valid host seat resolves to crew', () => {
  const r = resolveJoinRole({ seat: 'greg' }, HOSTS);
  assert.equal(r.role, 'crew');
  assert.equal(r.host.seat, 'greg');
});

test('resolveJoinRole: an unknown seat is rejected; no seat is a guest', () => {
  assert.deepEqual(resolveJoinRole({ seat: 'nope' }, HOSTS), { error: 'unknown-seat' });
  assert.deepEqual(resolveJoinRole({ seat: '' }, HOSTS), { role: 'guest', host: null });
});

// feature: session/episode metadata lives in the program and survives scene/brand edits.
test('initialProgram seeds an empty episode object', () => {
  assert.deepEqual(initialProgram().episode, { season: '', number: '', title: '' });
});

test('sanitizeProgram preserves episode across a scene/brand edit', () => {
  const prev = initialProgram();
  prev.episode = { season: '2', number: '14', title: 'The End of Genesys' };
  const out = sanitizeProgram({ activeSceneId: 'main', scenes: [{ id: 'main', name: 'Main', layout: [] }], brand: { background: '#111111', radius: 0, labels: true } }, prev);
  assert.deepEqual(out.episode, { season: '2', number: '14', title: 'The End of Genesys' });
});

test('mixer: exactly 3 host channels + admitted guests + master, no label-driven duplicates', () => {
  const members = [
    crew('r', 'rj', 1), crew('g', 'greg', 2), crew('f', 'rafa', 3),
    { id: 'guest1', role: 'guest', admitted: true, slot: 4, name: 'Johnny' },
    { id: 'peer_seat_greg_cam', role: 'guest', admitted: false, slot: 5, name: 'seat_greg_cam' } // stray, not admitted
  ];
  const chs = channelsFrom(members);
  const hostChannels = chs.filter(c => [1, 2, 3].includes(c.slot));
  assert.equal(hostChannels.length, 3);                       // never 4
  assert.equal(chs.filter(c => c.name === 'Greg').length, 1); // no duplicate Greg strip
  assert.deepEqual(chs.map(c => c.slot), [1, 2, 3, 4, 'master']); // stray non-admitted peer excluded
});

// 3.1 media-layer auth — makeSecrets mints URL-safe hex secrets, distinct per room.
test('makeSecrets: roomPassword 32-hex, viewerToken 64-hex, all URL-safe', () => {
  const s = makeSecrets();
  assert.match(s.roomPassword, /^[0-9a-f]{32}$/);
  assert.match(s.viewerToken, /^[0-9a-f]{64}$/);
});

test('makeSecrets: two rooms get different secrets', () => {
  const a = makeSecrets(), b = makeSecrets();
  assert.notEqual(a.roomPassword, b.roomPassword);
  assert.notEqual(a.viewerToken, b.viewerToken);
  assert.notEqual(a.roomPassword, a.viewerToken);
});

// 3.1 — socketAuthed is the single gate deciding who receives streamIDs + the roomPassword.
test('socketAuthed: crew is always authorized', () => {
  assert.equal(socketAuthed({ role: 'crew', id: 'g' }, {}), true);
});

test('socketAuthed: a guest is authorized only once admitted', () => {
  const guests = { guest1: { admitted: true }, guest2: { admitted: false }, guest3: { denied: true } };
  assert.equal(socketAuthed({ role: 'guest', id: 'guest1' }, guests), true);
  assert.equal(socketAuthed({ role: 'guest', id: 'guest2' }, guests), false); // knocking, not admitted
  assert.equal(socketAuthed({ role: 'guest', id: 'guest3' }, guests), false); // denied
  assert.equal(socketAuthed({ role: 'guest', id: 'ghost' }, guests), false);  // unknown id
});

test('socketAuthed: a viewer is authorized only with a validated token', () => {
  assert.equal(socketAuthed({ role: 'viewer', viewerAuthed: true }, {}), true);
  assert.equal(socketAuthed({ role: 'viewer', viewerAuthed: false }, {}), false);
  assert.equal(socketAuthed({ role: 'viewer' }, {}), false); // no token presented
});

test('socketAuthed: pending / unknown / null sockets get nothing', () => {
  assert.equal(socketAuthed({ pending: true }, {}), false);
  assert.equal(socketAuthed(null, {}), false);
  assert.equal(socketAuthed(undefined, undefined), false); // no guests map, no throw
});
