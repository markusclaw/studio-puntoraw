/* A read-only renderer shared by the console preview and OBS Browser Source. */
(function(){
 const p=new URLSearchParams(location.search),room=p.get('room')||'master_sessions_raw',monitor=p.has('monitor');
 const client=new RawRoomClient(room,{id:crypto.randomUUID(),token:crypto.randomUUID(),viewer:true});
 const container=document.getElementById('program'),standby=document.getElementById('standby'),message=document.getElementById('standby-message');
 const tiles=new Map();let snapshot=null,offline=true,solo=null;
 function volume(tile){
   if(!tile.frame||!snapshot)return;
   const mix=snapshot.program.mix[String(tile.slot)]||{gain:100,muted:false};
   const muted=monitor || offline || snapshot.program.standby || snapshot.program.masterMuted || mix.muted;
   const gain=muted?0:(mix.gain/100)*(snapshot.program.master/100);
   tile.frame.contentWindow?.postMessage({volume:gain},'https://vdo.ninja');
   tile.frame.contentWindow?.postMessage({mute:muted},'https://vdo.ninja');
 }
 function render(){
   if(!snapshot)return;
   const program=snapshot.program,scene=program.scenes.find(s=>s.id===program.activeSceneId),keep=new Set();
   document.body.style.background=program.brand.background;
   for(const box of scene?.layout||[]){
     const key=box.id;keep.add(key);let tile=tiles.get(key);
     if(!tile){const el=document.createElement('div');el.className='tile';const wait=document.createElement('div');wait.className='waiting';const name=document.createElement('div');name.className='name';el.append(wait,name);container.appendChild(el);tile={el,wait,name,frame:null,streamID:null};tiles.set(key,tile);}
     tile.slot=box.slot+1;
     Object.assign(tile.el.style,{left:box.x+'%',top:box.y+'%',width:box.w+'%',height:box.h+'%',zIndex:box.z,borderRadius:program.brand.radius+'px'});
     const member=snapshot.members.find(m=>m.slot===tile.slot&&(m.role==='crew'&&m.ready||m.role==='guest'&&m.admitted));
     tile.name.textContent=member?.name||(['RJ','Greg','Rafa'][box.slot])||box.label||'Guest';tile.name.hidden=!program.brand.labels;
     const streamID=member?.streamID||null;
     if(tile.streamID!==streamID){
       tile.frame?.remove();tile.frame=null;tile.streamID=streamID;
       if(streamID){const q=new URLSearchParams({view:streamID,cleanoutput:'',autostart:'',speakermute:'',transparent:'',cover:box.cover===false?'0':'1'});if(p.get('password'))q.set('password',p.get('password'));
         const f=document.createElement('iframe');f.title=tile.name.textContent;f.allow='autoplay';f.src='https://vdo.ninja/?'+q;tile.frame=f;f.addEventListener('load',()=>volume(tile));tile.el.insertBefore(f,tile.name);
       }
     }
     tile.wait.textContent=streamID?'CONNECTING MEDIA':'WAITING FOR '+tile.name.textContent.toUpperCase();
     volume(tile);
   }
   for(const [key,tile] of tiles)if(!keep.has(key)){tile.el.remove();tiles.delete(key);}
   standby.hidden=!offline&&!program.standby;message.textContent=offline?'Studio connection interrupted':'Be right back';document.getElementById('logo').hidden=!program.logo;
 }
 client.addEventListener('state',e=>{snapshot=e.detail;offline=false;render();});
 client.addEventListener('offline',()=>{offline=true;render();});
 client.addEventListener('fatal',e=>{offline=true;render();message.textContent=e.detail;});
 // Reapply on VDO readiness messages: iframe load can precede media initialization.
 window.addEventListener('message',e=>{if(e.origin!=='https://vdo.ninja')return;for(const tile of tiles.values())if(tile.frame?.contentWindow===e.source){if(['video-created','video-added','view-connection','loaded','joined-room'].includes(e.data?.action))volume(tile);}});
 const timer=setInterval(()=>{for(const tile of tiles.values())volume(tile);},2000);
 window.addEventListener('pagehide',()=>{clearInterval(timer);client.close();});
 client.connect();
})();
