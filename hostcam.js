/* Publishing is tied to the server-confirmed seat, never a label or saved name. */
(function(){
  let frame=null,wanted=sessionStorage.getItem('raw.host.autopub')==='1',member=null,state='off';   // state: 'off' | 'connecting' | 'live' (audit 4.5)
  // LIVE-RUN #1 (fable §1/§3): this publisher iframe is also the hosts' conversation channel — it
  // RECEIVES every other host's audio and plays it. So it owns three self-controls, all via VDO's
  // publisher iframe API (docs.vdo.ninja iframe-api-basics; verified):
  //   {mic:false}    → mute what YOU send (self-mute; other hosts + OBS stop hearing you)
  //   {camera:false} → stop sending YOUR video (feed drops without tearing the iframe down)
  //   {mute:true}    → mute what YOU hear (the monitor; does not affect what you publish)
  // State is tracked optimistically (the command is reliably honoured on your own iframe, and VDO's
  // state-report event names are undocumented) and broadcast so the desk/cards/toolbar stay in sync.
  let micMuted=false,camOff=false,monMuted=sessionStorage.getItem('raw.host.monmute')==='1';
  function post(msg){try{frame&&frame.contentWindow&&frame.contentWindow.postMessage(msg,'https://vdo.ninja');}catch(e){}}
  function emitState(){try{window.dispatchEvent(new CustomEvent('raw-hostcam-state',{detail:{publishing:!!frame,micMuted,camOff,monMuted}}));}catch(e){}sync();}
  function setMic(on){if(!frame)return;post({mic:!!on});micMuted=!on;emitState();}
  function setCamera(on){if(!frame)return;post({camera:!!on});camOff=!on;emitState();}
  function setMonitor(muted){monMuted=!!muted;try{sessionStorage.setItem('raw.host.monmute',monMuted?'1':'0');}catch(e){}if(frame)post({mute:monMuted});emitState();}
  function toast(msg){try{window.rawToast&&window.rawToast(msg);}catch(e){}}
  function stop(explicit=true){if(frame){frame.remove();frame=null;}state='off';micMuted=false;camOff=false;if(explicit){wanted=false;sessionStorage.setItem('raw.host.autopub','0');}emitState();}
  // explicit=true means the operator clicked; only then do we toast why a start bailed, so the
  // silent auto-retry on every room-state event (wanted flag) never spams (audit 4.5).
  function start(explicit){
    wanted=true;sessionStorage.setItem('raw.host.autopub','1');
    const rs=window.RawHost?.state();
    if(!rs||!rs.connected){ if(explicit)toast('Not connected to the studio yet — one moment.'); return; }
    const s=window.RawHost?.snapshot(),me=s?.members.find(m=>m.id===rs.clientId);
    if(!me||me.role!=='crew'){ if(explicit)toast('Take a host seat first — only crew publish a camera into the program.'); return; }
    if(frame&&member?.streamID===me.streamID)return;
    stop(false);member=me;state='connecting';
    const st=window.studioApp?.state;
    // audit 2.3: cap what each host publishes (was up to 720x1280 @ ~4Mbps per peer, the freeze
    // cause on P2P). quality=1 → 720p, 30fps, 2.5Mbps ceiling. These only reduce; they never
    // disable the camera. (novideo — stop the publisher decoding OTHERS' video — is a separate,
    // riskier change tested on its own.)
    // audit 2.1: novideo tells this hidden publisher iframe NOT to download the other hosts' video
    // (it still sends our own camera, and audio stays so hosts hear each other). Removes ~2 video
    // decoders per host. TEST: verify our camera still appears on the others' stage after this.
    // LAG FIX (2026-09-25): the thumbnail/stage lag is P2P fan-out — each host was uploading their
    // camera separately to EVERY receiver (console director iframe + console preview + OBS ≈ 3
    // uploads/host), saturating the host's uplink → dropped frames everywhere. meshcast=video routes
    // the VIDEO through VDO's free relay: the host encodes+uploads ONCE, the relay fans it out to all
    // viewers (docs.vdo.ninja &meshcast). Video only — audio stays P2P so hosts hear each other with
    // the lowest latency. Adds a small relay hop of latency; falls back to P2P if the relay drops.
    // Viewer-side framerate caps were ruled out: VDO does not allow a viewer to request a lower fps
    // (&fps/&maxframerate are publisher-only), so the relay is the correct lever, not a tile param.
    const q=new URLSearchParams({room:st.room,webcam:'',push:me.streamID,label:me.name,cleanoutput:'',autostart:'',nosettings:'',quality:'1',maxframerate:'30',videobitrate:'2500',meshcast:'video',novideo:''});
    if(st.password)q.set('password',st.password);
    for(const [key,param] of [['cam','videodevice'],['mic','audiodevice']]){const v=sessionStorage.getItem('raw.host.'+key);if(v&&v!=='Default')q.set(param,v);}
    frame=document.createElement('iframe');frame.className='raw-hostcam-pub';frame.title='My camera and host conversation';frame.allow='camera; microphone; autoplay';frame.src='https://vdo.ninja/?'+q;document.body.appendChild(frame);sync();
  }
  let btn,micBtn,camBtn;
  // audit 4.5: the label reflects the real publish state, not merely that an iframe exists.
  function sync(){if(!btn)return;
    const label=state==='live'?'◉ Camera connected':state==='connecting'?'◉ Connecting…':'◉ Join camera';
    btn.textContent=label;btn.setAttribute('aria-pressed',String(state!=='off'));btn.dataset.state=state;
    // fable §3: the two self-controls sit next to "Camera connected", always available (never
    // gated by who holds control), disabled only when there is no live publisher to act on.
    if(micBtn){micBtn.disabled=!frame;micBtn.textContent=micMuted?'🔊 Unmute mic':'🎙 Mute mic';micBtn.dataset.active=micMuted?'off':'on';micBtn.setAttribute('aria-pressed',String(micMuted));}
    if(camBtn){camBtn.disabled=!frame;camBtn.textContent=camOff?'📷 Camera on':'🚫 Camera off';camBtn.dataset.active=camOff?'off':'on';camBtn.setAttribute('aria-pressed',String(camOff));}
  }
  // Only claim "connected" once VDO reports the publisher is actually up.
  window.addEventListener('message',e=>{
    if(e.origin!=='https://vdo.ninja'||!frame||e.source!==frame.contentWindow)return;
    if(['joined-room','video-created','view-connection','loaded','started'].includes(e.data?.action)){ if(state==='connecting'){state='live';micMuted=false;camOff=false;if(monMuted)post({mute:true});emitState();} }   // fable §1: re-apply the operator's monitor-mute preference to the fresh iframe
  });
  function ready(){
    btn=document.createElement('button');btn.type='button';btn.className='raw-bcast-btn raw-hostcam-btn';
    // audit 4.4: disconnecting your own camera mid-show is a show-breaker — confirm while live.
    btn.addEventListener('click',()=>{
      if(frame){
        const live=window.RawHost?.snapshot()?.program?.session?.live;
        if(live && !confirm('Disconnect YOUR camera while the session is live? Your feed will drop from the program.'))return;
        stop(true);
      } else start(true);
    });
    // Personal camera lives at the top of the Crew tab — it's "your feed", grouped with the other
    // participant controls rather than sitting in the program/broadcast toolbar. Stays available
    // even when someone else controls the show.
    // fable §3: self mic + camera controls, next to the connect button. They act on YOUR own
    // publisher directly (no controller/badge check), which is why Rafa's card mute did nothing
    // before — that path went through the director and required holding control.
    micBtn=document.createElement('button');micBtn.type='button';micBtn.className='raw-bcast-btn raw-selfcam__ctl';
    micBtn.addEventListener('click',()=>setMic(micMuted));   // if muted → turn on; else mute
    camBtn=document.createElement('button');camBtn.type='button';camBtn.className='raw-bcast-btn raw-selfcam__ctl';
    camBtn.addEventListener('click',()=>{
      const live=window.RawHost?.snapshot()?.program?.session?.live;
      if(!camOff && live && !confirm('Turn OFF your camera while the session is live? Your video drops from the program.'))return;   // audit 4.4 spirit: guard a show-visible action
      setCamera(camOff);
    });
    const card=document.createElement('div');card.className='raw-selfcam';
    const lbl=document.createElement('span');lbl.className='raw-selfcam__label';lbl.textContent='Your feed';
    card.append(lbl,btn,micBtn,camBtn);
    const panel=document.querySelector('.tab-panel[data-panel="sources"]');
    const head=panel&&panel.querySelector('.panel-heading--section');
    if(head&&head.parentNode){head.parentNode.insertBefore(card,head.nextSibling);}
    else if(panel){panel.appendChild(card);}
    else{document.querySelector('.program-toolbar')?.appendChild(btn);}
    sync();
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
  window.addEventListener('raw-room-state',()=>{if(wanted)start(false);});
  window.addEventListener('pagehide',()=>stop(false));
  window.rawHostCam={start,stop,toggle:()=>frame?stop():start(true),isPublishing:()=>!!frame,
    // fable §1/§3: self mic/camera + monitor, driven from the desk, the toolbar and the own card.
    setMic,setCamera,setMonitor,
    micMuted:()=>micMuted,camOff:()=>camOff,monitorMuted:()=>monMuted,
    streamID:()=>member?.streamID||null};
})();
