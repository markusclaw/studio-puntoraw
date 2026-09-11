/* Buttons reflect acknowledged room state, including the OBS program renderer. */
(function(){
 function ready(){
   const actions=document.querySelector('.program-toolbar__actions');if(!actions)return;
   const group=document.createElement('div');group.className='raw-bcast';let snapshot=null;
   function send(change){if(window.rawCanControl())window.RawHost.send({type:'broadcast',...change});}
   function button(text,fn){const b=document.createElement('button');b.type='button';b.className='raw-bcast-btn';b.textContent=text;b.addEventListener('click',fn);group.appendChild(b);return b;}
   const logo=button('Logo',()=>send({logo:!snapshot?.program.logo}));
   const standby=button('Standby',()=>send({standby:!snapshot?.program.standby}));
   const session=button('Start session',()=>{if(snapshot?.program.session.live&&!confirm('End the Studio session? Stop recording and streaming separately in OBS.'))return;send({live:!snapshot?.program.session.live});});
   session.title='Session timer only. Start and stop the recording or stream in OBS.';
   const status=document.createElement('span');status.className='raw-desk__hint';group.appendChild(status);actions.appendChild(group);
   function render(){const can=window.rawCanControl();[logo,standby,session].forEach(b=>b.disabled=!can);if(!snapshot)return;logo.setAttribute('aria-pressed',String(snapshot.program.logo));standby.setAttribute('aria-pressed',String(snapshot.program.standby));session.textContent=snapshot.program.session.live?'End session':'Start session';status.textContent=snapshot.program.session.live?Math.floor((Date.now()-snapshot.program.session.startedAt)/60000)+' min · Record in OBS':'Recording: use OBS';}
   window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});setInterval(render,1000);render();
   window.rawBroadcast={toggleLogo:force=>send({logo:typeof force==='boolean'?force:!snapshot?.program.logo}),setStandby:force=>send({standby:typeof force==='boolean'?force:!snapshot?.program.standby})};
   document.addEventListener('keydown',e=>{if(!(e.metaKey||e.ctrlKey)||e.target.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.shiftKey&&(e.key==='.'||e.key==='>')){e.preventDefault();window.rawBroadcast.setStandby();}});
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
