export const HOSTS = [{ seat: 'rj', name: 'RJ', slot: 1 }, { seat: 'greg', name: 'Greg', slot: 2 }, { seat: 'rafa', name: 'Rafa', slot: 3 }];
export const LEASE_MS = 20000;
export const PRESENCE_MS = 30000;
export function initialProgram() {
  return { revision: 0, activeSceneId: 'main', scenes: [{ id: 'main', name: 'Main', auto: false, layout: HOSTS.map((h, i) => ({ id: 'box_'+h.seat, slot: i, streamID: '', label: h.name, x: i*100/3, y: 0, w: 100/3, h: 100, z: i+1, cover: true })) }], brand: { background: '#0c0b0a', radius: 0, labels: true }, mix: {}, master: 100, masterMuted: false, standby: false, logo: false, session: { live: false, startedAt: null } };
}
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function sanitizeProgram(input, previous) {
  if (!input || !Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 24) throw new Error('Invalid scenes');
  const ids = new Set();
  const scenes = input.scenes.map(s => {
    if (!s || typeof s.id !== 'string' || s.id.length > 80 || ids.has(s.id) || !Array.isArray(s.layout) || s.layout.length > 16) throw new Error('Invalid scene');
    ids.add(s.id);
    return { id: s.id, name: String(s.name || 'Scene').slice(0,80), auto: false, layout: s.layout.map((b,i) => {
      if (!b || !Number.isInteger(b.slot) || b.slot < 0 || b.slot > 18 || !num(b.x,0,100) || !num(b.y,0,100) || !num(b.w,0.1,100) || !num(b.h,0.1,100)) throw new Error('Invalid layout');
      return { id: String(b.id || 'box_'+i).slice(0,80), slot: b.slot, streamID: '', label: String(b.label || '').slice(0,80), x:b.x,y:b.y,w:Math.min(b.w,100-b.x),h:Math.min(b.h,100-b.y),z:num(b.z,0,100)?b.z:i+1,cover:b.cover!==false };
    }) };
  });
  if (!ids.has(input.activeSceneId)) throw new Error('Invalid active scene');
  const b=input.brand || previous.brand;
  return { ...previous, activeSceneId: input.activeSceneId, scenes, brand: { background: /^#[\da-f]{6}$/i.test(b.background)?b.background:previous.brand.background, radius:num(b.radius,0,32)?b.radius:0, labels:b.labels!==false } };
}
export function controller(members, currentId) {
  const crew=members.filter(m=>m.role==='crew' && m.ready);
  if (crew.some(m=>m.id===currentId)) return currentId;
  return crew.sort((a,b)=>(a.seat==='rj'?-1:b.seat==='rj'?1:0) || a.joinedAt-b.joinedAt)[0]?.id || null;
}

// audit 1.4: badge succession. While the holder's socket is merely blipping (absent from
// `members`) but their lease is still valid, KEEP the badge so a refresh/reconnect returns them to
// control instead of it jumping to RJ. Reassign only once the holder is present again (normal
// controller() rules) or the lease has lapsed. Pure so it is unit-tested directly.
export function nextBadgeHolder(members, badge, now) {
  const holderPresent = !!badge.hostId && members.some(m=>m.id===badge.hostId);
  if (holderPresent) return controller(members, badge.hostId);
  if (badge.hostId && badge.expiresAt > now) return badge.hostId;
  return controller(members, null);
}

// audit 1.8: resolve a join request's role from its seat claim, rejecting a viewer that tries to
// claim a host seat BEFORE any seat reservation is touched. Returns {error} or {role, host}.
export function resolveJoinRole(m, hosts) {
  if (m.viewer && m.seat) return { error: 'viewer-seat' };            // a viewer must never resolve to a host seat
  const host = m.viewer ? null : hosts.find(h=>h.seat===m.seat) || null;
  if (m.seat && !m.viewer && !host) return { error: 'unknown-seat' };
  return { role: m.viewer ? 'viewer' : host ? 'crew' : 'guest', host };
}
