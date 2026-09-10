/* JUMP IN — avatar chooser that fronts the identity gate. Picking a crew seat
   fills name + crew code ("123") and submits the existing join form; Guest
   enters with no code (host.js routes guests to the greenroom preflight).
   Enhancement over app.js/host.js (drives their form, no core edits). */
(function(){
  var SEATS=[
    {key:'rj',   name:'RJ',   code:'123', img:'avatars/rj.jpg',   role:'Host · Audio'},
    {key:'greg', name:'Greg', code:'123', img:'avatars/greg.jpg', role:'Host'},
    {key:'rafa', name:'Rafa', code:'123', img:'avatars/rafa.jpg', role:'Host'},
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
    var chosen=false;

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

    function choose(s,t){
      if(s.guest){
        guestBox.hidden=false;
        ov.querySelectorAll('.ji-tile').forEach(function(x){x.classList.toggle('ji-tile--active', x===t);});
        var gi=ov.querySelector('.ji-guest-name'); try{gi.focus();}catch(e){}
        return;
      }
      submitJoin(s.name, s.code);
    }
    ov.querySelector('.ji-guest-go').addEventListener('click',function(){
      var v=(ov.querySelector('.ji-guest-name').value||'').trim()||'Guest'; submitJoin(v,'');
    });
    ov.querySelector('.ji-guest-name').addEventListener('keydown',function(e){
      if(e.key==='Enter'){ e.preventDefault(); var v=(e.target.value||'').trim()||'Guest'; submitJoin(v,''); }
    });

    function submitJoin(name, code){
      var f=document.querySelector('.raw-join-overlay form'); if(!f) return;
      var n=f.querySelector('.rj-name'), c=f.querySelector('.rj-code');
      if(n) n.value=name; if(c) c.value=code||'';
      if(typeof f.requestSubmit==='function') f.requestSubmit();
      else f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      chosen=true; ov.hidden=true;
      setTimeout(function(){ var g=document.querySelector('.raw-join-overlay'); if(g&&g.dataset.show==='true'){ chosen=false; ov.hidden=false; } }, 4000);
    }

    // Mirror the host identity gate: show Jump In while not joined, hide once joined.
    (function attach(){
      var g=document.querySelector('.raw-join-overlay');
      if(!g){ setTimeout(attach,150); return; }
      function apply(){ if(chosen){ ov.hidden=true; return; } var show=g.dataset.show==='true'; ov.hidden=!show; if(!show) guestBox.hidden=true; }
      apply();
      new MutationObserver(apply).observe(g,{attributes:true,attributeFilter:['data-show']});
    })();
  });
})();
