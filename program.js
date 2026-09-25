/* A read-only renderer shared by the console preview and OBS Browser Source. */
(function(){
 const p=new URLSearchParams(location.search),room=p.get('room')||'master_sessions_raw',monitor=p.has('monitor');
 // 3.1: join as a viewer carrying the viewerToken from the scene/OBS URL. A valid token authorizes
 // this viewer, so the worker sends it the streamIDs + the roomPassword (captured on client.roomPassword);
 // without it we join but receive no streamIDs and no key, so only the branded standby screen renders.
 const client=new RawRoomClient(room,{id:crypto.randomUUID(),token:crypto.randomUUID(),viewer:true,vtoken:p.get('vtoken')||''});
 const container=document.getElementById('program'),standby=document.getElementById('standby'),message=document.getElementById('standby-message');
 const tiles=new Map();let snapshot=null,offline=true,solo=null,interrupted=false,fatalMsg='',offlineTimer=null,sbAudio=null;
 // Watchdog thresholds. A viewer that never produces a first frame, or whose decoded-frame
 // counter stalls, is silently reconnected by rebuilding its iframe — VDO keeps the same
 // streamID across publisher blips, so nothing else would ever recover a frozen tile.
 // DROP_GRACE_MS (audit 1.2): keep a live tile through a control-channel blip ~= PRESENCE_MS,
 // so a reconnecting host doesn't black out on air. OFFLINE_CARD_MS (audit 1.1): the console
 // monitor waits this long before showing an interruption card; OBS never shows one.
 const FIRST_FRAME_MS=12000, STALL_MS=12000, REMOUNT_COOLDOWN_MS=15000, DROP_GRACE_MS=25000, OFFLINE_CARD_MS=20000;   // audit 2.6: STALL_MS 7s→12s so a brief network stutter no longer triggers a reconnect
 function volume(tile){
   if(!tile.frame||!snapshot)return;
   const mix=snapshot.program.mix[String(tile.slot)]||{gain:100,muted:false};
   const muted=monitor || snapshot.program.standby || snapshot.program.masterMuted || mix.muted;   // audit 1.1: a control-channel blip must NOT mute the OBS output — the VDO P2P media is unaffected
   const gain=muted?0:(mix.gain/100)*(snapshot.program.master/100);
   // audit 2.6: idempotent — only postMessage when the level actually changed, with a 10s
   // keepalive so a reloaded VDO iframe still gets its levels. mountView resets this cache so a
   // freshly-mounted iframe is always addressed.
   const now=Date.now();
   if(tile.lastGain===gain && tile.lastMuted===muted && tile.volAt && now-tile.volAt<10000) return;
   tile.lastGain=gain;tile.lastMuted=muted;tile.volAt=now;
   tile.frame.contentWindow?.postMessage({volume:gain},'https://vdo.ninja');
   tile.frame.contentWindow?.postMessage({mute:muted},'https://vdo.ninja');
 }
 // Standby test tone (~1kHz, the SMPTE-bars tone). LIVE-RUN #1 (fable §2) reworked this:
 //  - NEVER in a monitor. A tone in every host's headphones is the wrong signal (the ON STANDBY
 //    ribbon is the signal), and at −80 dB "off" it could enter the Revelator loopback and keep
 //    ringing — "it stayed ringing until we all refreshed." So the console monitor has no tone at all.
 //  - On the OBS output it is OPT-IN via &tone=1, default off (a continuous 1 kHz on the stream is a
 //    choice, not a default).
 //  - When it does play, it STOPS FOR REAL on release: ramp to zero, stop the oscillator, close the
 //    context, and rebuild a fresh one on the next standby. No oscillator is ever left running.
 const TONE_ENABLED = !monitor && p.get('tone')==='1';
 const TONE_LEVEL = 0.03;
 function ensureTone(){
   if(sbAudio)return sbAudio;
   try{const AC=window.AudioContext||window.webkitAudioContext,ctx=new AC(),osc=ctx.createOscillator(),g=ctx.createGain();
     osc.type='sine';osc.frequency.value=1000;g.gain.value=0.0001;osc.connect(g);g.connect(ctx.destination);osc.start();
     sbAudio={ctx,osc,g};}catch(e){sbAudio=null;}
   return sbAudio;
 }
 function stopTone(){
   const a=sbAudio; sbAudio=null; if(!a)return;   // null immediately so the next standby rebuilds fresh
   try{const t=a.ctx.currentTime;
     a.g.gain.cancelScheduledValues(t);
     a.g.gain.setValueAtTime(Math.max(a.g.gain.value,0.0001),t);
     a.g.gain.exponentialRampToValueAtTime(0.0001,t+0.25);
     a.g.gain.setValueAtTime(0,t+0.26);   // exponential can't reach 0 — land it flat at zero
     try{a.osc.stop(t+0.3);}catch(e){}
     setTimeout(()=>{try{a.ctx.close();}catch(e){}},400);   // release the context entirely, not leave it suspended at −80 dB
   }catch(e){}
 }
 function standbyTone(on){
   if(!TONE_ENABLED){ if(sbAudio)stopTone(); return; }   // monitor / not-opted-in: guarantee silence
   if(!on){ stopTone(); return; }
   const a=ensureTone(); if(!a)return;
   try{
     if(a.ctx.state==='suspended')a.ctx.resume().catch(()=>{});
     const t=a.ctx.currentTime;
     a.g.gain.cancelScheduledValues(t);
     a.g.gain.setValueAtTime(Math.max(a.g.gain.value,0.0001),t);
     a.g.gain.exponentialRampToValueAtTime(TONE_LEVEL,t+0.4);
   }catch(e){}
 }
 // A suspended context (autoplay-blocked tab) resumes on the first interaction, so a standby
 // that was already live starts sounding as soon as the operator touches the page.
 ['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev,()=>{
   if(sbAudio&&sbAudio.ctx.state==='suspended')sbAudio.ctx.resume().catch(()=>{});
 },{passive:true,once:false}));
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
   tile.volAt=0;tile.lastGain=null;tile.lastMuted=null;   // audit 2.6: reset the volume cache so the new iframe is (re)addressed on load
   const q=new URLSearchParams({room,view:streamID,solo:'1',cleanoutput:'',autostart:'',speakermute:'',transparent:'',cover:box.cover===false?'0':'1'});
   if(client.roomPassword)q.set('password',client.roomPassword);   // 3.1: the room key comes from the server (on join), never from the URL
   // The console's own preview pane is a monitor, not the OBS output: ask the publisher for a
   // lighter stream so each host's upload (VDO is peer-to-peer) isn't multiplied at full rate.
   // audit 2.7: 1200→500 kbps and drop audio entirely (the monitor is force-muted anyway, and
   // the desk VU reads loudness from the director iframe, not these tiles). OBS (monitor=false)
   // keeps full bitrate and audio.
   if(monitor){q.set('videobitrate','500');q.set('noaudio','');}
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
       tile.wait.textContent='CONNECTING';   // audit 4.2: shared vocabulary
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
   standby.hidden=!holdVisible;message.textContent=fatalMsg||(program.wrapped&&program.standby?"That's a wrap":program.standby?'Be right back':'Studio connection interrupted');document.getElementById('logo').hidden=!program.logo;
   // feature: show the session/episode metadata on the standby screen ("S2 · E14 · Title")
   const subEl=document.getElementById('standby-sub');
   if(subEl){const ep=program.episode||{};const line=[ep.season&&('S'+ep.season),ep.number&&('E'+ep.number),ep.title].filter(Boolean).join(' · ');subEl.textContent=line||'Standing by';}
   standbyTone(program.standby);   // TV-style standby tone on the OBS output when standby is live
 }
 // Liveness watchdog: poll each live tile for stats, and rebuild any iframe that never
 // produced a first frame or whose frame counter has stalled while its member is still on
 // air. A cooldown prevents reload loops (and protects the OBS output from flicker).
 function watchdog(){
   const now=Date.now();
   for(const tile of tiles.values()){
     if(!tile.frame||!tile.streamID)continue;
     tile.frame.contentWindow?.postMessage({getStats:true},'https://vdo.ninja');
     // audit 2.6: exponential backoff 15→30→60s. A host who legitimately turned their camera off
     // stops advancing frames and would otherwise be remounted every 15s forever; the backoff caps
     // that at once a minute, and a frame advance (see the message handler) resets the count so a
     // genuinely recovered feed gets fast 15s recovery again.
     const cooldown=Math.min(60000, REMOUNT_COOLDOWN_MS*Math.pow(2, tile.remountCount||0));
     if(!memberPresent(tile.streamID) || now-tile.remountAt<cooldown)continue;
     const noFirstFrame = !tile.connected && now-tile.mountAt>FIRST_FRAME_MS;
     const stalled = tile.connected && tile.frames>0 && now-tile.framesAt>STALL_MS;
     if(noFirstFrame||stalled){
       const reason=stalled?'stalled':'no-first-frame';
       tile.remountCount=(tile.remountCount||0)+1;
       console.info('[program] remount',tile.streamID,reason,'#'+tile.remountCount);
       tile.wait.textContent=stalled?'RECONNECTING':'NO CAMERA';   // audit 4.2: shared vocabulary
       mountView(tile,tile.box,tile.streamID);
     }
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
     if(e.data?.stats){const fc=frameCount(e.data.stats);if(fc>=0){tile.connected=true;if(fc!==tile.frames){tile.frames=fc;tile.framesAt=Date.now();tile.remountCount=0;}}}   // audit 2.6: a live, advancing feed resets the remount backoff
   }
 });
 const timer=setInterval(()=>{for(const tile of tiles.values())volume(tile);},2000);
 const guard=setInterval(watchdog,5000);   // audit 2.6: getStats every 5s (was 3s)
 const clockEl=document.getElementById('standby-clock');
 const clock=setInterval(()=>{if(!clockEl)return;const d=new Date(),p=n=>String(n).padStart(2,'0');clockEl.textContent=p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());},1000);
 window.addEventListener('pagehide',()=>{clearInterval(timer);clearInterval(guard);clearInterval(clock);standbyTone(false);client.close();});
 client.connect();
})();
