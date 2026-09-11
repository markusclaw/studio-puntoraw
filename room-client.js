/* Shared protocol client. Credentials stay in sessionStorage and WebSocket messages. */
(function(){
  const LOCAL=/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  window.RAW_WORKER_URL=LOCAL?(sessionStorage.getItem('raw.dev.worker')||'ws://127.0.0.1:8787'):'wss://raw-studio-host.rovelo-ga.workers.dev';
  window.rawSession=function(room){
    const key='raw.session.v2.'+room;
    let s; try{s=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    if(!s) {s={id:crypto.randomUUID(),token:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(s));}
    return s;
  };
  window.RawRoomClient=class extends EventTarget {
    constructor(room,identity){super();this.room=room;this.identity=identity;this.socket=null;this.snapshot=null;this.joined=false;this.stopped=true;this.delay=500;this.leaseUntil=0;this.timer=null;this.retry=null;}
    emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
    connect(){
      this.stopped=false;clearTimeout(this.retry);
      const ws=new WebSocket(window.RAW_WORKER_URL+'/room/'+encodeURIComponent(this.room));this.socket=ws;
      const timeout=setTimeout(()=>{if(!this.joined) ws.close();},10000);
      ws.addEventListener('message',e=>{
        if(ws!==this.socket)return;let m;try{m=JSON.parse(e.data);}catch{return;}
        if(m.type==='hello') {if(m.protocol!==2)return this.fail('Studio needs the matching room-service update.');ws.send(JSON.stringify({type:'join',...this.identity}));}
        else if(m.type==='joined'){this.joined=true;this.member=m.member;this.delay=500;clearTimeout(timeout);this.emit('joined',m.member);this.ping();clearInterval(this.timer);this.timer=setInterval(()=>this.ping(),5000);}
        else if(m.type==='state'){
          if(m.protocol!==2)return this.fail('Studio needs the matching room-service update.');
          this.snapshot=m;this.leaseUntil=Date.now()+Math.max(0,(m.badge.expiresAt||0)-m.serverTime);this.emit('state',m);
        } else if(m.type==='pong') {this.leaseUntil=Date.now()+Math.max(0,(m.expiresAt||0)-m.serverTime);this.lastPong=Date.now();}
        else if(m.type==='replaced')this.fail('This seat was opened in another tab. This tab has stopped publishing.');
        else if(m.type==='error'){if(!this.joined)this.fail(m.message);else this.emit('error',m);}
      });
      ws.addEventListener('close',()=>{clearTimeout(timeout);if(ws!==this.socket)return;this.joined=false;this.leaseUntil=0;clearInterval(this.timer);this.emit('offline');if(!this.stopped){this.retry=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(this.delay*2,8000);}});
      ws.addEventListener('error',()=>ws.close());
    }
    ping(){if(this.lastPong && Date.now()-this.lastPong>15000){this.lastPong=0;this.socket?.close();return;}this.send({type:'ping'});if(!this.lastPong)this.lastPong=Date.now();}
    canControl(){return this.joined && Date.now()<this.leaseUntil && this.snapshot?.badge.hostId===this.identity.id && this.member?.role==='crew' && this.member?.ready;}
    send(message){if(this.socket?.readyState!==WebSocket.OPEN)return false;this.socket.send(JSON.stringify({...message,term:this.snapshot?.badge.term}));return true;}
    fail(message){this.stopped=true;this.joined=false;this.leaseUntil=0;clearTimeout(this.retry);clearInterval(this.timer);this.socket?.close();this.emit('fatal',message);}
    close(leave=false){if(leave)this.send({type:'leave'});this.stopped=true;this.joined=false;this.leaseUntil=0;clearTimeout(this.retry);clearInterval(this.timer);this.socket?.close();}
  };
})();
