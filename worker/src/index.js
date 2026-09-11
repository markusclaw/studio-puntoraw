import { DurableObject } from 'cloudflare:workers';
import { HOSTS, LEASE_MS, PRESENCE_MS, initialProgram, sanitizeProgram, controller } from './model.js';

// One room owns seats, media identities, program and controller authority.
export class RawStudioRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx,env); this.env=env; this.program=initialProgram(); this.badge={hostId:null,term:0,expiresAt:0};
    this.guests={}; this.seats={};
    ctx.blockConcurrencyWhile(async()=>{
      this.program=await ctx.storage.get('program-v2') || initialProgram();
      this.badge=await ctx.storage.get('badge-v2') || this.badge;
      this.guests=await ctx.storage.get('guests-v2') || {};
      this.seats=await ctx.storage.get('seats-v2') || {};
    });
  }
  attachments(exclude) { return this.ctx.getWebSockets().filter(w=>w!==exclude).map(w=>({ws:w,...w.deserializeAttachment()})).filter(a=>a.id && !a.closed && Date.now()-a.lastSeen<PRESENCE_MS); }
  members(exclude) {
    return this.attachments(exclude).filter(a=>a.role!=='viewer').map(({ws,token,...a})=>({...a, admitted:a.role==='crew'||!!this.guests[a.id]?.admitted}));
  }
  async persist() { await this.ctx.storage.put({'program-v2':this.program,'badge-v2':this.badge,'guests-v2':this.guests,'seats-v2':this.seats}); }
  async reconcile(exclude) {
    const members=this.members(exclude);
    const next=controller(members,this.badge.hostId);
    if(next!==this.badge.hostId) this.badge={hostId:next,term:this.badge.term+1,expiresAt:next?Date.now()+LEASE_MS:0};
    // Expired clients cannot retain a seat, authority, or program membership.
    for(const ws of this.ctx.getWebSockets()) {
      const a=ws.deserializeAttachment();
      if(a && !a.closed && Date.now()-a.lastSeen>=PRESENCE_MS) { ws.serializeAttachment({...a,closed:true}); try{ws.close(4000,'Presence expired');}catch{} }
    }
    await this.ctx.storage.setAlarm(Date.now()+5000);
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
    await this.ctx.storage.setAlarm(Date.now()+5000);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async join(ws,m) {
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(m.id||'') || !/^[a-zA-Z0-9_-]{16,100}$/.test(m.token||'')) return this.error(ws,'identity','Invalid session identity');
    const host=HOSTS.find(h=>h.seat===m.seat);
    let role=m.viewer?'viewer':host?'crew':'guest';
    if(m.seat && !host) return this.error(ws,'seat','Unknown host seat');
    if(role==='crew' && (!this.env.CREW_CODE || m.code!==this.env.CREW_CODE)) return this.error(ws,'auth','Enter the private host code to reserve this seat.');
    await this.reconcile();
    const existing=this.attachments(ws).find(a=>a.id===m.id);
    const reservation=host && this.seats[host.seat];
    if(reservation && reservation.until>Date.now() && (reservation.id!==m.id || reservation.token!==m.token)) return this.error(ws,'occupied',host.name+' is already reserved. Leave on the other device or wait 30 seconds after disconnecting.');
    if(existing && (existing.token!==m.token || existing.seat!==(host?.seat||'') || existing.role!==role)) return this.error(ws,'identity','Session identity is already in use');
    if(host && this.attachments(ws).some(a=>a.seat===host.seat && a.id!==m.id)) return this.error(ws,'occupied',host.name+' is already connected. Leave on the other device before switching.');
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
    if(m.type==='leave') { ws.serializeAttachment({...a,closed:true}); if(a.role==='guest') delete this.guests[a.id]; if(a.seat) delete this.seats[a.seat]; await this.reconcile(); await this.persist(); this.broadcast(); try{ws.close(1000,'Left');}catch{} return; }
    if(m.type==='ready') { a.ready=true; ws.serializeAttachment(a); }
    else if(m.type==='claim') {
      if(a.role!=='crew'||!a.ready) return this.error(ws,'forbidden','Only a host in the studio can take control.');
      this.badge={hostId:a.id,term:this.badge.term+1,expiresAt:Date.now()+LEASE_MS};
    } else if(m.type==='pass') {
      if(!owns || !this.members().some(x=>x.id===m.target && x.role==='crew' && x.ready)) return this.error(ws,'forbidden','Invalid control transfer');
      this.badge={hostId:m.target,term:this.badge.term+1,expiresAt:Date.now()+LEASE_MS};
    } else if(m.type==='admit'||m.type==='deny') {
      if(!owns || !this.guests[m.target]) return this.error(ws,'forbidden','Only the controller can admit or remove a guest.');
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
    for(const ws of this.ctx.getWebSockets()) {const a=ws.deserializeAttachment();if(a?.pending && Date.now()-a.lastSeen>10000){try{ws.close(4002,'Join timeout');}catch{}}}
    await this.reconcile();
    const present=new Set(this.members().map(a=>a.id));
    for(const [id,g] of Object.entries(this.guests)) { if(present.has(id)) g.seenAt=Date.now(); else if(Date.now()-g.seenAt>60000) delete this.guests[id]; }
    await this.persist(); this.broadcast();
    if(!this.attachments().length) await this.ctx.storage.deleteAlarm();
  }
}
export default { async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if(path==='/health') return Response.json({ok:true,protocol:2});
  const match=path.match(/^\/room\/([A-Za-z0-9_.-]{1,80})$/);
  if(!match) return new Response('Not found',{status:404});
  return env.RAW_ROOM.get(env.RAW_ROOM.idFromName(match[1])).fetch(request);
} };
