/* That's-a-wrap card. When the controller presses Wrap (broadcast.js → program.wrapped), every
   seated console — crew and admitted guests — gets one clear way out: a card over the stage with
   LEAVE STUDIO (RawHost.leave: stops the camera, releases the seat + badge, clears the saved
   identity so the next load shows the chooser) and STAY (dismiss until the next wrap). The tiny
   "⎋ Leave" in the top bar still works; this is the practical path after the goodbyes.
   Same pattern as desk.js/episode.js: read the snapshot on raw-room-state, act through RawHost. */
(function(){
  function ready(){
    const css=document.createElement('style');
    css.textContent=`
      .raw-wrap{position:fixed;inset:0;z-index:9990;display:none;align-items:center;justify-content:center;
        background:rgba(8,7,6,.66);backdrop-filter:blur(3px);font-family:var(--mono,SFMono-Regular,Menlo,monospace)}
      .raw-wrap[data-show="true"]{display:flex}
      .raw-wrap__card{width:min(440px,calc(100vw - 32px));background:rgba(20,19,18,.98);border:1px solid rgba(198,118,59,.45);
        border-radius:14px;padding:26px 26px 22px;box-shadow:0 30px 80px rgba(0,0,0,.6);text-align:center}
      .raw-wrap__eyebrow{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--bronze,#C6763B)}
      .raw-wrap__title{margin:10px 0 6px;font-size:26px;letter-spacing:.04em;color:var(--offwhite,#E6DFD2)}
      .raw-wrap__sub{font-size:12px;color:var(--smoke,#948B7E);min-height:1.2em}
      .raw-wrap__meta{margin-top:14px;font-size:11px;letter-spacing:.08em;color:var(--smoke,#948B7E)}
      .raw-wrap__actions{display:flex;gap:10px;justify-content:center;margin-top:22px}
      .raw-wrap__actions button{font-family:inherit;font-size:12px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;
        border-radius:8px;padding:11px 18px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#ECE7DD}
      .raw-wrap__actions button:hover{background:rgba(255,255,255,.08)}
      .raw-wrap__actions .raw-wrap__leave{background:var(--bronze,#C6763B);border-color:var(--bronze,#C6763B);color:#1a120b;font-weight:700}
      .raw-wrap__actions .raw-wrap__leave:hover{filter:brightness(1.08)}
      .raw-wrap__hint{margin-top:14px;font-size:10px;color:var(--soft,#857d71);letter-spacing:.06em}
    `;
    document.head.appendChild(css);

    const el=document.createElement('div');
    el.className='raw-wrap';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label',"That's a wrap");
    el.innerHTML=`
      <div class="raw-wrap__card">
        <div class="raw-wrap__eyebrow">.RAW Sessions</div>
        <div class="raw-wrap__title">That's a wrap</div>
        <div class="raw-wrap__sub"></div>
        <div class="raw-wrap__meta"></div>
        <div class="raw-wrap__actions">
          <button type="button" class="raw-wrap__stay">Stay</button>
          <button type="button" class="raw-wrap__leave">Leave studio</button>
        </div>
        <div class="raw-wrap__hint">Leaving stops your camera and frees your seat. Recording stops in OBS.</div>
      </div>`;
    document.body.appendChild(el);
    const sub=el.querySelector('.raw-wrap__sub'),meta=el.querySelector('.raw-wrap__meta');

    let snapshot=null,dismissed=false,wasWrapped=false;

    function seated(){
      const st=window.RawHost&&window.RawHost.state&&window.RawHost.state();
      if(!st||!st.name)return false;                       // not joined (chooser / observer) — nothing to leave
      if(st.role==='crew')return true;
      const me=(st.members||[]).find(m=>m.id===st.clientId);
      return !!(me&&me.role==='guest'&&me.admitted);       // a waiting/denied guest has no seat to release
    }
    function render(){
      const p=snapshot&&snapshot.program;
      const wrapped=!!(p&&p.wrapped);
      if(wrapped&&!wasWrapped)dismissed=false;             // a new wrap re-prompts anyone who chose Stay last time
      wasWrapped=wrapped;
      const show=wrapped&&!dismissed&&seated();
      el.dataset.show=show?'true':'false';
      if(!show)return;
      const ep=(p&&p.episode)||{};
      const bits=[ep.season&&('S'+ep.season),ep.number&&('E'+ep.number),ep.title].filter(Boolean);
      meta.textContent=bits.join(' · ');
      const can=!!(window.rawCanControl&&window.rawCanControl());
      sub.textContent=can?'You wrapped the session. Reopen from the toolbar if that was early.':'The controller wrapped the session. Thanks for the show.';
    }
    el.querySelector('.raw-wrap__stay').addEventListener('click',()=>{dismissed=true;render();});
    el.querySelector('.raw-wrap__leave').addEventListener('click',()=>{
      dismissed=true;el.dataset.show='false';
      if(window.RawHost&&typeof window.RawHost.leave==='function')window.RawHost.leave();
      if(window.rawToast)window.rawToast('You left the studio');
    });
    window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});
    render();
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
