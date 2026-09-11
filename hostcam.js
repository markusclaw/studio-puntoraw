/* Publishing is tied to the server-confirmed seat, never a label or saved name. */
(function(){
  let frame=null,wanted=sessionStorage.getItem('raw.host.autopub')==='1',member=null;
  function stop(explicit=true){if(frame){frame.remove();frame=null;}if(explicit){wanted=false;sessionStorage.setItem('raw.host.autopub','0');}sync();}
  function start(){
    wanted=true;sessionStorage.setItem('raw.host.autopub','1');
    const s=window.RawHost?.snapshot(),me=s?.members.find(m=>m.id===window.RawHost.state().clientId);
    if(!me||me.role!=='crew'||!window.RawHost.state().connected)return;
    if(frame&&member?.streamID===me.streamID)return;stop(false);member=me;
    const state=window.studioApp?.state;
    const q=new URLSearchParams({room:state.room,webcam:'',push:me.streamID,label:me.name,cleanoutput:'',autostart:'',nosettings:''});
    if(state.password)q.set('password',state.password);
    for(const [key,param] of [['cam','videodevice'],['mic','audiodevice']]){const v=sessionStorage.getItem('raw.host.'+key);if(v&&v!=='Default')q.set(param,v);}
    frame=document.createElement('iframe');frame.className='raw-hostcam-pub';frame.title='My camera and host conversation';frame.allow='camera; microphone; autoplay';frame.src='https://vdo.ninja/?'+q;document.body.appendChild(frame);sync();
  }
  let btn;
  function sync(){if(btn){btn.textContent=frame?'◉ Camera connected':'◉ Join camera';btn.setAttribute('aria-pressed',String(!!frame));}}
  function ready(){
    btn=document.createElement('button');btn.type='button';btn.className='raw-bcast-btn raw-hostcam-btn';btn.addEventListener('click',()=>frame?stop():start());
    // Personal camera stays available even when someone else controls the show.
    document.querySelector('.program-toolbar')?.appendChild(btn);sync();
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
  window.addEventListener('raw-room-state',()=>{if(wanted)start();});
  window.addEventListener('pagehide',()=>stop(false));
  window.rawHostCam={start,stop,toggle:()=>frame?stop():start(),isPublishing:()=>!!frame};
})();
