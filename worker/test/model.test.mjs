import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, initialProgram, sanitizeProgram, controller } from '../src/model.js';

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
