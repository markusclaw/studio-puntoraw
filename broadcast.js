/* Buttons reflect acknowledged room state, including the OBS program renderer. */
(function(){
 function ready(){
   const actions=document.querySelector('.program-toolbar__actions');if(!actions)return;
   const group=document.createElement('div');group.className='raw-bcast';let snapshot=null;
   function send(change){if(window.rawCanControl())window.RawHost.send({type:'broadcast',...change});}
   function button(text,fn){const b=document.createElement('button');b.type='button';b.className='raw-bcast-btn';b.textContent=text;b.addEventListener('click',fn);group.appendChild(b);return b;}
   const logo=button('Logo',()=>send({logo:!snapshot?.program.logo}));
   const standby=button('Standby',()=>send({standby:!snapshot?.program.standby}));
   standby.classList.add('raw-bcast--warn');standby.title='Standby — cut the program to the branded hold screen (⌘⇧.)';   // audit 4.3: Standby is a show-breaker; make it read as one and surface the shortcut
   const session=button('Start session',()=>{if(snapshot?.program.session.live&&!confirm('End the Studio session? Stop recording and streaming separately in OBS.'))return;send({live:!snapshot?.program.session.live});});
   session.title='Session timer only. Start and stop the recording or stream in OBS.';
   // feature: wrap — the practical "we're done" button. One message: program to standby, timer off,
   // wrapped flag on; every console then shows the That's-a-wrap card (wrap.js) with Leave studio.
   const wrap=button('Wrap',()=>{
     if(snapshot?.program.wrapped){send({wrapped:false,standby:false});return;}
     if(!confirm("Wrap the session? The program goes to standby and every console gets a Leave prompt. Stop the recording in OBS."))return;
     send({wrapped:true,standby:true,live:false});
   });
   wrap.classList.add('raw-bcast--wrap');wrap.title="That's a wrap — hold the program and prompt everyone to leave";
   const status=document.createElement('span');status.className='raw-desk__hint';group.appendChild(status);actions.appendChild(group);
   function fmt(ms){const s=Math.max(0,Math.floor(ms/1000)),p=n=>String(n).padStart(2,'0');return p(Math.floor(s/3600))+':'+p(Math.floor(s%3600/60))+':'+p(s%60);}
   function render(){const can=window.rawCanControl();[logo,standby,session,wrap].forEach(b=>b.disabled=!can);if(!snapshot)return;logo.setAttribute('aria-pressed',String(snapshot.program.logo));standby.setAttribute('aria-pressed',String(snapshot.program.standby));wrap.setAttribute('aria-pressed',String(!!snapshot.program.wrapped));wrap.textContent=snapshot.program.wrapped?'Reopen':'Wrap';session.textContent=snapshot.program.session.live?'End session':'Start session';status.textContent=snapshot.program.session.live?fmt(Date.now()-snapshot.program.session.startedAt)+' · Record in OBS':'Recording: use OBS';}
   window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});setInterval(render,1000);render();
   window.rawBroadcast={toggleLogo:force=>send({logo:typeof force==='boolean'?force:!snapshot?.program.logo}),setStandby:force=>send({standby:typeof force==='boolean'?force:!snapshot?.program.standby})};
   document.addEventListener('keydown',e=>{if(!(e.metaKey||e.ctrlKey)||e.target.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.shiftKey&&(e.key==='.'||e.key==='>')){e.preventDefault();window.rawBroadcast.setStandby();}});
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
