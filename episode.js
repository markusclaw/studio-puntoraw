/* Session metadata bar (Season / Episode / Title). Reads the synced program.episode, lets the
   controller edit it (debounced), and reflects it to every console + the OBS output. Mirrors the
   desk.js/broadcast.js pattern: reads the snapshot on raw-room-state, sends via RawHost. */
(function(){
  function ready(){
    const season=document.getElementById('ep-season'),
          number=document.getElementById('ep-number'),
          title=document.getElementById('ep-title'),
          hint=document.getElementById('ep-hint');
    if(!season||!number||!title)return;
    const fields=[season,number,title];
    let snapshot=null;

    function current(){return {season:season.value,number:number.value,title:title.value};}
    function send(){
      if(!window.rawCanControl||!window.rawCanControl()){return;}
      const ok=window.RawHost.send({type:'episode',episode:current()});
      if(hint) hint.textContent = ok===false ? 'not sent — reconnecting' : 'saved';
      if(ok!==false){clearTimeout(send._t);send._t=setTimeout(()=>{if(hint)hint.textContent='';},1200);}
    }
    let debounce;
    fields.forEach(f=>{
      f.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(send,400);});
      f.addEventListener('change',()=>{clearTimeout(debounce);send();});
    });

    function render(){
      const can=!!(window.rawCanControl&&window.rawCanControl());
      const ep=(snapshot&&snapshot.program&&snapshot.program.episode)||{season:'',number:'',title:''};
      // don't clobber a field the operator is actively typing in
      for(const [f,v] of [[season,ep.season||''],[number,ep.number||''],[title,ep.title||'']]){
        if(document.activeElement!==f && f.value!==v) f.value=v;
        f.readOnly=!can; f.disabled=!can;
      }
    }
    window.addEventListener('raw-room-state',e=>{snapshot=e.detail;render();});
    render();
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready):ready();
})();
