/* CONTROL DESK — audio channel-strip mixer for the controller (RJ).
   One strip per crew member (live feed preferred, else the reserved seat) + Master.
   Mute / solo / meters are wired to the live session; faders post best-effort
   volume to VDO.Ninja. Enhancement over app.js (no core edits). */
(function(){
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var program=document.querySelector('.program-panel'); if(!program) return;
    var stageShell=program.querySelector('.stage-shell')||program;
    var desk=document.createElement('section'); desk.className='raw-desk'; desk.setAttribute('aria-label','Control desk');
    desk.innerHTML='<div class="raw-desk__head"><span class="raw-desk__title">CONTROL DESK</span>'
      +'<span class="raw-desk__hint">audio &middot; level / mute / solo</span></div>'
      +'<div class="raw-desk__rack" id="raw-desk-rack"></div>';
    if(stageShell.parentNode){ stageShell.parentNode.insertBefore(desk, stageShell.nextSibling); }
    var rack=desk.querySelector('#raw-desk-rack');

    var solo={}, faders={}, lastSig='', soloSnapshot=null;
    function app(){ return window.studioApp; }
    function state(){ var a=app(); return a&&a.state; }
    function esc(x){ return String(x||'').replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
    function frameWin(){ var f=document.getElementById('director-frame'); return f&&f.contentWindow; }
    function sendVolume(id,val){ var w=frameWin(); if(!w||!id)return; try{ w.postMessage({target:id, volume:Math.round(val)}, '*'); }catch(e){} }

    function liveList(){ var st=state(),a=[]; if(st&&st.sources) st.sources.forEach(function(s){ if(s&&!s.disconnected&&!s.queued&&!s.placeholder) a.push(s); }); return a; }
    function seatList(){ var st=state(); return st?(st.placeholders||[]).filter(function(p){return !p.sample;}):[]; }
    function channels(){
      var byName={}, order=[];
      seatList().forEach(function(p){ var k=(p.label||'').toLowerCase(); if(k&&!byName[k]){ byName[k]={name:p.label,live:null,slot:p.slot||90}; order.push(k);} });
      liveList().forEach(function(s){
        var lbl=(s.label||'').toLowerCase();
        // Attach to a matching named seat only if that seat has no live feed yet.
        if(lbl && byName[lbl] && !byName[lbl].live){ byName[lbl].live=s; return; }
        // Otherwise give each feed its OWN strip keyed by streamID, so two guests
        // sharing a name (e.g. both "Guest") don't collapse into one channel.
        var k='id:'+(s.streamID||lbl||order.length);
        if(!byName[k]){ byName[k]={name:s.label||'Guest',live:s,slot:s.slot||50}; order.push(k); }
        else { byName[k].live=s; }
      });
      return order.map(function(k){return byName[k];}).sort(function(a,b){return (a.slot||90)-(b.slot||90);});
    }

    function setMute(id,want){ var a=app(),st=state(); if(!a||!st)return; var s=st.sources.get(id); if(!s)return; if(!!s.muted!==!!want) a.toggleSourceControl(id,'mic'); }
    function reconcileSolo(){
      var any=Object.keys(solo).some(function(k){return solo[k];});
      if(any){
        // Remember each channel's mute state the moment solo first engages.
        if(!soloSnapshot){ soloSnapshot={}; liveList().forEach(function(s){ soloSnapshot[s.streamID]=!!s.muted; }); }
        liveList().forEach(function(s){ setMute(s.streamID, !solo[s.streamID]); });
      } else {
        // Solo cleared: restore what was muted before, don't blanket-unmute.
        liveList().forEach(function(s){ setMute(s.streamID, soloSnapshot ? !!soloSnapshot[s.streamID] : false); });
        soloSnapshot=null;
      }
    }

    function build(chs){
      rack.innerHTML='';
      chs.forEach(function(ch){
        var live=ch.live, id=live&&live.streamID;
        var strip=document.createElement('div'); strip.className='raw-strip'; if(!live) strip.setAttribute('data-offline','true'); if(id) strip.dataset.sid=id;
        strip.innerHTML='<div class="raw-strip__name">'+esc(ch.name)+'</div>'
          +'<div class="raw-strip__body">'
          +'<input type="range" class="raw-fader" min="0" max="100" value="'+(faders[ch.name]!=null?faders[ch.name]:100)+'" orient="vertical"'+(live?'':' disabled')+'>'
          +'<div class="raw-vu"><span class="raw-vu__fill"></span></div></div>'
          +'<div class="raw-strip__btns">'
          +'<button type="button" class="raw-mbtn" data-act="mute"'+(live?'':' disabled')+'>M</button>'
          +'<button type="button" class="raw-sbtn" data-act="solo"'+(live?'':' disabled')+'>S</button></div>'
          +'<div class="raw-strip__state"></div>';
        var fader=strip.querySelector('.raw-fader');
        fader.addEventListener('input', function(){ faders[ch.name]=+fader.value; if(id) sendVolume(id,+fader.value); });
        var m=strip.querySelector('[data-act="mute"]'); if(m) m.addEventListener('click', function(){ if(id) app().toggleSourceControl(id,'mic'); });
        var so=strip.querySelector('[data-act="solo"]'); if(so) so.addEventListener('click', function(){ if(!id)return; solo[id]=!solo[id]; reconcileSolo(); });
        rack.appendChild(strip);
      });
      var master=document.createElement('div'); master.className='raw-strip raw-strip--master';
      master.innerHTML='<div class="raw-strip__name">MASTER</div>'
        +'<div class="raw-strip__body"><input type="range" class="raw-fader" min="0" max="100" value="'+(faders.__master!=null?faders.__master:100)+'" orient="vertical">'
        +'<div class="raw-vu raw-vu--master"><span class="raw-vu__fill"></span></div></div>'
        +'<div class="raw-strip__btns"><button type="button" class="raw-mbtn" data-act="mall">MUTE</button></div>'
        +'<div class="raw-strip__state">Program</div>';
      master.querySelector('.raw-fader').addEventListener('input', function(e){ faders.__master=+e.target.value; liveList().forEach(function(s){ sendVolume(s.streamID, Math.round((faders[s.label]!=null?faders[s.label]:100)*(+e.target.value)/100)); }); });
      master.querySelector('[data-act="mall"]').addEventListener('click', function(){ var any=liveList().some(function(s){return !s.muted;}); liveList().forEach(function(s){ setMute(s.streamID, any); }); });
      rack.appendChild(master);
    }

    function maybeBuild(){ var chs=channels(); var sig=chs.map(function(c){return c.name+':'+(c.live?c.live.streamID:'-');}).join('|'); if(sig!==lastSig){ lastSig=sig; build(chs); } }

    // live poll: meters + mute/solo/state (no rebuild, so faders aren't interrupted)
    function poll(){
      var st=state(); if(!st) return;
      rack.querySelectorAll('.raw-strip[data-sid]').forEach(function(strip){
        var s=st.sources.get(strip.dataset.sid);
        var vu=strip.querySelector('.raw-vu__fill'); if(vu) vu.style.height=Math.min(100,(s&&s.loudness)||0)+'%';
        var m=strip.querySelector('[data-act="mute"]'); if(m) m.classList.toggle('on', !!(s&&s.muted));
        var so=strip.querySelector('[data-act="solo"]'); if(so) so.classList.toggle('on', !!solo[strip.dataset.sid]);
        var stt=strip.querySelector('.raw-strip__state'); if(stt) stt.textContent = s?(s.muted?'Muted':'Live'):'Offline';
      });
      var mx=0; if(st.sources) st.sources.forEach(function(s){ if(!s.placeholder && (s.loudness||0)>mx) mx=s.loudness; });
      var mf=rack.querySelector('.raw-vu--master .raw-vu__fill'); if(mf) mf.style.height=Math.min(100,mx)+'%';
    }

    var list=document.getElementById('source-list');
    if(list) new MutationObserver(maybeBuild).observe(list,{childList:true,subtree:true});

    // F4: hold interval handles and pause them while the tab is hidden, so the
    // desk isn't burning a 200ms meter loop in the background all show long.
    var meterTimer=0, buildTimer=0;
    function startTimers(){ if(!meterTimer) meterTimer=setInterval(poll,200); if(!buildTimer) buildTimer=setInterval(maybeBuild,1500); }
    function stopTimers(){ if(meterTimer){ clearInterval(meterTimer); meterTimer=0; } if(buildTimer){ clearInterval(buildTimer); buildTimer=0; } }
    document.addEventListener('visibilitychange', function(){
      if(document.hidden){ stopTimers(); } else { startTimers(); maybeBuild(); }
    });
    startTimers();
    maybeBuild();

    if(list) list.addEventListener('click', function(e){ var card=e.target.closest('.source-card'); if(!card)return; var id=card.dataset.sourceId; rack.querySelectorAll('.raw-strip').forEach(function(s){ s.classList.toggle('raw-strip--focus', !!id && s.dataset.sid===id); }); });
  });
})();
