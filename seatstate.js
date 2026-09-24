/* audit 4.2 — ONE canonical per-seat status vocabulary, shared by the console (source card, desk
   strip, connection pill) and the program renderer, so "no picture" reads identically everywhere.
   Pure and dependency-free; each caller derives the boolean inputs from whatever data it has.

   Inputs (all optional booleans):
     present       - a member/publisher is in the room for this seat/slot
     cam           - that member's camera is on (false = explicitly off)
     live          - video is actually flowing (frames advancing)
     reconnecting  - was live, now stalled / blipping

   Precedence: absent > reconnecting > live > no-cam > connecting. */
(function(){
  const S = {
    absent:       { key:'absent',       label:'ABSENT',            short:'ABSENT'  },
    connecting:   { key:'connecting',   label:'CONNECTING',        short:'CONN…'   },
    nocam:        { key:'nocam',        label:'IN ROOM · NO CAM',  short:'NO CAM'  },
    live:         { key:'live',         label:'LIVE',              short:'LIVE'    },
    reconnecting: { key:'reconnecting', label:'RECONNECTING',      short:'RECONN'  }
  };
  function compute(s){
    s = s || {};
    if (!s.present)      return S.absent;
    if (s.reconnecting)  return S.reconnecting;
    if (s.live)          return S.live;
    if (s.cam === false) return S.nocam;
    return S.connecting;
  }
  window.RawSeat = { states:S, compute };
})();
