/* BROADCAST CONTROLS — animated .RAW logo bug (toggle), standby overlay wired
   to standby.html (emergency key + tone), and hotkeys. Enhancement over app.js. */
(function(){
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var stage=document.querySelector('.stage-aspect')||document.querySelector('.stage-shell');
    if(!stage) return;

    /* ---- logo bug — static .RAW / MASTER_SESSIONS lockup drawn directly in the
           stage (no iframe: stacking a full-bleed iframe over the VDO frame made
           the whole stage paint white in some browsers). The animated glitch
           version lives in rawoverlay.html as the OBS Browser Source. ---- */
    var logo=document.createElement('div'); logo.className='raw-logo-bug'; logo.hidden=true;
    logo.innerHTML='<span class="rlb-ep">03</span>'
      +'<span class="rlb-title">.RAW</span>'
      +'<span class="rlb-sub">MASTER_SESSIONS</span>';
    stage.appendChild(logo);
    var logoBtn=null;
    function toggleLogo(force){
      var show=(typeof force==='boolean')?force:logo.hidden;
      logo.hidden=!show;
      if(show){ logo.classList.remove('rlb-anim'); void logo.offsetWidth; logo.classList.add('rlb-anim'); }
      if(logoBtn) logoBtn.setAttribute('aria-pressed', String(!logo.hidden));
    }

    /* ---- standby overlay (iframe of standby.html) ---- */
    var standby=document.createElement('div'); standby.className='raw-standby-overlay'; standby.hidden=true;
    var sframe=document.createElement('iframe'); sframe.className='raw-standby-frame'; sframe.title='Standby';
    standby.appendChild(sframe);
    stage.appendChild(standby);
    var standbyBtn=null, actx=null;
    function tone(){
      try{
        actx=actx||new (window.AudioContext||window.webkitAudioContext)();
        if(actx.state==='suspended') actx.resume();
        var t=actx.currentTime;
        [880,620].forEach(function(f,i){
          var o=actx.createOscillator(), g=actx.createGain();
          o.type='sine'; o.frequency.value=f;
          var s=t+i*0.36;
          g.gain.setValueAtTime(0.0001,s);
          g.gain.exponentialRampToValueAtTime(0.28,s+0.02);
          g.gain.exponentialRampToValueAtTime(0.0001,s+0.32);
          o.connect(g).connect(actx.destination); o.start(s); o.stop(s+0.34);
        });
      }catch(e){}
    }
    function setStandby(force){
      var show=(typeof force==='boolean')?force:standby.hidden;
      if(show && standby.hidden){
        sframe.src='standby.html?msg=BE%20RIGHT%20BACK';
        standby.hidden=false; standby.classList.add('on'); tone();
      } else if(!show){
        standby.hidden=true; standby.classList.remove('on'); sframe.src='about:blank';
      }
      if(standbyBtn) standbyBtn.setAttribute('aria-pressed', String(!standby.hidden));
    }

    /* ---- toolbar buttons ---- */
    var actions=document.querySelector('.program-toolbar__actions');
    if(actions){
      var group=document.createElement('div'); group.className='raw-bcast';
      logoBtn=document.createElement('button'); logoBtn.type='button'; logoBtn.className='raw-bcast-btn';
      logoBtn.setAttribute('aria-pressed','false'); logoBtn.title='Toggle logo  (Cmd/Ctrl+Shift+L)'; logoBtn.textContent='Logo';
      logoBtn.addEventListener('click',function(){ toggleLogo(); });
      standbyBtn=document.createElement('button'); standbyBtn.type='button'; standbyBtn.className='raw-bcast-btn raw-bcast--warn';
      standbyBtn.setAttribute('aria-pressed','false'); standbyBtn.title='Cut to Standby  (Cmd/Ctrl+Shift+.)'; standbyBtn.textContent='Standby';
      standbyBtn.addEventListener('click',function(){ setStandby(); });
      group.appendChild(logoBtn); group.appendChild(standbyBtn);
      actions.appendChild(group);
    }

    /* ---- hotkeys ---- */
    function typingIn(el){
      if(!el) return false;
      if(el.isContentEditable) return true;
      var t=(el.tagName||'').toUpperCase();
      return t==='INPUT'||t==='TEXTAREA'||t==='SELECT';
    }
    document.addEventListener('keydown', function(e){
      var mod=e.metaKey||e.ctrlKey;
      if(!mod) return;
      // Don't hijack Cmd+Enter / Cmd+Shift+. / Cmd+Shift+L while the user is
      // typing (transcript notes, name/code fields, the room password, etc.).
      if(typingIn(e.target)||typingIn(document.activeElement)) return;
      // A3: only the host-badge holder drives go-live / standby / logo.
      if(window.rawCanControl&&!window.rawCanControl()) return;
      // Cmd/Ctrl+Enter -> Go Live / End session
      if(e.key==='Enter'){ var p=document.querySelector('.raw-primary'); if(p){ e.preventDefault(); p.click(); } return; }
      // Cmd/Ctrl+Shift+.  -> emergency cut to standby (+tone)
      if(e.shiftKey && (e.key==='.'||e.key==='>')){ e.preventDefault(); setStandby(); return; }
      // Cmd/Ctrl+Shift+L  -> toggle logo
      if(e.shiftKey && (e.key==='L'||e.key==='l')){ e.preventDefault(); toggleLogo(); return; }
    });

    window.rawBroadcast={toggleLogo:toggleLogo,setStandby:setStandby};
  });
})();
