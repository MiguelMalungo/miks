/* ═══════════════════════════ MiKS engine ═══════════════════════════
   Shared by index.html (the self-mixing homepage) and tools/analyze.html
   (which runs the same beat detector over the catalogue so the grid the
   mixer plays to is the grid the tool wrote). No build step — everything
   hangs off window.MIKS.

   Layout:  BufferPlayer  sample-accurate playback on AudioBufferSourceNodes
            Deck          player + low shelf + gain, beat position, phase hold
            master()      the one chain everything is heard through
            detectBeats   BPM + beat-grid analysis (unchanged from the mixer)
            Mixer         two invisible decks; select() beat-matches and fades  */
(function(){
'use strict';
const MIKS=window.MIKS=window.MIKS||{};

/* ───────────────────────── audio context ───────────────────────── */
let AC=null;
function ctx(){
  if(!AC){ AC=new (window.AudioContext||window.webkitAudioContext)(); MIKS.log&&MIKS.log('ctx created · '+AC.state+' · '+AC.sampleRate+'Hz'); }
  if(AC.state!=='running')AC.resume().catch(e=>MIKS.log&&MIKS.log('resume failed: '+e.message));   /* 'suspended' or Safari's 'interrupted' */
  return AC;
}
/* seeks/starts are scheduled this far ahead so they land on an exact context
   time (start(0) would round to the next render quantum and skew the clock) */
const START_LEAD=0.005;
MIKS.ctx=ctx;
MIKS.hasCtx=()=>!!AC;
MIKS.ctxState=()=>AC?AC.state:'none';
MIKS.warn=msg=>console.warn(msg);          /* the page swaps in its toast */

/* ── iOS ──
   Web Audio only starts inside a user gesture, and the ringer switch mutes
   it unless the page holds a "playback" audio session. unlock() is called
   from the first tap: it claims the session (Safari 17+ has the Audio
   Session API; older iOS gets a looping silent <audio>, which has the same
   effect), creates and resumes the context, and plays one silent buffer.
   After that every tap re-resumes a context iOS may have interrupted. */
const IOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let _silent=null, _wantSilent=true;
function claimSession(){
  if(navigator.audioSession){ try{navigator.audioSession.type='playback';}catch(e){} }
  if(!IOS)return;
  /* on iOS also keep a silent media element playing: it holds the playback
     session on every iOS version and gives the lock screen something to show */
  if(_silent){ if(_silent.paused&&_wantSilent)_silent.play().catch(()=>{}); return; }
  /* 0.2 s of silence as a WAV, looped: Safari treats the page as media playback */
  const sr=8000,n=sr*0.2|0,b=new ArrayBuffer(44+n*2),v=new DataView(b);
  const str=(o,t)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
  _silent=document.createElement('audio');
  _silent.src=URL.createObjectURL(new Blob([b],{type:'audio/wav'}));
  _silent.loop=true; _silent.setAttribute('playsinline',''); _silent.volume=0.01;
  _silent.style.display='none'; _silent.id='miksSession';
  (document.body||document.documentElement).appendChild(_silent);   /* kept in the DOM so it isn't collected */
  _silent.play().catch(()=>{});
}
claimSession();
let _unlocked=false;
MIKS.unlock=function(ev){
  claimSession();
  const c=ctx();
  if(c.state!=='running')c.resume().then(()=>MIKS.log&&MIKS.log('resumed on '+ev+' · '+c.state)).catch(e=>MIKS.log&&MIKS.log('resume failed: '+e.message));
  if(_unlocked)return;
  _unlocked=true;
  MIKS.log&&MIKS.log('unlock on '+ev+' · session '+(navigator.audioSession?navigator.audioSession.type:'n/a')+(IOS?' · iOS':''));
  try{ const s=c.createBufferSource(); s.buffer=c.createBuffer(1,1,22050); s.connect(c.destination); s.start(0); }catch(e){MIKS.log&&MIKS.log('silent buffer failed: '+e.message);}
};
MIKS.unlocked=()=>_unlocked;
MIKS.isIOS=IOS;
/* keep the silent element in step with the music so lock-screen controls agree */
MIKS.session=function(playing){
  _wantSilent=playing;
  if(!_silent)return;
  if(playing){ if(_silent.paused)_silent.play().catch(()=>{}); }
  else _silent.pause();
};

/* Playback runs on AudioBufferSourceNodes, not <audio> elements: on iOS
   Safari every playbackRate change on a media element interrupts the audio
   pipeline (audible stutter) and its clock is too coarse to phase-lock
   against. Buffer sources resample seamlessly (vinyl mode: pitch moves with
   tempo) and the AudioContext clock is sample-accurate, so a beat lock holds
   without artifacts. Mimics the HTMLMediaElement API the UI uses. */
class BufferPlayer extends EventTarget{
  constructor(){
    super();
    this._out=null;                           /* made on first use: no context before a tap */
    this.buffer=null; this.duration=0;
    this._rate=1; this._offset=0; this._t0=0;
    this._src=null; this._playing=false;
  }
  get out(){ if(!this._out)this._out=ctx().createGain(); return this._out; }
  setBuffer(buf){
    this._stopSrc(); this._playing=false; this._offset=0;
    this.buffer=buf||null; this.duration=buf?buf.duration:0;
  }
  get paused(){return !this._playing;}
  /* true once a scheduled start has actually become audible */
  get started(){return this._playing&&ctx().currentTime>=this._t0;}
  get playbackRate(){return this._rate;}
  set playbackRate(r){
    if(this._playing&&this.started){
      /* snapshot position under the old rate so currentTime stays exact */
      this._offset=this.currentTime; this._t0=ctx().currentTime;
      this._src.playbackRate.setValueAtTime(r,0);
    }else if(this._src){
      this._src.playbackRate.setValueAtTime(r,0);
    }
    this._rate=r;
  }
  /* before a scheduled start this extrapolates backwards along the same
     line the deck will follow once audible — which is exactly what the
     phase maths wants */
  get currentTime(){
    return this._playing ? this._offset+(ctx().currentTime-this._t0)*this._rate
                         : this._offset;
  }
  set currentTime(t){
    t=Math.max(0,Math.min(this.duration||0,t));
    if(this._playing)this._startSrc(t,ctx().currentTime+START_LEAD); else this._offset=t;
  }
  play(){
    if(this._playing||!this.buffer)return;
    this._startSrc(Math.min(this._offset,Math.max(0,this.duration-0.05)),ctx().currentTime+START_LEAD);
    this._playing=true;
    this.dispatchEvent(new Event('play'));
  }
  /* start at an exact context time — the beat-matched entry of a new track */
  startAt(when,at){
    if(!this.buffer)return;
    this._startSrc(Math.max(0,Math.min(at,this.duration-0.05)),Math.max(when,ctx().currentTime+START_LEAD));
    this._playing=true;
    this.dispatchEvent(new Event('play'));
  }
  pause(){
    if(!this._playing)return;
    this._offset=Math.max(0,this.currentTime); this._stopSrc(); this._playing=false;
    this.dispatchEvent(new Event('pause'));
  }
  _startSrc(at,t0){
    this._stopSrc();
    const s=ctx().createBufferSource();
    s.buffer=this.buffer; s.playbackRate.value=this._rate;
    s.connect(this.out);
    this._offset=at; this._t0=t0;
    s.onended=()=>{                          /* natural end only — seeks/stops detach first */
      if(s!==this._src)return;
      this._src=null; this._playing=false; this._offset=this.duration;
      this.dispatchEvent(new Event('ended'));
    };
    s.start(t0,Math.min(at,Math.max(0,this.buffer.duration-0.01)));
    this._src=s;
  }
  _stopSrc(){
    const s=this._src; this._src=null;
    if(s){s.onended=null; try{s.stop();}catch(e){} try{s.disconnect();}catch(e){}}
  }
}

/* ───────────────────────────── master ─────────────────────────────
   Both decks meet here: EQ and volume live on the master so a handoff
   never resets the listener's tone. The analyser feeds the visual. */
let _master=null;
function master(){
  if(_master)return _master;
  const c=ctx();
  const input=c.createGain();
  const low=c.createBiquadFilter(); low.type='lowshelf'; low.frequency.value=200;
  const mid=c.createBiquadFilter(); mid.type='peaking'; mid.frequency.value=1000; mid.Q.value=0.9;
  const high=c.createBiquadFilter(); high.type='highshelf'; high.frequency.value=4000;
  const volume=c.createGain();
  const an=c.createAnalyser(); an.fftSize=256; an.smoothingTimeConstant=0.78;
  input.connect(low); low.connect(mid); mid.connect(high); high.connect(volume);
  volume.connect(an); an.connect(c.destination);
  const data=new Uint8Array(an.frequencyBinCount);
  const band=(a,b)=>{let t=0;for(let i=a;i<b;i++)t+=data[i];return t/(b-a)/255;};
  _master={
    input,low,mid,high,volume,analyser:an,
    setEq(name,db){_master[name].gain.value=db;},
    setVolume(v){volume.gain.value=Math.max(0,Math.min(1,v));},
    /* 128 bins ≈ 172 Hz each */
    audio(){
      an.getByteFrequencyData(data);
      const n=data.length; let s=0;for(let i=0;i<n;i++)s+=data[i];
      return {level:s/n/255, bass:band(1,7), mid:band(7,30), high:band(30,Math.min(90,n))};
    }
  };
  return _master;
}
MIKS.master=master;

/* ────────────────────────────── deck ────────────────────────────── */
class Deck extends EventTarget{
  constructor(key){
    super();
    this.key=key; this.track=null; this.rate=1;
    this.el=new BufferPlayer();
    this.nodes=null; this.synced=false; this._chase=null; this._glide=null;
    this.gainNow=1;                          /* what our own fades left the gain at */
    this.el.addEventListener('ended',()=>this.dispatchEvent(new Event('ended')));
  }
  ensureGraph(){
    if(this.nodes)return;
    const c=ctx();
    /* the low shelf is only for the bass handover between decks */
    const low=c.createBiquadFilter(); low.type='lowshelf'; low.frequency.value=180;
    const gain=c.createGain();
    this.el.out.connect(low); low.connect(gain); gain.connect(master().input);
    this.nodes={low,gain};
  }
  load(track){
    this.ensureGraph();
    this._stopChase(); this._stopGlide();
    this.stop();
    this.track=track; this.rate=1; this.synced=false;
    this.el.setBuffer(track.buffer); this.el.playbackRate=1;
  }
  unload(){ this._stopChase(); this._stopGlide(); this.stop(); this.track=null; this.el.setBuffer(null); }
  get playing(){return !!(this.track&&!this.el.paused);}
  play(){ if(!this.track)return; ctx(); this.el.play(); }
  startAt(when,at){ if(!this.track)return; this.el.startAt(when,at); }
  pause(){ this.el.pause(); }
  stop(){ this.el.pause(); this.el.currentTime=0; }
  seek(t){ if(this.track) this.el.currentTime=Math.max(0,Math.min(this.track.duration-0.05,t)); }
  /* effective bpm right now (base rate — phaseHold's momentary bends excluded) */
  effBpm(){ return this.track&&this.track.bpm ? this.track.bpm*this.rate : null; }
  setRate(r){ this.el.playbackRate=r; this.rate=r; }
  /* beat position (in beats, track grid) at current moment */
  beatPos(){ const t=this.track; if(!t||!t.bpm)return null;
    return (this.el.currentTime - t.offset) / (60/t.bpm); }
  /* seek so this deck's beat grid lands exactly on the other's — a beat-snap,
     sample-accurate on the buffer engine, instead of seconds of detuned glide */
  snapPhase(other){
    const t=this.track;
    if(!t||!t.bpm||!other.track||!other.track.bpm)return;
    if(!(this.playing&&other.playing))return;
    const myB=this.beatPos(), otB=other.beatPos();
    let d=((otB-myB)%1+1)%1; if(d>0.5)d-=1;        /* shortest path, in beats */
    /* aim START_LEAD ahead: the restarted source sits silent that long while
       the other deck keeps moving */
    if(Math.abs(d)>0.01)
      this.el.currentTime += d*(60/t.bpm) + START_LEAD*this.el.playbackRate;
  }
  /* hold the lock like a steady hand on the platter: the scheduled start has
     already landed it, so only whisper-corrections (≤0.5% ≈ 8 cents —
     inaudible) guard against slow drift. Knocked far off (a scrub, a deck
     joining late)? Snap again rather than glide. */
  phaseHold(other,baseRate){
    this._stopChase();
    const frac=x=>((x%1)+1)%1;
    let locked=false, wasBoth=this.playing&&other.playing;
    this._chase=setInterval(()=>{
      if(!this.track||!this.synced){this._stopChase();return;}
      if(!(this.playing&&other.playing)){wasBoth=false;this.el.playbackRate=baseRate;return;}
      if(!this.el.started||!other.el.started)return;   /* scheduled, not audible yet */
      if(!wasBoth){wasBoth=true;this.snapPhase(other);return;}  /* deck just joined */
      let d=frac(other.beatPos())-frac(this.beatPos());
      if(d>0.5)d-=1; if(d<-0.5)d+=1;
      if(Math.abs(d)>0.1){this.snapPhase(other);MIKS.onSnap&&MIKS.onSnap(this,d);return;}
      if(Math.abs(d)<0.006){locked=true;this.el.playbackRate=baseRate;return;}
      const cap=locked?0.005:0.02;
      const bend=Math.max(-cap,Math.min(cap,d*0.8));
      this.el.playbackRate=baseRate*(1+bend);
      MIKS.onPhase&&MIKS.onPhase(this,d);
    },400);
  }
  _stopChase(){ clearInterval(this._chase); this._chase=null; }
  /* after a handoff the new live deck drifts back to its own tempo */
  glideRate(to,seconds){
    this._stopGlide();
    const from=this.rate, t0=performance.now(), ms=Math.max(200,seconds*1000);
    this._glide=setInterval(()=>{
      const x=Math.min(1,(performance.now()-t0)/ms), e=x*x*(3-2*x);
      this.setRate(from+(to-from)*e);
      if(x>=1)this._stopGlide();
    },120);
  }
  _stopGlide(){ clearInterval(this._glide); this._glide=null; }
}

/* ═════════════════ BPM + beat-grid detection ═════════════════ */
/* Low-band onset energy, autocorrelated over 70–180 BPM.
   Returns {bpm, offset, confidence} or null if no stable pulse. */
function detectBeats(buf){
  const sr=buf.sampleRate;
  const ch=buf.numberOfChannels>1
    ? (()=>{const a=buf.getChannelData(0),b=buf.getChannelData(1),m=new Float32Array(a.length);
        for(let i=0;i<a.length;i++)m[i]=(a[i]+b[i])*0.5;return m;})()
    : buf.getChannelData(0);
  /* analyse up to 100s starting after any silence */
  const maxN=Math.min(ch.length, sr*100);
  const hop=Math.round(sr*0.01);            /* 10ms hops */
  const frames=Math.floor(maxN/hop)-1;
  if(frames<800)return null;                /* <8s: too short */
  /* crude low-band: 4-sample averaged then energy */
  const env=new Float32Array(frames);
  for(let f=0;f<frames;f++){
    let e=0,i0=f*hop;
    for(let i=0;i<hop;i+=4){
      const v=(ch[i0+i]+ch[i0+i+1]+ch[i0+i+2]+ch[i0+i+3])*0.25; /* ~5.5kHz lp-ish */
      e+=v*v;
    }
    env[f]=Math.sqrt(e/(hop/4));
  }
  /* onset = positive energy flux */
  const on=new Float32Array(frames);
  for(let f=1;f<frames;f++){const d=env[f]-env[f-1];on[f]=d>0?d:0;}
  /* normalize */
  let mx=0;for(let f=0;f<frames;f++)if(on[f]>mx)mx=on[f];
  if(mx<=0)return null;
  for(let f=0;f<frames;f++)on[f]/=mx;
  /* autocorrelation over beat periods 70–180 bpm (in hops of 10ms) */
  const minLag=Math.round(60/180/0.01), maxLag=Math.round(60/70/0.01);
  const corr=new Float32Array(maxLag+2);
  let bestLag=0,bestV=0,sumV=0,cnt=0;
  for(let lag=minLag;lag<=maxLag;lag++){
    let v=0;
    for(let f=0;f<frames-lag;f++)v+=on[f]*on[f+lag];
    corr[lag]=v;
    /* slight preference toward 100–135bpm */
    const bpm=60/(lag*0.01);
    const w=bpm>=100&&bpm<=135?1.08:(bpm>=85&&bpm<=150?1:0.9);
    const wv=v*w; sumV+=wv; cnt++;
    if(wv>bestV){bestV=wv;bestLag=lag;}
  }
  const mean=sumV/cnt;
  const confidence=bestV/(mean||1);
  if(confidence<1.25)return null;           /* no clear pulse — be honest */
  /* parabolic interpolation around the peak → sub-hop tempo precision */
  let lag=bestLag;
  const y0=corr[bestLag-1]||0,y1=corr[bestLag],y2=corr[bestLag+1]||0;
  const denom=(y0-2*y1+y2);
  if(denom!==0){
    const delta=0.5*(y0-y2)/denom;
    if(Math.abs(delta)<1) lag=bestLag+delta;
  }
  let bpm=60/(lag*0.01);
  /* find beat phase: offset (in hops) maximizing comb sum (integer grid) */
  const L=Math.round(lag);
  let bestOff=0,bestS=-1;
  for(let off=0;off<L;off++){
    let s=0,n=0;
    for(let f=off;f<frames;f+=L){s+=on[f]+((on[f-1]||0)+(on[f+1]||0))*0.5;n++;}
    s/=n;
    if(s>bestS){bestS=s;bestOff=off;}
  }
  /* refinement: snap each predicted beat to its true onset peak, then
     least-squares (beat#, peak position) → sub-hop period. */
  const win=Math.max(3,Math.round(lag*0.12));
  const pts=[];
  for(let k=0;;k++){
    const pred=Math.round(bestOff+k*lag);
    if(pred>=frames-win)break;
    let pi=-1,pv=0.06;                       /* require a real peak */
    for(let j=Math.max(0,pred-win);j<=pred+win;j++)
      if(on[j]>pv){pv=on[j];pi=j;}
    if(pi>=0)pts.push([k,pi]);
  }
  if(pts.length>=8){
    const fit=arr=>{
      let n=arr.length,sx=0,sy=0,sxx=0,sxy=0;
      for(const[x,y]of arr){sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;}
      const m=(n*sxy-sx*sy)/(n*sxx-sx*sx);
      return {m, b:(sy-m*sx)/n};
    };
    let {m,b}=fit(pts);
    const inliers=pts.filter(([x,y])=>Math.abs(y-(m*x+b))<=2);
    if(inliers.length>=8){
      ({m,b}=fit(inliers));
      if(m>minLag*0.9&&m<maxLag*1.1){
        lag=m; bpm=60/(lag*0.01); bestOff=Math.max(0,b);
      }
    }
  }
  /* full-track lock: re-fit the period against real onsets over the WHOLE
     track at ~4ms — the long lever arm pins the tempo ~20x tighter than the
     first 100s can. */
  const fine=refineGrid(ch,sr,60/bpm,bestOff*0.01);
  if(fine){ bpm=60/fine.period; bestOff=fine.offset/0.01; }
  return {bpm:+bpm.toFixed(4), offset:+(bestOff*0.01).toFixed(4), confidence:+confidence.toFixed(2)};
}

const GRID_HOP=0.004;                              /* 4ms analysis frames (nominal) */
/* Returns the envelope plus the frame duration it was ACTUALLY built with:
   the hop is a whole number of samples, so at 44.1kHz a nominal 4ms is really
   176/44100 = 3.9909ms. Converting frames with the nominal value would scale
   every period by 1.0023 — a silent 0.23% tempo error on every track. */
function onsetEnvelope(ch,sr,hopSec){
  const HOP=Math.max(1,Math.round(sr*hopSec));
  const dt=HOP/sr;
  const frames=Math.floor(ch.length/HOP)-1;
  if(frames<500)return null;
  const env=new Float32Array(frames);
  for(let f=0;f<frames;f++){
    let e=0;const i0=f*HOP;
    for(let i=0;i<HOP;i+=2){const v=(ch[i0+i]+ch[i0+i+1])*0.5;e+=v*v;}
    env[f]=Math.sqrt(e/(HOP/2));
  }
  const on=new Float32Array(frames);
  for(let f=1;f<frames;f++){const d=env[f]-env[f-1];on[f]=d>0?d:0;}
  let mx=0;for(let f=0;f<frames;f++)if(on[f]>mx)mx=on[f];
  if(mx<=0)return null;
  for(let f=0;f<frames;f++)on[f]/=mx;
  return {on, dt};
}
function refineGrid(ch,sr,period0,offset0){
  const e=onsetEnvelope(ch,sr,GRID_HOP);
  if(!e)return null;
  const on=e.on, dt=e.dt;
  const frames=on.length, dur=frames*dt;
  const corr=L=>{
    const n=frames-L; if(n<100)return -1;
    let s=0; for(let f=0;f<n;f++)s+=on[f]*on[f+L];
    return s/n;
  };
  let period=period0;
  for(const span of [15,45,110,220,420]){
    if(span>dur*0.75)break;
    const N=Math.round(span/period);
    if(N<8)continue;
    const centre=N*period/dt;
    const half=Math.max(3,Math.round(0.4*period/dt));
    const lo=Math.max(1,Math.round(centre-half)), hi=Math.round(centre+half);
    if(hi>=frames-100)break;
    let best=-1,bestL=-1;
    for(let L=lo;L<=hi;L++){const c=corr(L); if(c>best){best=c;bestL=L;}}
    if(bestL<lo+1||bestL>hi-1)break;
    const y0=corr(bestL-1),y1=best,y2=corr(bestL+1);
    let L=bestL; const den=y0-2*y1+y2;
    if(den!==0){const d=0.5*(y0-y2)/den; if(Math.abs(d)<1)L=bestL+d;}
    const p=L*dt/N;
    if(!(p>period0*0.97&&p<period0*1.03))break;
    period=p;
  }
  const combAt=off=>{
    let s=0,n=0;
    for(let k=0;;k++){
      const f=Math.round((off+k*period)/dt);
      if(f>=frames-1)break;
      if(f>=1){s+=on[f]+(on[f-1]+on[f+1])*0.5;n++;}
    }
    return n?s/n:-1;
  };
  const step=dt, steps=Math.max(2,Math.round(period/step));
  let bo=0,bs=-1;
  for(let i=0;i<steps;i++){const o=i*step, v=combAt(o); if(v>bs){bs=v;bo=o;}}
  const c0=combAt(bo-step), c2=combAt(bo+step), dn=c0-2*bs+c2;
  if(dn!==0){const d=0.5*(c0-c2)/dn; if(Math.abs(d)<1)bo+=d*step;}
  let offset=bo;
  while(offset<0)offset+=period;
  offset%=period;
  return {period, offset};
}

/* waveform peaks for the scrubber */
function makePeaks(buf,n=560){
  const ch=buf.getChannelData(0), step=Math.floor(ch.length/n), out=new Float32Array(n);
  for(let i=0;i<n;i++){let m=0,i0=i*step;
    for(let j=0;j<step;j+=7){const v=Math.abs(ch[i0+j]);if(v>m)m=v;}
    out[i]=m;}
  return out;
}
MIKS.detectBeats=detectBeats;
MIKS.makePeaks=makePeaks;

/* ─────────────────────────── catalogue ───────────────────────────
   manifest.json entries are objects {file,title,duration,bpm,offset,
   confidence,cueBeat} — or bare filenames from the old format, which
   are analysed in the browser on first play. */
const TONE_BANK=[
  {main:0xf3c969, l1:0xfff6d8},   /* golden yellow */
  {main:0xcdb896, l1:0xf3ead2},   /* beige / sand  */
  {main:0xe09f3e, l1:0xffe6b0},   /* ochre / amber */
  {main:0xc9552e, l1:0xffcaa8},   /* clay          */
  {main:0x9aa06a, l1:0xe8edc4},   /* moss          */
  {main:0xe9dfc0, l1:0xfbf6e4},   /* cream         */
  {main:0xb5772a, l1:0xf0cf88},   /* deep bronze   */
  {main:0xd8823a, l1:0xffd9a8},   /* burnt orange  */
  {main:0xe8d79a, l1:0xfdf6e0},   /* pale straw    */
  {main:0xa8452c, l1:0xffbfa0},   /* rust          */
];
MIKS.TONE_BANK=TONE_BANK;
/* "Kaya Pulse.mp3" → "Kaya Pulse", "TaxiRank.mp3" → "TaxiRank", "Nyala1" → "Nyala 1" */
function prettyTitle(f){
  return f.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ')
          .replace(/([A-Za-z])(\d)/g,'$1 $2').replace(/\s+/g,' ').trim();
}
function catalogFromManifest(list){
  return (Array.isArray(list)?list:[]).map((e,i)=>{
    const o=typeof e==='string'?{file:e}:Object.assign({},e);
    const fn=o.file;
    return {
      file:'tracks/'+encodeURIComponent(fn), fileName:fn,
      title:o.title||prettyTitle(fn),
      duration:o.duration||0, bpm:o.bpm||null, offset:o.offset||0,
      confidence:o.confidence||0, cueBeat:o.cueBeat||0,
      tone:o.tone||TONE_BANK[i%TONE_BANK.length], shape:o.shape||null,
      buffer:null, peaks:null, analysed:!!o.bpm, _decoding:null
    };
  });
}
MIKS.catalogFromManifest=catalogFromManifest;
MIKS.prettyTitle=prettyTitle;

/* ────────────────────────────── mixer ──────────────────────────────
   Two decks the listener never sees. One is live, the other idle.
   select(track) decodes it into the idle deck, starts it on the live
   deck's next bar at the live tempo, fades both gains on the audio clock,
   swaps the bass at the midpoint, then hands over. */
const cueTime=t=>(t.offset||0)+(t.cueBeat||0)*(t.bpm?60/t.bpm:0);
const curve=(n,fn)=>{const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=fn(i/(n-1));return a;};
const BASS_CUT=-14;

class Mixer extends EventTarget{
  constructor(opts={}){
    super();
    this.fadeBeats=opts.fadeBeats||16;
    this.tempoWindow=opts.tempoWindow||0.08;    /* ±8 %, like a real pitch fader */
    this.glideBeats=opts.glideBeats||32;
    this.autoAdvance=opts.autoAdvance!==false;
    this.decks=[new Deck('a'),new Deck('b')];
    this.decks.forEach(d=>d.addEventListener('ended',()=>this._onEnded(d)));
    this.tracks=[]; this.live=null; this.transition=null; this._sel=0;
    /* handoffs and auto-advance must not depend on the page's frame loop —
       requestAnimationFrame stops in a background tab, the music doesn't */
    this._timer=setInterval(()=>this.tick(),200);
  }
  emit(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}
  setTracks(list){this.tracks=list;}
  get track(){return this.live?this.live.track:null;}
  get incoming(){return this.transition?this.transition.track:null;}
  get playing(){return !!(this.live&&this.live.playing);}
  get paused(){return !!(this.live&&this.live.track&&!this.live.playing);}
  idle(){return this.decks[0]===this.live?this.decks[1]:this.decks[0];}
  currentTime(){return this.live?Math.max(0,this.live.el.currentTime):0;}
  duration(){return this.track?this.track.duration:0;}
  beatPos(){return this.live?this.live.beatPos():null;}
  bpm(){return this.live?this.live.effBpm():null;}
  /* 0→1 through the current fade, negative while the incoming deck waits for its bar */
  progress(){
    const t=this.transition; if(!t)return 0;
    if(t.frozenP!=null)return t.frozenP;
    return Math.min(1,(ctx().currentTime-t.T)/t.fade);
  }
  next(track){
    const n=this.tracks.length; if(!n)return null;
    const i=this.tracks.indexOf(track||this.track);
    return this.tracks[(i+1)%n];
  }

  /* fetch + decode, cached on the track; only ever two or three in memory */
  /* Fetching may happen any time; decoding waits until a tap has made the
     context (iOS refuses a context made outside a gesture). Resolves null
     when it had to stop at the bytes — call again after ctx() exists. */
  decode(track){
    if(track.buffer)return Promise.resolve(track.buffer);
    if(track._decoding)return track._decoding;
    track._decoding=(async()=>{
      if(!track._bytes){
        const r=await fetch(track.file);
        if(!r.ok)throw new Error('HTTP '+r.status);
        track._bytes=await r.arrayBuffer();
      }
      if(!AC)return null;                       /* no context yet — keep the bytes */
      const bytes=track._bytes; track._bytes=null;   /* decodeAudioData detaches it */
      const buf=await ctx().decodeAudioData(bytes);
      track.buffer=buf; track.duration=buf.duration;
      if(!track.peaks)track.peaks=makePeaks(buf);
      if(!track.analysed){                     /* old-format manifest: analyse here */
        track.analysed=true;
        const b=detectBeats(buf);
        if(b){track.bpm=b.bpm;track.offset=b.offset;track.confidence=b.confidence;}
        this.emit('analysed',{track});
      }
      return buf;
    })();
    return track._decoding.finally(()=>{track._decoding=null;});
  }
  _prune(){
    const keep=new Set([this.track,this.incoming,this.next(this.incoming||this.track)]);
    for(const t of this.tracks)if(!keep.has(t)&&!t._decoding){t.buffer=null;t._bytes=null;}
  }
  _preload(){
    const n=this.next(this.incoming||this.track);
    if(n&&!n.buffer&&!n._bytes)this.decode(n).catch(()=>{});
  }

  /* the one verb the page needs */
  async select(track){
    if(!track)return;
    ctx();
    if(this.transition&&this.transition.track===track)return;
    if(this.track===track){                     /* the one already playing: stay on it */
      if(this.transition){
        this._cancelTransition();
        const g=this.live.nodes.gain.gain, now=ctx().currentTime;   /* back to full over 2 s */
        g.cancelScheduledValues(now); g.setValueAtTime(this.live.gainNow,now);
        g.linearRampToValueAtTime(1,now+2); this.live.gainNow=1;
        this.emit('status');
      }
      if(!this.playing)this.play();
      return;
    }
    const gen=++this._sel;
    this.emit('queue',{track});
    try{ if(!(await this.decode(track)))await this.decode(track); }   /* bytes were cached pre-tap */
    catch(e){ MIKS.warn('Could not load '+track.title+' — '+e.message); this.emit('status'); return; }
    if(gen!==this._sel)return;                 /* superseded by a later pick */
    try{
      if(this.playing) this._startTransition(track);
      else this._coldStart(track);
    }catch(e){ MIKS.warn('Playback error — '+e.message); MIKS.log&&MIKS.log('ERR '+e.message+' @ '+((e.stack||'').split('\n')[1]||'')); }
  }
  _coldStart(track){
    this._cancelTransition();
    this.decks.forEach(d=>d.unload());
    const d=this.decks[0]; this.live=d;
    d.load(track);
    const now=ctx().currentTime;
    d.nodes.gain.gain.cancelScheduledValues(0); d.nodes.gain.gain.setValueAtTime(1,now); d.gainNow=1;
    d.nodes.low.gain.cancelScheduledValues(0); d.nodes.low.gain.setValueAtTime(0,now);
    d.seek(cueTime(track)); d.play();
    this.emit('load',{track}); this.emit('play'); this.emit('status');
    this._prune(); this._preload();
  }
  _startTransition(track){
    const live=this.live, inc=this.idle();
    this._cancelTransition();                  /* keeps the live gain where it is */
    live._stopGlide();                         /* hold the live tempo while we match it */
    inc.load(track);
    const now=ctx().currentTime;
    const liveBpm=live.effBpm(), bpm=track.bpm;
    let rate=1, matched=false;
    if(liveBpm&&bpm){
      let r=liveBpm/bpm; while(r>1.5)r/=2; while(r<0.667)r*=2;   /* octave fold */
      if(Math.abs(r-1)<=this.tempoWindow){rate=r;matched=true;}
    }
    inc.setRate(rate);
    const liveBd=liveBpm?60/liveBpm:0.5;       /* seconds per beat, live tempo */
    const s0=cueTime(track);
    let T;
    if(liveBpm){
      const bp=live.beatPos(), lead=0.25/liveBd;
      const at=matched?Math.ceil((bp+lead)/4)*4:Math.ceil(bp+lead);   /* next bar / next beat */
      T=now+(at-bp)*liveBd;
    }else T=now+0.25;
    const fade=this.fadeBeats*liveBd;
    inc.startAt(T,s0);
    /* gains: equal power, on the audio thread */
    const g0=live.gainNow;
    const gL=live.nodes.gain.gain, gI=inc.nodes.gain.gain;
    gL.cancelScheduledValues(now); gL.setValueAtTime(g0,now);
    gL.setValueCurveAtTime(curve(64,x=>g0*Math.cos(x*Math.PI/2)),T,fade);
    gI.cancelScheduledValues(now); gI.setValueAtTime(0,now);
    gI.setValueCurveAtTime(curve(64,x=>Math.sin(x*Math.PI/2)),T,fade);
    /* bass handover around the midpoint so two kicks never fight */
    const lL=live.nodes.low.gain, lI=inc.nodes.low.gain;
    lI.cancelScheduledValues(now); lI.setValueAtTime(BASS_CUT,now);
    lI.setValueAtTime(BASS_CUT,T+fade*0.35); lI.linearRampToValueAtTime(0,T+fade*0.65);
    lL.cancelScheduledValues(now); lL.setValueAtTime(0,now);
    lL.setValueAtTime(0,T+fade*0.35); lL.linearRampToValueAtTime(BASS_CUT,T+fade*0.65);
    if(matched){ inc.synced=true; inc.phaseHold(live,rate); }
    this.transition={live,inc,track,T,end:T+fade,fade,matched,rate,g0,frozenP:null};
    this.emit('transition',{track,matched,rate,T,fade}); this.emit('status');
    this._prune(); this._preload();
  }
  /* drop the incoming deck; the live deck holds whatever gain it reached */
  _cancelTransition(){
    const t=this.transition; if(!t)return;
    const now=ctx().currentTime, p=Math.max(0,t.frozenP!=null?t.frozenP:this.progress());
    this.transition=null;
    const cur=t.g0*Math.cos(p*Math.PI/2);
    const gL=t.live.nodes.gain.gain;
    gL.cancelScheduledValues(now); gL.setValueAtTime(cur,now); t.live.gainNow=cur;
    const lL=t.live.nodes.low.gain, bass=BASS_CUT*Math.max(0,Math.min(1,(p-0.35)/0.3));
    lL.cancelScheduledValues(now); lL.setValueAtTime(bass,now); lL.linearRampToValueAtTime(0,now+0.4);
    t.inc.synced=false; t.inc.unload();
    const gI=t.inc.nodes.gain.gain; gI.cancelScheduledValues(now); gI.setValueAtTime(0,now);
    t.inc.nodes.low.gain.cancelScheduledValues(now); t.inc.nodes.low.gain.setValueAtTime(0,now);
    this.emit('cancel',{track:t.track});
  }
  _handoff(){
    const t=this.transition; if(!t)return;
    this.transition=null;
    const now=ctx().currentTime, old=t.live, nw=t.inc, from=old.track;
    old.unload();
    old.nodes.gain.gain.cancelScheduledValues(now); old.nodes.gain.gain.setValueAtTime(1,now); old.gainNow=1;
    old.nodes.low.gain.cancelScheduledValues(now); old.nodes.low.gain.setValueAtTime(0,now);
    nw.synced=false; nw._stopChase();
    nw.nodes.gain.gain.cancelScheduledValues(now); nw.nodes.gain.gain.setValueAtTime(1,now); nw.gainNow=1;
    nw.nodes.low.gain.cancelScheduledValues(now); nw.nodes.low.gain.setValueAtTime(0,now);
    this.live=nw;
    if(t.matched&&Math.abs(nw.rate-1)>1e-4&&nw.track.bpm)
      nw.glideRate(1,this.glideBeats*60/nw.track.bpm);
    this.emit('handoff',{from,to:nw.track}); this.emit('load',{track:nw.track}); this.emit('status');
    this._prune(); this._preload();
  }
  /* runs on its own timer; the page may call it per frame as well */
  tick(){
    const t=this.transition;
    if(t){
      if(t.frozenP!=null)return;
      const now=ctx().currentTime;
      if(now>=t.end||(now>=t.T&&!t.live.playing))this._handoff();
    }else if(this.autoAdvance&&this.playing&&this.tracks.length>1){
      const bd=this.bpm()?60/this.bpm():0.5;
      const rem=this.track.duration-this.live.el.currentTime;
      if(rem<=this.fadeBeats*bd+0.6)this.select(this.next());
    }
  }
  _onEnded(deck){
    if(deck!==this.live||this.transition)return;
    this.emit('pause'); this.emit('ended',{track:deck.track}); this.emit('status');
  }

  play(){
    if(!this.live||!this.live.track){ if(this.tracks.length)this.select(this.tracks[0]); return; }
    ctx();
    const t=this.transition;
    if(t&&t.frozenP!=null)this._thaw(); else this.live.play();
    this.emit('play'); this.emit('status');
    /* a mix paused before it became audible is simply cued again */
    if(!t&&this._pendingTrack){const p=this._pendingTrack;this._pendingTrack=null;this.select(p);}
  }
  pause(){
    if(!this.live)return;
    const t=this.transition;
    if(t&&t.frozenP==null)this._freeze(); else this.live.pause();
    this.emit('pause'); this.emit('status');
  }
  toggle(){ this.playing?this.pause():this.play(); }
  seek(sec){ if(this.live)this.live.seek(sec); this.emit('status'); }

  /* pause mid-fade: hold every gain where it is and stop both decks */
  _freeze(){
    const t=this.transition, now=ctx().currentTime, p=this.progress();
    if(p<=0){                                  /* not audible yet — just drop it */
      const track=t.track; this._cancelTransition(); this.live.pause();
      this._pendingTrack=track; return;
    }
    t.frozenP=p;
    const gL=t.live.nodes.gain.gain, gI=t.inc.nodes.gain.gain;
    gL.cancelScheduledValues(now); gL.setValueAtTime(t.g0*Math.cos(p*Math.PI/2),now);
    gI.cancelScheduledValues(now); gI.setValueAtTime(Math.sin(p*Math.PI/2),now);
    const b=Math.max(0,Math.min(1,(p-0.35)/0.3));
    t.live.nodes.low.gain.cancelScheduledValues(now); t.live.nodes.low.gain.setValueAtTime(BASS_CUT*b,now);
    t.inc.nodes.low.gain.cancelScheduledValues(now); t.inc.nodes.low.gain.setValueAtTime(BASS_CUT*(1-b),now);
    t.live.pause(); t.inc.pause();
  }
  /* resume: both decks restart together, the rest of the fade is rescheduled */
  _thaw(){
    const t=this.transition, p=t.frozenP; t.frozenP=null;
    const now=ctx().currentTime, T=now+START_LEAD, rem=(1-p)*t.fade;
    t.live.play(); t.inc.play();
    t.T=T-p*t.fade; t.end=t.T+t.fade;
    const gL=t.live.nodes.gain.gain, gI=t.inc.nodes.gain.gain;
    gL.cancelScheduledValues(now); gL.setValueAtTime(t.g0*Math.cos(p*Math.PI/2),now);
    gL.setValueCurveAtTime(curve(64,x=>t.g0*Math.cos((p+(1-p)*x)*Math.PI/2)),T,rem);
    gI.cancelScheduledValues(now); gI.setValueAtTime(Math.sin(p*Math.PI/2),now);
    gI.setValueCurveAtTime(curve(64,x=>Math.sin((p+(1-p)*x)*Math.PI/2)),T,rem);
    const b=Math.max(0,Math.min(1,(p-0.35)/0.3));
    const lL=t.live.nodes.low.gain, lI=t.inc.nodes.low.gain;
    lL.cancelScheduledValues(now); lL.setValueAtTime(BASS_CUT*b,now);
    lI.cancelScheduledValues(now); lI.setValueAtTime(BASS_CUT*(1-b),now);
    if(b<1){
      const s=Math.max(T,t.T+t.fade*0.35), e=t.T+t.fade*0.65;
      lL.setValueAtTime(BASS_CUT*b,s); lL.linearRampToValueAtTime(BASS_CUT,e);
      lI.setValueAtTime(BASS_CUT*(1-b),s); lI.linearRampToValueAtTime(0,e);
    }
  }
}
MIKS.Mixer=Mixer;
MIKS.Deck=Deck;
MIKS.BufferPlayer=BufferPlayer;
MIKS.cueTime=cueTime;
})();
