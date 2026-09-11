/* HOSTCAM (A1, v2) — remote-host camera → their own seat, reliably.

   Each host runs the director console AND is remote, so their own face never
   enters the room on its own (directors don't publish). The "Cam" toggle
   publishes the host's camera as a normal room participant.

   The identity link is the STREAM ID, not the label (VDO doesn't reliably carry
   &label into the director's state, which is why feeds used to land as random
   guests). We publish with a deterministic, seat-shaped id:

       push = seat_<seatkey>_cam        e.g.  seat_greg_cam

   app.js keys state.sources by that exact id, and the crew rail already treats
   any `seat_*` source as a host seat (pinned, no delete) — so a host's live feed
   self-classifies as their seat with zero guesswork. The reconcile below then
   drops the feed into the reserved seat's stage slot and the crew rail hides the
   now-redundant reserved placeholder (see the crew-rail block in index.html).

   Fully isolated: no app.js edits. Remove this one <script> tag to disable.
   Nothing publishes until the host clicks "Cam". */
(function(){
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var VDO='https://vdo.ninja/?';
    function LS(k){ try{return localStorage.getItem(k);}catch(e){return null;} }
    function ident(){ try{return JSON.parse(LS('raw.host.identity')||'null');}catch(e){return null;} }
    function app(){ return window.studioApp; }
    function st(){ var a=app(); return a&&a.state; }
    function room(){ var s=st(); return (s&&s.room) || (new URLSearchParams(location.search).get('room')) || 'default'; }
    function pass(){ var s=st(); return (s&&s.password) || ''; }
    function myName(){ var i=ident(); return (i&&i.name) ? String(i.name) : ''; }
    function norm(x){ return String(x||'').trim().toLowerCase(); }
    function slug(x){ return norm(x).replace(/[^a-z0-9]/g,''); }
    function seatKeyOf(id){ var m=/^seat_([a-z0-9]+)_/i.exec(id||''); return m?m[1].toLowerCase():''; }
    // My seat key + the deterministic id my camera will publish under.
    function mySeatKey(){ return slug(myName()) || 'host'; }
    function myPushId(){ return 'seat_'+mySeatKey()+'_cam'; }
    // window.RAW_SEAT_CAM lets the crew-rail block recognise the live-cam id shape.
    window.RAW_SEAT_CAM = function(id){ return /^seat_[a-z0-9]+_cam$/i.test(id||''); };

    /* ---------- publisher (my own camera into the room) ---------- */
    var pubWrap=document.createElement('div'); pubWrap.className='raw-hostcam-pub';
    document.body.appendChild(pubWrap);
    var pubFrame=null, publishing=false;

    function startPub(){
      if(publishing) return;
      var nm=myName()||'Host';
      var q='room='+encodeURIComponent(room())+'&webcam&push='+encodeURIComponent(myPushId())
          +'&label='+encodeURIComponent(nm)+'&cleanoutput&autostart&nosettings';
      if(pass()) q+='&password='+encodeURIComponent(pass());
      pubFrame=document.createElement('iframe');
      pubFrame.allow='camera; microphone; autoplay; display-capture';
      pubFrame.title='My camera';
      pubFrame.src=VDO+q;
      pubWrap.appendChild(pubFrame);
      publishing=true; syncBtn(); setTimeout(reconcile,600);
    }
    function stopPub(){
      if(!publishing) return;
      if(pubFrame){ try{ pubFrame.src='about:blank'; }catch(e){} pubFrame.remove(); pubFrame=null; }
      publishing=false; syncBtn(); setTimeout(reconcile,300);
    }
    function toggle(){ publishing?stopPub():startPub(); }

    /* ---------- "Cam" toggle in the program toolbar ---------- */
    var btn=null;
    var actions=document.querySelector('.program-toolbar__actions');
    if(actions){
      var grp=document.querySelector('.raw-bcast')||actions;
      btn=document.createElement('button'); btn.type='button';
      btn.className='raw-bcast-btn raw-hostcam-btn';
      btn.setAttribute('aria-pressed','false');
      btn.title='Publish my camera into the room';
      btn.textContent='◉ Cam';
      btn.addEventListener('click',toggle);
      grp.appendChild(btn);
    }
    function syncBtn(){
      if(!btn) return;
      btn.setAttribute('aria-pressed',String(publishing));
      btn.classList.toggle('on',publishing);
      btn.textContent = publishing ? '◉ On Air' : '◉ Cam';
    }

    /* ---------- seat binding: live cam feed → its reserved seat's slot ----------
       A reserved seat placeholder (streamID seat_<key>_<ts>) is "occupied" when a
       live source exists for the same key — either the deterministic cam id
       (seat_<key>_cam) or, as a fallback, a source whose label matches the seat.
       The occupant takes the seat's stage slot; the placeholder steps off stage.
       The crew rail hides the placeholder card so there's exactly one seat. */
    var origSlot={};
    function liveSources(){
      var s=st(), out=[]; if(s&&s.sources) s.sources.forEach(function(src){
        if(src && !src.placeholder && !src.disconnected && !src.queued) out.push(src);
      }); return out;
    }
    function assignedKey(id){ try{ return window.rawSeatmap ? window.rawSeatmap.keyOf(id) : ''; }catch(e){ return ''; } }
    function occupantFor(ph, live){
      var key=seatKeyOf(ph.streamID);
      for(var i=0;i<live.length;i++){ if(key && assignedKey(live[i].streamID)===key) return live[i]; } // manual assignment wins
      for(var i=0;i<live.length;i++){
        var src=live[i];
        if(key && seatKeyOf(src.streamID)===key) return src;            // deterministic cam id
        if(norm(src.label) && norm(src.label)===norm(ph.label) && norm(src.label)!==norm(src.streamID)) return src; // label (only if real)
      }
      return null;
    }
    var SEATSLOT={rj:1,greg:2,rafa:3};   // canonical stage order for the standing hosts
    function reconcile(){
      var s=st(); if(!s||!Array.isArray(s.placeholders)) return;
      var changed=false, live=liveSources();
      s.placeholders.forEach(function(ph){
        if(!ph || !ph.host) return;                          // host seats only
        var key=seatKeyOf(ph.streamID);
        if(origSlot[ph.streamID]==null) origSlot[ph.streamID]=(ph.slot||false);
        // Known hosts always take their canonical slot (self-heals corrupted /
        // stale slot values like "Slot 12" or "Manual"); others keep their own.
        var want = SEATSLOT[key] || origSlot[ph.streamID] || false, occ=occupantFor(ph, live);
        if(occ){
          if(occ.slot!==want){ occ.slot=want; changed=true; }   // face takes the seat's slot
          if(ph.slot!==false){ ph.slot=false; changed=true; }   // placeholder off stage
        } else {
          if(ph.slot!==want){ ph.slot=want; changed=true; }     // seat reserved (NO SIGNAL)
        }
      });
      if(changed){ try{ if(app().activateScene && s.activeSceneId) app().activateScene(s.activeSceneId); }catch(e){} }
    }
    var list=document.getElementById('source-list');
    if(list) new MutationObserver(reconcile).observe(list,{childList:true,subtree:true});
    var recTimer=setInterval(reconcile,2000);
    document.addEventListener('visibilitychange',function(){
      if(document.hidden){ clearInterval(recTimer); recTimer=0; }
      else if(!recTimer){ recTimer=setInterval(reconcile,2000); reconcile(); }
    });
    reconcile();

    window.rawHostCam={ toggle:toggle, start:startPub, stop:stopPub, isPublishing:function(){return publishing;},
                        seatKey:mySeatKey, pushId:myPushId };
  });
})();
