/* JUMP IN — avatar chooser that fronts the identity gate. Picking a crew seat
   routes to the greenroom where the host enters their private code; Guest
   enters with no code (host.js routes guests to the greenroom preflight).
   Enhancement over app.js/host.js (drives their form, no core edits). */
(function(){
  var SEATS=[
    {key:'rj',   name:'RJ',   code:'', img:'avatars/rj.jpg',   role:'Host · Audio'},
    {key:'greg', name:'Greg', code:'', img:'avatars/greg.jpg', role:'Host'},
    {key:'rafa', name:'Rafa', code:'', img:'avatars/rafa.jpg', role:'Host'},
    {key:'guest',name:'',     code:'',    img:'avatars/guest.jpg', role:'Guest', guest:true}
  ];
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var ov=document.createElement('div'); ov.className='raw-jumpin'; ov.hidden=true;
    ov.innerHTML='<div class="ji-card">'
      +'<div class="ji-head"><span class="ji-dot"></span><span class="ji-brand"><b>.RAW</b> SESSIONS</span></div>'
      +'<div class="ji-title">Choose your seat</div>'
      +'<div class="ji-tiles"></div>'
      +'<div class="ji-guest" hidden><input class="ji-guest-name" type="text" maxlength="40" placeholder="Your name" autocomplete="off"><button type="button" class="ji-guest-go">Enter as guest</button></div>'
      +'<div class="ji-foot">Crew hold the desk. Guests join and wait to be brought on.</div>'
      +'</div>';
    document.body.appendChild(ov);
    var chosen=false, chosenAt=0;   // chosenAt: when we last submitted a join

    var tiles=ov.querySelector('.ji-tiles'), guestBox=ov.querySelector('.ji-guest');
    SEATS.forEach(function(s){
      var t=document.createElement('button'); t.type='button';
      t.className='ji-tile'+(s.guest?' ji-tile--guest':''); t.dataset.key=s.key;
      t.innerHTML='<span class="ji-av" style="background-image:url('+s.img+')"></span>'
        +'<span class="ji-name">'+(s.name||'Guest')+'</span>'
        +'<span class="ji-role">'+s.role+'</span>';
      t.addEventListener('click',function(){ choose(s,t); });
      tiles.appendChild(t);
    });

    function roomOf(){ try{ if(window.studioApp&&window.studioApp.state&&window.studioApp.state.room) return window.studioApp.state.room; }catch(e){}
      var p=new URLSearchParams(location.search); return p.get('room')||p.get('r')||p.get('director')||p.get('dir')||'master_sessions_raw'; }
    function passOf(){ try{ if(window.studioApp&&window.studioApp.state&&window.studioApp.state.password) return window.studioApp.state.password; }catch(e){}
      var p=new URLSearchParams(location.search); return p.get('password')||p.get('pass')||p.get('pw')||''; }
    function choose(s,t){
      if(s.guest){
        guestBox.hidden=false;
        ov.querySelectorAll('.ji-tile').forEach(function(x){x.classList.toggle('ji-tile--active', x===t);});
        var gi=ov.querySelector('.ji-guest-name'); try{gi.focus();}catch(e){}
        return;
      }
      // Host → greenroom first (confirm camera + mic); the greenroom then sends
      // them into the console, where their camera activates their fixed seat box.
      var q='crew=1&seat='+encodeURIComponent(s.key)+'&name='+encodeURIComponent(s.name)+'&room='+encodeURIComponent(roomOf());
      var pw=passOf(); if(pw) q+='&password='+encodeURIComponent(pw);
      location.href='greenroom.html?'+q;
    }
    ov.querySelector('.ji-guest-go').addEventListener('click',function(){
      var v=(ov.querySelector('.ji-guest-name').value||'').trim()||'Guest'; submitJoin(v,'');
    });
    ov.querySelector('.ji-guest-name').addEventListener('keydown',function(e){
      if(e.key==='Enter'){ e.preventDefault(); var v=(e.target.value||'').trim()||'Guest'; submitJoin(v,''); }
    });

    function submitJoin(name){
      var q=new URLSearchParams({room:roomOf(),name:name});var pw=passOf();if(pw)q.set('password',pw);
      location.href='greenroom.html?'+q;
    }

    // Mirror the host identity gate: show Jump In while not joined, hide once joined.
    (function attach(){
      var g=document.querySelector('.raw-join-overlay');
      if(!g){ setTimeout(attach,150); return; }
      function apply(){
        // Coming back from the greenroom we auto-join — don't flash the chooser.
        if(window.__rawAutoEntering){ ov.hidden=true; return; }
        var show=g.dataset.show==='true';
        // M4: if the gate is shown again well after our submit, the user has
        // left (or the join failed) — clear `chosen` so the chooser is the
        // entry point again. Within 4s of submit we keep it set to avoid the
        // post-join flicker.
        if(show && (!chosen || Date.now()-chosenAt>4000)) chosen=false;
        if(chosen){ ov.hidden=true; return; }
        ov.hidden=!show; if(!show) guestBox.hidden=true;
      }
      apply();
      new MutationObserver(apply).observe(g,{attributes:true,attributeFilter:['data-show']});
    })();
  });
})();
