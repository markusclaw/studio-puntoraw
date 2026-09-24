/* A read-only renderer shared by the console preview and OBS Browser Source. */
(function(){
 const p=new URLSearchParams(location.search),room=p.get('room')||'master_sessions_raw',monitor=p.has('monitor');
 const client=new RawRoomClient(room,{id:crypto.randomUUID(),token:crypto.randomUUID(),viewer:true});
 const container=document.getElementById('program'),standby=document.getElementById('standby'),message=document.getElementById('standby-message');
 const tiles=new Map();let snapshot=null,offline=true,solo=null,interrupted=false,fatalMsg='',offlineTimer=null;
 // Watchdog thresholds. A viewer that never produces a first frame, or whose decoded-frame
 // counter stalls, is silently reconnected by rebuilding its iframe — VDO keeps the same
 // streamID across publisher blips, so nothing else would ever recover a frozen tile.
 // DROP_GRACE_MS (audit 1.2): keep a live tile through a control-channel blip ~= PRESENCE_MS,
 // so a reconnecting host doesn't black out on air. OFFLINE_CARD_MS (audit 1.1): the console
 // monitor waits this long before showing an interruption card; OBS never shows one.
 const FIRST_FRAME_MS=12000, STALL_MS=7000, REMOUNT_COOLDOWN_MS=15000, DROP_GRACE_MS=25000, OFFLINE_CARD_MS=20000;
 function volume(tile){
   if(!tile.frame||!snapshot)return;
   const mix=snapshot.program.mix[String(tile.slot)]||{gain:100,muted:false};
   const muted=monitor || snapshot.program.standby || snapshot.program.masterMuted || mix.muted;   // audit 1.1: a control-channel blip must NOT mute the OBS output — the VDO P2P media is unaffected
   const gain=muted?0:(mix.gain/100)*(snapshot.program.master/100);
   tile.frame.contentWindow?.postMessage({volume:gain},'https://vdo.ninja');
   tile.frame.contentWindow?.postMessage({mute:muted},'https://vdo.ninja');
 }
 // Build (or rebuild) the VDO view iframe for a tile. The combo that works is
 // `room` + `view=ID` + `solo=1`: a bare view=ID renders black (stream IDs are salted by the
 // room), and `room`+`view` WITHOUT a join mode makes VDO.Ninja show its "Join Room" chooser
 // (hidden by cleanoutput → black). solo=1 (VDO's own "solo link" form) views that one stream
 // cleanly. `scene` (even as an empty `scene=`) also works — both were verified live side by
 // side on 2026-09-24; the chooser seen with `scene=` came from a stale cached program.js that
 // had neither flag. solo=1 is kept because it is the documented single-guest form.
 // Rebuilding is also how a frozen/stale connection is recovered, since the streamID never changes.
 function mountView(tile,box,streamID){
   tile.frame?.remove();
   tile.streamID=streamID;tile.connected=false;tile.mountAt=Date.now();
   tile.frames=-1;tile.framesAt=Date.now();tile.remountAt=Date.now();
   const q=new URLSearchParams({room,view:streamID,solo:'1',cleanoutput:'',autostart:'',speakermute:'',transparent:'',cover:box.cover===false?'0':'1'});
   if(p.get('password'))q.set('password',p.get('password'));
   // The console's own preview pane is a monitor, not the OBS output: ask the publisher for a
   // lighter stream so each host's upload (VDO is peer-to-peer) isn't multiplied at full rate.
   if(monitor)q.set('videobitrate','1200');
   const f=document.createElement('iframe');f.title=tile.name.textContent;f.allow='autoplay';f.src='https://vdo.ninja/?'+q;
   tile.frame=f;f.addEventListener('load',()=>volume(tile));tile.el.insertBefore(f,tile.name);
 }
 function memberPresent(streamID){
   return !!snapshot?.members.find(m=>m.streamID===streamID&&(m.role==='crew'&&m.ready||m.role==='guest'&&m.admitted));
 }
 // Deep-scan a getStats payload for a decoded/received frame counter, whatever its exact
 // shape (VDO currently reports it as `_decodeFrames` under inbound.<streamID>.<trackId>). Returns -1 when none is found, so an unrecognised stats format can never trigger
 // a reconnect (fail-safe: the watchdog only acts on positive evidence of a stall).
 function frameCount(stats){
   let n=-1;const scan=o=>{if(!o||typeof o!=='object')return;
     for(const k in o){const v=o[k];
       if(typeof v==='number'&&/(frames?_?(decoded|received)|decoded?_?frames)/i.test(k))n=Math.max(n,v);
       else if(v&&typeof v==='object')scan(v);}};
   scan(stats);return n;
 }
 function render(){
   if(!snapshot)return;
   const program=snapshot.program,scene=program.scenes.find(s=>s.id===program.activeSceneId),keep=new Set();
   document.body.style.background=program.brand.background;
   for(const box of scene?.layout||[]){
     const key=box.slot;keep.add(key);let tile=tiles.get(key);   // audit 1.5: key tiles by SLOT (stable) not box.id (regenerated on every layout switch) so mode changes restyle in place instead of remounting the VDO iframe
     if(!tile){const el=document.createElement('div');el.className='tile';const wait=document.createElement('div');wait.className='waiting';const name=document.createElement('div');name.className='name';el.append(wait,name);container.appendChild(el);tile={el,wait,name,frame:null,streamID:null};tiles.set(key,tile);}
     tile.slot=box.slot+1;tile.box=box;
     Object.assign(tile.el.style,{left:box.x+'%',top:box.y+'%',width:box.w+'%',height:box.h+'%',zIndex:box.z,borderRadius:program.brand.radius+'px'});
     const member=snapshot.members.find(m=>m.slot===tile.slot&&(m.role==='crew'&&m.ready||m.role==='guest'&&m.admitted));
     tile.name.textContent=member?.name||(['RJ','Greg','Rafa'][box.slot])||box.label||'Guest';tile.name.hidden=!program.brand.labels;
     const streamID=member?.streamID||null;
     if(streamID){
       if(tile.dropTimer){clearTimeout(tile.dropTimer);tile.dropTimer=null;}
       if(tile.streamID!==streamID) mountView(tile,box,streamID);
       tile.wait.textContent='CONNECTING MEDIA';
     } else {
       // presence blip: keep the live iframe through a short grace so a reconnecting host doesn't black out on air; same seat returns with the same streamID (seamless). Sustained absence tears it down.
       if(tile.frame && !tile.dropTimer){
         tile.dropTimer=setTimeout(()=>{tile.frame?.remove();tile.frame=null;tile.streamID=null;tile.dropTimer=null;tile.wait.textContent='WAITING FOR '+tile.name.textContent.toUpperCase();},DROP_GRACE_MS);
       } else if(!tile.frame){ tile.streamID=null;tile.wait.textContent='WAITING FOR '+tile.name.textContent.toUpperCase(); }
     }
     volume(tile);
   }
   for(const [key,tile] of tiles)if(!keep.has(key)){if(tile.dropTimer)clearTimeout(tile.dropTimer);tile.el.remove();tiles.delete(key);}
   const holdVisible=program.standby||!!fatalMsg||(interrupted&&monitor);   // audit 1.1: OBS (!monitor) shows the hold only for a real standby/fatal, never a transient control blip
   standby.hidden=!holdVisible;message.textContent=fatalMsg||(program.standby?'Be right back':'Studio connection interrupted');document.getElementById('logo').hidden=!program.logo;
 }
 // Liveness watchdog: poll each live tile for stats, and rebuild any iframe that never
 // produced a first frame or whose frame counter has stalled while its member is still on
 // air. A cooldown prevents reload loops (and protects the OBS output from flicker).
 function watchdog(){
   const now=Date.now();
   for(const tile of tiles.values()){
     if(!tile.frame||!tile.streamID)continue;
     tile.frame.contentWindow?.postMessage({getStats:true},'https://vdo.ninja');
     if(!memberPresent(tile.streamID) || now-tile.remountAt<REMOUNT_COOLDOWN_MS)continue;
     const noFirstFrame = !tile.connected && now-tile.mountAt>FIRST_FRAME_MS;
     const stalled = tile.connected && tile.frames>0 && now-tile.framesAt>STALL_MS;
     if(noFirstFrame||stalled){ tile.wait.textContent=stalled?'RECONNECTING':'WAITING FOR CAMERA'; mountView(tile,tile.box,tile.streamID); }
   }
 }
 client.addEventListener('state',e=>{snapshot=e.detail;offline=false;interrupted=false;fatalMsg='';clearTimeout(offlineTimer);offlineTimer=null;render();});
 client.addEventListener('offline',()=>{offline=true;if(monitor&&!offlineTimer)offlineTimer=setTimeout(()=>{interrupted=true;render();},OFFLINE_CARD_MS);render();});   // audit 1.1: only the console monitor shows an interruption card, and only after a grace window; OBS keeps the last frame live
 client.addEventListener('fatal',e=>{offline=true;fatalMsg=e.detail;render();});
 // React to VDO readiness + stats messages: iframe load can precede media initialization.
 window.addEventListener('message',e=>{
   if(e.origin!=='https://vdo.ninja')return;
   for(const tile of tiles.values()){
     if(tile.frame?.contentWindow!==e.source)continue;
     if(['video-created','video-added','view-connection','loaded','joined-room'].includes(e.data?.action)){tile.connected=true;volume(tile);}
     if(e.data?.stats){const fc=frameCount(e.data.stats);if(fc>=0){tile.connected=true;if(fc!==tile.frames){tile.frames=fc;tile.framesAt=Date.now();}}}
   }
 });
 const timer=setInterval(()=>{for(const tile of tiles.values())volume(tile);},2000);
 const guard=setInterval(watchdog,3000);
 window.addEventListener('pagehide',()=>{clearInterval(timer);clearInterval(guard);client.close();});
 client.connect();
})();
