/* Exactly one strip per canonical host seat, plus admitted guests. */
(function(){
 function ready(){
   const panel=document.querySelector('.program-panel'),stage=panel?.querySelector('.stage-shell');if(!stage)return;
   const desk=document.createElement('section');desk.className='raw-desk';desk.innerHTML='<div class="raw-desk__head"><span class="raw-desk__title">CONTROL DESK</span><span class="raw-desk__hint">Program levels · OBS shared feed</span><button type="button" class="raw-desk__toggle" aria-label="Collapse the control desk">▾</button></div><div class="raw-desk__monitor"><span class="raw-desk__monlabel">MONITOR</span><button type="button" class="raw-monbtn">Hosts</button><span class="raw-desk__monhint">what you hear · not the program</span></div><div class="raw-desk__rack"></div>';stage.after(desk);
   const rack=desk.querySelector('.raw-desk__rack');let sig='',snapshot=null;
   // Collapsible desk: on compact/short laptops nest the mixer so the stage keeps the
   // height. Click the header to toggle; the choice is remembered per browser. Default
   // collapsed on compact screens unless the operator has set a preference.
   (function(){
     const head=desk.querySelector('.raw-desk__head'),tog=desk.querySelector('.raw-desk__toggle');
     const compact=window.matchMedia('(max-width:1440px), (max-height:860px)').matches;
     let saved=null; try{saved=localStorage.getItem('raw.ui.desk');}catch(e){}
     const set=c=>{desk.dataset.collapsed=c?'true':'false';tog.textContent=c?'▸':'▾';tog.setAttribute('aria-expanded',String(!c));};
     set(saved==null ? compact : saved==='1');
     head.style.cursor='pointer';
     head.addEventListener('click',()=>{const c=desk.dataset.collapsed!=='true';set(c);try{localStorage.setItem('raw.ui.desk',c?'1':'0');}catch(e){}});
   })();
   // fable §1: the MONITOR control — what YOU hear in your headphones (the hosts' conversation on the
   // hostcam iframe), separate from the PROGRAM mutes (what OBS sends). Not gated by who holds control;
   // it is a local, per-operator preference. Disabled until your camera/mic publisher is live, since
   // that iframe is the receive channel there is nothing to monitor without it.
   (function(){
     const mbtn=desk.querySelector('.raw-monbtn');if(!mbtn)return;
     function syncMon(){const hc=window.rawHostCam,pub=!!hc&&hc.isPublishing(),muted=!!hc&&hc.monitorMuted();
       mbtn.disabled=!pub;mbtn.textContent=muted?'Off':'Hosts';mbtn.dataset.state=muted?'off':'on';mbtn.setAttribute('aria-pressed',String(!muted));
       mbtn.title=pub?(muted?'You are NOT hearing the other hosts — click to listen':'You hear the other hosts — click to mute your monitor'):'Join your camera/mic first to monitor the other hosts';}
     mbtn.addEventListener('click',()=>{const hc=window.rawHostCam;if(!hc||!hc.isPublishing())return;hc.setMonitor(!hc.monitorMuted());});
     window.addEventListener('raw-hostcam-state',syncMon);
     syncMon();
   })();
   // Approx program VU: peak input level across unmuted contributing channels (not a measured output tap).
   function programLevel(){if(!snapshot||snapshot.program.masterMuted)return 0;let peak=0;for(const m of (snapshot.members||[])){if(m.role!=='crew'&&!m.admitted)continue;const mx=snapshot.program.mix[String(m.slot)];if(mx&&mx.muted)continue;const s=window.studioApp?.state.sources.get(m.streamID);if(s&&!s.disconnected)peak=Math.max(peak,s.loudness||0);}return Math.min(100,peak);}
   function channels(){return [{slot:1,name:'RJ'},{slot:2,name:'Greg'},{slot:3,name:'Rafa'},...(snapshot?.members||[]).filter(m=>m.role==='guest'&&m.admitted).map(m=>({slot:m.slot,name:m.name})),{slot:'master',name:'MASTER'}];}
   function send(slot,change){if(window.rawCanControl())window.RawHost.send({type:'mix',slot,...change});}
   function render(){
     const chs=channels(),next=JSON.stringify(chs);
     if(sig!==next){sig=next;rack.replaceChildren();for(const ch of chs){
       const strip=document.createElement('div');strip.className='raw-strip'+(ch.slot==='master'?' raw-strip--master':'');strip.dataset.slot=ch.slot;
       const name=document.createElement('div');name.className='raw-strip__name';name.textContent=ch.name;
       strip.innerHTML='<div class="raw-strip__body"><input type="range" class="raw-fader" min="0" max="100" value="100" orient="vertical"><div class="raw-vu"><span class="raw-vu__fill"></span></div></div><div class="raw-strip__btns"><button type="button" class="raw-mbtn" title="Mutes this channel in the OBS/program feed — not what you hear">PROGRAM</button></div><div class="raw-strip__state"></div>';   // fable §1: relabelled MUTE→PROGRAM so it is never confused with the MONITOR (what you hear)
       strip.prepend(name);const f=strip.querySelector('input');f.setAttribute('aria-label',ch.name+' program level');
       // audit 2.5: 150ms debounce while dragging (was 80ms → ~12 sends/s) plus a guaranteed
       // final send on release, so the room never storms yet always lands the released value.
       let debounce;f.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>send(ch.slot,{gain:+f.value}),150);});
       f.addEventListener('change',()=>{clearTimeout(debounce);send(ch.slot,{gain:+f.value});});
       strip.querySelector('button').addEventListener('click',()=>send(ch.slot,{muted:ch.slot==='master'?!snapshot.program.masterMuted:!snapshot.program.mix[ch.slot]?.muted}));rack.appendChild(strip);
     }}
     if(!snapshot)return;
     const can=window.rawCanControl();for(const strip of rack.children){const slot=strip.dataset.slot,master=slot==='master',mix=master?{gain:snapshot.program.master,muted:snapshot.program.masterMuted}:(snapshot.program.mix[slot]||{gain:100,muted:false});
       const f=strip.querySelector('input');if(document.activeElement!==f)f.value=mix.gain;f.disabled=!can;const b=strip.querySelector('button');b.disabled=!can;b.classList.toggle('on',mix.muted);b.setAttribute('aria-pressed',String(mix.muted));
       const member=snapshot.members.find(m=>m.slot===+slot),src=member&&window.studioApp?.state.sources.get(member.streamID);
       // audit 4.2: the strip shows the same canonical seat state as the card/tile/pill.
       const seat=window.RawSeat&&window.RawSeat.compute({present:!!member,reconnecting:src?.disconnected,cam:src?!src.videoMuted:false,live:!!(src&&!src.disconnected&&!src.videoMuted)});
       strip.querySelector('.raw-strip__state').textContent=master?'Program':mix.muted?'Muted':(seat?seat.short:(src&&!src.disconnected?'LIVE':'ABSENT'));
       strip.querySelector('.raw-vu__fill').style.height=(master?programLevel():Math.min(100,src?.loudness||0))+'%';
     }
   }
   window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});
   setInterval(render,1000);render();
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
