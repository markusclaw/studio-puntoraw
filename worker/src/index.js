import { DurableObject } from 'cloudflare:workers';
import { HOSTS, LEASE_MS, PRESENCE_MS, initialProgram, sanitizeProgram, controller, nextBadgeHolder, resolveJoinRole } from './model.js';

const ALARM_MS = 10000; // reconcile/presence cadence. Presence 30s, lease 20s tolerate this; 10s ~halves alarm-driven DO requests vs 5s.

// One room owns seats, media identities, program and controller authority.
export class RawStudioRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx,env); this.env=env; this.program=initialProgram(); this.badge={hostId:null,term:0,expiresAt:0};
    this.guests={}; this.seats={};
    this._saved={}; // JSON of last-written value per key, for change detection in persist()
    ctx.blockConcurrencyWhile(async()=>{
      this.program=await ctx.storage.get('program-v2') || initialProgram();
      // Persisted badge/guests/seats carry only durable fields; rolling fields
      // (lease expiry, presence timestamps) are rebuilt here so they never drive writes.
      const b=await ctx.storage.get('badge-v2'); this.badge=b?{hostId:b.hostId,term:b.term||0,expiresAt:0}:this.badge;
      this.guests=await ctx.storage.get('guests-v2') || {}; for(const g of Object.values(this.guests)) g.seenAt=Date.now();
      this.seats=await ctx.storage.get('seats-v2') || {}; for(const s of Object.values(this.seats)) s.until=Date.now()+PRESENCE_MS;
      // Prime the change-cache from what we just loaded so the first persist after a
      // wake-up writes nothing unless state has actually diverged from storage.
      for(const [k,v] of Object.entries(this._normalized())) this._saved[k]=JSON.stringify(v);
    });
  }
  attachments(exclude) { return this.ctx.getWebSockets().filter(w=>w!==exclude).map(w=>({ws:w,...w.deserializeAttachment()})).filter(a=>a.id && !a.closed && Date.now()-a.lastSeen<PRESENCE_MS); }
  members(exclude) {
    return this.attachments(exclude).filter(a=>a.role!=='viewer').map(({ws,token,...a})=>({...a, admitted:a.role==='crew'||!!this.guests[a.id]?.admitted}));
  }
  // Durable projection of room state: only fields that must survive a restart. Roll-only
  // fields (badge.expiresAt, guest.seenAt, seat.until) are omitted so they never drive writes.
  _normalized() {
    return {
      'program-v2':this.program,
      'badge-v2':{hostId:this.badge.hostId,term:this.badge.term},
      'guests-v2':Object.fromEntries(Object.entries(this.guests).map(([k,g])=>[k,{token:g.token,slot:g.slot,streamID:g.streamID,admitted:!!g.admitted}])),
      'seats-v2':Object.fromEntries(Object.entries(this.seats).map(([k,s])=>[k,{id:s.id,token:s.token,streamID:s.streamID}]))
    };
  }
  async persist() {
    // Write only keys whose durable content changed, so a steady-state room's alarm writes
    // zero rows — the fix for the 126k SQL-row DO burn. _saved is updated ONLY after the put
    // succeeds, so a transient write error just leaves the key dirty for the next persist
    // (no silent data loss) and never throws up into a handler or the alarm.
    const norm=this._normalized(), put={}, dirty=[];
    for(const k in norm){ const s=JSON.stringify(norm[k]); if(this._saved[k]!==s){ put[k]=norm[k]; dirty.push([k,s]); } }
    if(!dirty.length) return;
    try { await this.ctx.storage.put(put); for(const [k,s] of dirty) this._saved[k]=s; }
    catch(e){ console.warn('persist failed, will retry next cycle',e); }
  }
  async reconcile(exclude) {
    const members=this.members(exclude);
    // Succession by lease (audit 1.4): if the holder's socket blipped (absent from members)
    // but their lease is still valid and they didn't send `leave`, KEEP the badge so a
    // refresh/reconnect returns to control instead of it jumping to RJ. Reassign only once
    // the lease lapses. An explicit `leave` vacates the badge (below) so succession is instant.
    const prevHost=this.badge.hostId;
    const holderPresent = !!this.badge.hostId && members.some(m=>m.id===this.badge.hostId);
    const next = nextBadgeHolder(members, this.badge, Date.now());   // audit 1.4 (extracted to model.js, unit-tested)
    if(next!==this.badge.hostId) this.badge={hostId:next,term:this.badge.term+1,expiresAt:next?Date.now()+LEASE_MS:0};
    else if(next && holderPresent) this.badge.expiresAt=Date.now()+LEASE_MS;   // refresh the lease only while the holder is actually present, so a blip counts down and eventually reassigns
    // audit 2.8: report whether reconcile changed anything observable (badge holder, or a socket
    // closed for presence expiry) so the alarm only broadcasts when there's something to send.
    let changed = this.badge.hostId!==prevHost;
    // Expired clients cannot retain a seat, authority, or program membership.
    for(const ws of this.ctx.getWebSockets()) {
      const a=ws.deserializeAttachment();
      if(a && !a.closed && Date.now()-a.lastSeen>=PRESENCE_MS) { ws.serializeAttachment({...a,closed:true}); try{ws.close(4000,'Presence expired');}catch{} changed=true; }
    }
    await this.ctx.storage.setAlarm(Date.now()+ALARM_MS);
    return changed;
  }
  stateMsg() {
    return {type:'state',protocol:2,badge:this.badge,members:this.members(),program:this.program,serverTime:Date.now()};
  }
  send(ws,msg) { try{ws.send(JSON.stringify(msg));}catch{} }
  broadcast() { for(const ws of this.ctx.getWebSockets()) if(!ws.deserializeAttachment()?.closed) this.send(ws,this.stateMsg()); }
  error(ws,code,message) { this.send(ws,{type:'error',code,message}); }
  async fetch(request) {
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response('Expected WebSocket',{status:426});
    const origin=request.headers.get('Origin')||'';
    if(origin && origin!=='https://studio.puntoraw.org' && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return new Response('Forbidden origin',{status:403});
    const pair=new WebSocketPair(), ws=pair[1]; this.ctx.acceptWebSocket(ws);
    // Authenticate in the first message: no codes/tokens in URLs or access logs.
    ws.serializeAttachment({pending:true,lastSeen:Date.now()});
    this.send(ws,{type:'hello',protocol:2});
    await this.ctx.storage.setAlarm(Date.now()+ALARM_MS);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async join(ws,m) {
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(m.id||'') || !/^[a-zA-Z0-9_-]{16,100}$/.test(m.token||'')) return this.error(ws,'identity','Invalid session identity');
    const rr=resolveJoinRole(m,HOSTS);   // audit 1.8 (extracted to model.js, unit-tested)
    if(rr.error==='viewer-seat') return this.error(ws,'seat','Viewers cannot claim seats');
    if(rr.error==='unknown-seat') return this.error(ws,'seat','Unknown host seat');
    const host=rr.host, role=rr.role;
    if(role==='crew' && (!this.env.CREW_CODE || m.code!==this.env.CREW_CODE)) return this.error(ws,'auth','Enter the private host code to reserve this seat.');
    await this.reconcile();
    const existing=this.attachments(ws).find(a=>a.id===m.id);
    const reservation=host && this.seats[host.seat];
    if(reservation && reservation.until>Date.now() && (reservation.id!==m.id || reservation.token!==m.token)) return this.error(ws,'occupied',host.name+' is already reserved. Leave on the other device or wait 30 seconds after disconnecting.');
    if(existing && (existing.token!==m.token || existing.seat!==(host?.seat||'') || existing.role!==role)) return this.error(ws,'identity','Session identity is already in use');
    if(host && this.attachments(ws).some(a=>a.seat===host.seat && a.role==='crew' && a.id!==m.id)) return this.error(ws,'occupied',host.name+' is already connected. Leave on the other device before switching.');
    if(role==='guest' && !existing && this.members().filter(a=>a.role==='guest').length>=16) return this.error(ws,'full','The guest room is full.');
    let saved=role==='guest'?this.guests[m.id]:null;
    if(saved && saved.token!==m.token) return this.error(ws,'identity','Invalid guest session');
    const used=this.members().map(a=>a.slot).concat(Object.values(this.guests).map(a=>a.slot));
    let slot=host?.slot || saved?.slot || Array.from({length:16},(_,i)=>i+4).find(s=>!used.includes(s));
    if(role==='guest' && !slot) return this.error(ws,'full','No guest seats available');
    const streamID=existing?.streamID || (reservation?.id===m.id && reservation?.token===m.token ? reservation.streamID : null) || saved?.streamID || 'raw_'+crypto.randomUUID().replaceAll('-','');
    const a={id:m.id,token:m.token,name:host?.name||String(m.name||'Guest').trim().slice(0,60),role,seat:host?.seat||'',slot:slot||0,streamID,ready:role==='viewer'?false:!!m.ready,joinedAt:existing?.joinedAt||Date.now(),lastSeen:Date.now(),closed:false};
    if(existing) { existing.ws.serializeAttachment({...existing.ws.deserializeAttachment(),closed:true}); this.send(existing.ws,{type:'replaced'}); try{existing.ws.close(4001,'Session replaced');}catch{} }
    ws.serializeAttachment(a);
    if(host) this.seats[host.seat]={id:m.id,token:m.token,streamID,until:Date.now()+PRESENCE_MS};
    if(role==='guest') this.guests[m.id]={token:m.token,slot,streamID,admitted:!!saved?.admitted,seenAt:Date.now()};
    await this.reconcile(); await this.persist();
    this.send(ws,{type:'joined',member:{...a,token:undefined},protocol:2}); this.broadcast();
  }
  async webSocketMessage(ws,raw) {
    if(typeof raw!=='string' || raw.length>100000) return;
    let m; try{m=JSON.parse(raw);}catch{return;}
    const a=ws.deserializeAttachment();
    if(a?.pending) { if(m.type==='join') await this.join(ws,m); return; }
    if(!a || a.closed) return;
    if(Date.now()-a.lastSeen>=PRESENCE_MS) { ws.serializeAttachment({...a,closed:true}); try{ws.close(4000,'Presence expired');}catch{} await this.reconcile(); await this.persist(); this.broadcast(); return; }
    if(m.type==='ping') {
      a.lastSeen=Date.now(); ws.serializeAttachment(a);
      if(a.seat && this.seats[a.seat]?.id===a.id)this.seats[a.seat].until=Date.now()+PRESENCE_MS;
      if(this.badge.hostId===a.id) this.badge.expiresAt=Date.now()+LEASE_MS;
      this.send(ws,{type:'pong',serverTime:Date.now(),expiresAt:this.badge.expiresAt});
      return;
    }
    const owns=a.role==='crew' && a.ready && this.badge.hostId===a.id && this.badge.term===m.term && this.badge.expiresAt>Date.now();
    if(m.type==='leave') { ws.serializeAttachment({...a,closed:true}); if(this.badge.hostId===a.id) this.badge={hostId:null,term:this.badge.term+1,expiresAt:0}; if(a.role==='guest'){ delete this.guests[a.id]; delete this.program.mix[String(a.slot)]; } if(a.seat) delete this.seats[a.seat]; await this.reconcile(); await this.persist(); this.broadcast(); try{ws.close(1000,'Left');}catch{} return; }
    if(m.type==='ready') { a.ready=true; ws.serializeAttachment(a); }
    else if(m.type==='claim') {
      if(a.role!=='crew'||!a.ready) return this.error(ws,'forbidden','Only a host in the studio can take control.');
      // RJ-gated: while a controller is live, only RJ may override it. A vacant
      // badge (expired, or the holder has left) anyone ready may fill; the
      // current holder may always refresh their own lease.
      const live=this.badge.hostId && this.badge.expiresAt>Date.now() && this.members().some(x=>x.id===this.badge.hostId);
      if(live && this.badge.hostId!==a.id && a.seat!=='rj') return this.error(ws,'forbidden','RJ holds control — ask to have it passed.');
      this.badge={hostId:a.id,term:this.badge.term+1,expiresAt:Date.now()+LEASE_MS};
    } else if(m.type==='pass') {
      if(!owns || !this.members().some(x=>x.id===m.target && x.role==='crew' && x.ready)) return this.error(ws,'forbidden','Invalid control transfer');
      this.badge={hostId:m.target,term:this.badge.term+1,expiresAt:Date.now()+LEASE_MS};
    } else if(m.type==='admit'||m.type==='deny') {
      if(!owns || !Object.hasOwn(this.guests,m.target)) return this.error(ws,'forbidden','Only the controller can admit or remove a guest.');   // audit 3.3: own-property check so a target like "__proto__" can't resolve to an inherited value
      this.guests[m.target].admitted=m.type==='admit';
    } else if(m.type==='program') {
      if(!owns) return this.error(ws,'forbidden','Control changed. Your change was not applied.');
      if(m.revision!==this.program.revision) { this.send(ws,this.stateMsg()); return this.error(ws,'conflict','The room changed. Retry your change.'); }
      try { this.program={...sanitizeProgram(m.program,this.program),revision:this.program.revision+1}; }
      catch(e){return this.error(ws,'invalid',e.message);}
    } else if(m.type==='mix') {
      if(!owns) return this.error(ws,'forbidden','Only the controller can change the mix.');
      const slots=[1,2,3,...this.members().filter(x=>x.admitted).map(x=>x.slot)];
      if(m.slot==='master') { if(typeof m.muted==='boolean') this.program.masterMuted=m.muted; if(typeof m.gain==='number' && m.gain>=0 && m.gain<=100) this.program.master=m.gain; }
      else if(slots.includes(m.slot)) { const key=String(m.slot), prev=this.program.mix[key]||{gain:100,muted:false}; this.program.mix[key]={gain:typeof m.gain==='number'&&m.gain>=0&&m.gain<=100?m.gain:prev.gain,muted:typeof m.muted==='boolean'?m.muted:prev.muted}; }
      else return this.error(ws,'invalid','Unknown mixer channel');
      this.program.revision++;
    } else if(m.type==='broadcast') {
      if(!owns) return this.error(ws,'forbidden','Only the controller can change the program.');
      if(typeof m.standby==='boolean') this.program.standby=m.standby;
      if(typeof m.logo==='boolean') this.program.logo=m.logo;
      if(typeof m.live==='boolean') this.program.session={live:m.live,startedAt:m.live?(this.program.session.live?this.program.session.startedAt:Date.now()):null};
      this.program.revision++;
    } else return;
    await this.reconcile(); await this.persist(); this.broadcast();
  }
  async webSocketClose(ws) { const a=ws.deserializeAttachment(); if(a) ws.serializeAttachment({...a,closed:true}); await this.reconcile(); await this.persist(); this.broadcast(); }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async alarm() {
    try {
      for(const ws of this.ctx.getWebSockets()) {const a=ws.deserializeAttachment();if(a?.pending && Date.now()-a.lastSeen>10000){try{ws.close(4002,'Join timeout');}catch{}}}
      let changed=await this.reconcile();
      const present=new Set(this.members().map(a=>a.id));
      for(const [id,g] of Object.entries(this.guests)) { if(present.has(id)) g.seenAt=Date.now(); else if(Date.now()-g.seenAt>60000){ delete this.guests[id]; delete this.program.mix[String(g.slot)]; changed=true; } }
      await this.persist(); if(changed) this.broadcast();   // audit 2.8: a steady-state alarm cycle no longer broadcasts to every socket
    } catch(e){ console.warn('alarm error',e); }
    // Reschedule while ANY socket is still open — including not-yet-joined pending sockets, so
    // their join-timeout still fires. Runs even if the body threw, so a transient error can't
    // strand the room or trip Cloudflare's alarm-retry backoff (extra billed invocations).
    try {
      const live=this.ctx.getWebSockets().some(w=>!w.deserializeAttachment()?.closed);
      if(live) await this.ctx.storage.setAlarm(Date.now()+ALARM_MS); else await this.ctx.storage.deleteAlarm();
    } catch{}
  }
}
export default { async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if(path==='/health') return Response.json({ok:true,protocol:2});
  const match=path.match(/^\/room\/([A-Za-z0-9_.-]{1,80})$/);
  if(!match) return new Response('Not found',{status:404});
  return env.RAW_ROOM.get(env.RAW_ROOM.idFromName(match[1])).fetch(request);
} };
