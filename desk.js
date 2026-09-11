/* Exactly one strip per canonical host seat, plus admitted guests. */
(function(){
 function ready(){
   const panel=document.querySelector('.program-panel'),stage=panel?.querySelector('.stage-shell');if(!stage)return;
   const desk=document.createElement('section');desk.className='raw-desk';desk.innerHTML='<div class="raw-desk__head"><span class="raw-desk__title">CONTROL DESK</span><span class="raw-desk__hint">Program levels · OBS shared feed</span></div><div class="raw-desk__rack"></div>';stage.after(desk);
   const rack=desk.querySelector('.raw-desk__rack');let sig='',snapshot=null;
   // Approx program VU: peak input level across unmuted contributing channels (not a measured output tap).
   function programLevel(){if(!snapshot||snapshot.program.masterMuted)return 0;let peak=0;for(const m of (snapshot.members||[])){if(m.role!=='crew'&&!m.admitted)continue;const mx=snapshot.program.mix[String(m.slot)];if(mx&&mx.muted)continue;const s=window.studioApp?.state.sources.get(m.streamID);if(s&&!s.disconnected)peak=Math.max(peak,s.loudness||0);}return Math.min(100,peak);}
   function channels(){return [{slot:1,name:'RJ'},{slot:2,name:'Greg'},{slot:3,name:'Rafa'},...(snapshot?.members||[]).filter(m=>m.role==='guest'&&m.admitted).map(m=>({slot:m.slot,name:m.name})),{slot:'master',name:'MASTER'}];}
   function send(slot,change){if(window.rawCanControl())window.RawHost.send({type:'mix',slot,...change});}
   function render(){
     const chs=channels(),next=JSON.stringify(chs);
     if(sig!==next){sig=next;rack.replaceChildren();for(const ch of chs){
       const strip=document.createElement('div');strip.className='raw-strip'+(ch.slot==='master'?' raw-strip--master':'');strip.dataset.slot=ch.slot;
       const name=document.createElement('div');name.className='raw-strip__name';name.textContent=ch.name;
       strip.innerHTML='<div class="raw-strip__body"><input type="range" class="raw-fader" min="0" max="100" value="100" orient="vertical"><div class="raw-vu"><span class="raw-vu__fill"></span></div></div><div class="raw-strip__btns"><button type="button" class="raw-mbtn">MUTE</button></div><div class="raw-strip__state"></div>';
       strip.prepend(name);const f=strip.querySelector('input');f.setAttribute('aria-label',ch.name+' program level');
       let debounce;f.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>send(ch.slot,{gain:+f.value}),80);});
       strip.querySelector('button').addEventListener('click',()=>send(ch.slot,{muted:ch.slot==='master'?!snapshot.program.masterMuted:!snapshot.program.mix[ch.slot]?.muted}));rack.appendChild(strip);
     }}
     if(!snapshot)return;
     const can=window.rawCanControl();for(const strip of rack.children){const slot=strip.dataset.slot,master=slot==='master',mix=master?{gain:snapshot.program.master,muted:snapshot.program.masterMuted}:(snapshot.program.mix[slot]||{gain:100,muted:false});
       const f=strip.querySelector('input');if(document.activeElement!==f)f.value=mix.gain;f.disabled=!can;const b=strip.querySelector('button');b.disabled=!can;b.classList.toggle('on',mix.muted);b.setAttribute('aria-pressed',String(mix.muted));
       const member=snapshot.members.find(m=>m.slot===+slot),src=member&&window.studioApp?.state.sources.get(member.streamID);
       strip.querySelector('.raw-strip__state').textContent=master?'Program':mix.muted?'Program muted':src&&!src.disconnected?'Connected':'Waiting for media';
       strip.querySelector('.raw-vu__fill').style.height=(master?programLevel():Math.min(100,src?.loudness||0))+'%';
     }
   }
   window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});
   setInterval(render,1000);render();
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
