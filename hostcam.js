/* HOSTCAM (A1) — remote-host camera → reserved seat.
   Each host runs the director console AND is remote, so their own face never
   enters the room (directors don't publish). This module adds a "Cam" toggle
   that publishes the host's camera as a normal room participant, tagged with a
   STABLE id (push=clientId) and their name (label). A reconcile step then binds
   any live feed whose label matches a reserved seat into that seat's stage slot
   — so the face lands in the right box with no duplicate placeholder.

   Fully isolated: no app.js edits. Remove this one <script> tag to disable.
   Nothing publishes until the host clicks "Cam". */
(function(){
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var VDO='https://vdo.ninja/?';
    function LS(k){ try{return localStorage.getItem(k);}catch(e){return null;} }
    function ident(){ try{return JSON.parse(LS('raw.host.identity')||'null');}catch(e){return null;} }
    function cid(){ return LS('raw.host.clientId') || ('host_'+Date.now()+'_'+Math.floor(Math.random()*1e6)); }
    function app(){ return window.studioApp; }
    function st(){ var a=app(); return a&&a.state; }
    function room(){ var s=st(); return (s&&s.room) || (new URLSearchParams(location.search).get('room')) || 'default'; }
    function pass(){ var s=st(); return (s&&s.password) || ''; }
    function myName(){ var i=ident(); return (i&&i.name) ? String(i.name) : ''; }
    function norm(x){ return String(x||'').trim().toLowerCase(); }

    /* ---------- publisher (my own camera into the room) ---------- */
    var pubWrap=document.createElement('div'); pubWrap.className='raw-hostcam-pub';
    document.body.appendChild(pubWrap);
    var pubFrame=null, publishing=false;

    function startPub(){
      if(publishing) return;
      var nm=myName()||'Host', id=cid();
      var q='room='+encodeURIComponent(room())+'&webcam&push='+encodeURIComponent(id)
          +'&label='+encodeURIComponent(nm)+'&cleanoutput&autostart&nosettings';
      if(pass()) q+='&password='+encodeURIComponent(pass());
      pubFrame=document.createElement('iframe');
      pubFrame.allow='camera; microphone; autoplay; display-capture';
      pubFrame.title='My camera';
      pubFrame.src=VDO+q;
      pubWrap.appendChild(pubFrame);
      publishing=true; syncBtn();
    }
    function stopPub(){
      if(!publishing) return;
      if(pubFrame){ try{ pubFrame.src='about:blank'; }catch(e){} pubFrame.remove(); pubFrame=null; }
      publishing=false; syncBtn();
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

    /* ---------- seat binding: live feed → matching reserved seat ---------- */
    var origSlot={};   // placeholder.streamID -> its reserved slot (to restore)
    function reconcile(){
      var s=st(); if(!s||!Array.isArray(s.placeholders)) return;
      var changed=false, live=[];
      if(s.sources) s.sources.forEach(function(src){
        if(src && !src.placeholder && !src.disconnected && !src.queued) live.push(src);
      });
      s.placeholders.forEach(function(ph){
        if(!ph || !ph.host) return;                          // host seats only
        if(origSlot[ph.streamID]==null) origSlot[ph.streamID]=(ph.slot||false);
        var want=origSlot[ph.streamID], match=null;
        for(var i=0;i<live.length;i++){ if(norm(live[i].label)===norm(ph.label)){ match=live[i]; break; } }
        if(match){
          // live face takes the seat's stage slot; the placeholder steps off stage.
          if(match.slot!==want){ match.slot=want; changed=true; }
          if(ph.slot!==false){ ph.slot=false; changed=true; }
        } else {
          // no face yet — seat holds its reserved slot (shows NO SIGNAL).
          if(ph.slot!==want){ ph.slot=want; changed=true; }
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

    window.rawHostCam={ toggle:toggle, start:startPub, stop:stopPub, isPublishing:function(){return publishing;} };
  });
})();
