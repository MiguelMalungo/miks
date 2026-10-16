/* ═══════════════════════════ the shell ═══════════════════════════
   One document, many pages — so the mix never stops.

   A normal link tears the document down, and the audio with it. So the
   shell intercepts links to the site's own pages, fetches the target,
   swaps the <style> and the <body>, and pushes the URL. The document is
   never replaced, so the AudioContext, the decks and the fade carry
   straight across. Real URLs, working back button, and a direct hit on
   any page still loads normally.

   music.html is deliberately left as a hard navigation: it has its own
   player, and it should take over rather than fight the mix.

   The shell owns the mixer and the catalogue; a page owns its view and
   registers MIKS.onLeave() for anything it must dispose (the homepage's
   WebGL figure). Page loops are sandboxed: each navigation bumps a
   generation, and anything a page scheduled before the bump never runs
   again, so its rAF loop stops re-scheduling and dies.                 */
(function(){
'use strict';
const MIKS=window.MIKS=window.MIKS||{};
if(MIKS.shell)return;
MIKS.shell=true;

/* the shell's own timing, unaffected by the sandbox installed below */
const rafO=window.requestAnimationFrame.bind(window);
const siO=window.setInterval.bind(window), stO=window.setTimeout.bind(window);
const ciO=window.clearInterval.bind(window), ctO=window.clearTimeout.bind(window);

/* ── page sandbox ──────────────────────────────────────────────────
   Listeners are deliberately left alone: the ones a page leaves behind
   only feed loops that are already dead, and reaching into every
   addEventListener would break libraries that manage their own. */
let gen=0, ctxGen=null;
const timers=new Set(), leave=[];
const run=(g,fn,arg)=>{const p=ctxGen;ctxGen=g;try{return fn(arg);}finally{ctxGen=p;}};

window.requestAnimationFrame=function(cb){
  if(ctxGen===null||typeof cb!=='function')return rafO(cb);
  const g=ctxGen;
  return rafO(ts=>{ if(g===gen)run(g,cb,ts); });
};
window.setTimeout=function(cb,ms){
  if(ctxGen===null||typeof cb!=='function')return stO.apply(null,arguments);
  const g=ctxGen, id=stO(()=>{timers.delete(id); if(g===gen)run(g,cb);},ms);
  timers.add(id); return id;
};
window.setInterval=function(cb,ms){
  if(ctxGen===null||typeof cb!=='function')return siO.apply(null,arguments);
  const g=ctxGen, id=siO(()=>{ if(g===gen)run(g,cb); else {ciO(id);timers.delete(id);} },ms);
  timers.add(id); return id;
};
MIKS.onLeave=fn=>{ if(typeof fn==='function')leave.push(fn); };

function endPage(){
  gen++;
  timers.forEach(id=>{ciO(id);ctO(id);}); timers.clear();
  while(leave.length){ try{leave.pop()();}catch(e){} }
  try{ if(window.ScrollTrigger&&ScrollTrigger.killAll)ScrollTrigger.killAll(); }catch(e){}
  try{ if(window.gsap)gsap.globalTimeline.clear(); }catch(e){}
}

/* ── the mixer, owned by the document ──────────────────────────── */
const mixer=new MIKS.Mixer({fadeBeats:16,tempoWindow:0.08,autoAdvance:true});
MIKS.mixer=mixer;
MIKS.catalog=[];
/* iOS: the first tap claims the audio session; later taps re-resume it */
['touchend','click','keydown'].forEach(ev=>addEventListener(ev,()=>MIKS.unlock(ev),{passive:true}));

/* a shape per track — from the manifest, else by list position, and never
   the same as the row before, so auto-advance always morphs */
function assignShapes(list){
  const order=MIKS.SHAPE_ORDER||['infinity'], n=order.length;
  list.forEach((t,i)=>{ t.shapeName=(t.shape&&order.includes(t.shape))?t.shape:order[i%n]; t.shapeFixed=!!t.shape; });
  for(let i=1;i<list.length;i++){
    const t=list[i], prev=list[i-1].shapeName, next=list[i+1]?list[i+1].shapeName:null;
    if(!t.shapeFixed&&(t.shapeName===prev||t.shapeName===next))
      t.shapeName=order.find(s=>s!==prev&&s!==next)||t.shapeName;
  }
}

MIKS.ready=(async function(){
  if(location.protocol==='file:')return MIKS.catalog;
  try{
    const r=await fetch('tracks/manifest.json',{cache:'no-cache'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    MIKS.catalog=MIKS.catalogFromManifest(await r.json());
  }catch(e){ MIKS.warn('Could not load the catalogue — '+e.message); return MIKS.catalog; }
  assignShapes(MIKS.catalog);
  mixer.setTracks(MIKS.catalog);
  if(MIKS.catalog[0])mixer.decode(MIKS.catalog[0]).catch(()=>{});
  paint();
  return MIKS.catalog;
})();

/* ── the mini player ───────────────────────────────────────────────
   On every page but the homepage, which has the full controls. Mute
   drops the master to silence and leaves the mix running, so the beat
   and the figure are still in step when you come back. */
let muted=false, vol=1;
const CSS=`
  .miksbar{position:absolute;right:42px;top:50%;transform:translateY(-50%);
    display:none;align-items:center;gap:10px;z-index:12}
  .miksbar.on{display:flex}
  .miksbar .nm{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:9px;letter-spacing:.22em;
    text-transform:uppercase;color:#8f8069;max-width:22ch;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;transition:color .3s}
  .miksbar .nm b{color:#f3c969;font-weight:500}
  .miksbar button{width:30px;height:30px;border-radius:50%;cursor:pointer;flex:none;
    background:rgba(20,13,7,.72);border:1px solid rgba(224,159,62,.22);color:#f3c969;
    display:flex;align-items:center;justify-content:center;padding:0;
    -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:border-color .3s,color .3s,transform .2s}
  .miksbar button:hover{border-color:#f3c969;transform:scale(1.08)}
  .miksbar button svg{width:14px;height:14px;fill:currentColor;pointer-events:none}
  .miksbar.muted .nm{color:#6d6152}
  .miksbar.muted button{color:#8f8069}
  @media (max-width:860px){
    .miksbar{right:16px}
    .miksbar .nm{display:none}
    /* keep the last nav link clear of the button */
    header.miks-pl nav{padding-right:40px}
  }`;
if(!document.getElementById('miksShellCss')){
  const st=document.createElement('style'); st.id='miksShellCss'; st.textContent=CSS;
  document.head.appendChild(st);
}
const ICO_ON='<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>';
const ICO_OFF='<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm15.1-1.5-1.4 1.4L19.2 12l-1.5 1.5 1.4 1.4L20.6 13l1.5 1.5 1.4-1.4L22 12l1.5-1.5-1.4-1.4L20.6 11z"/></svg>';

let bar=null;
const onHome=()=>/(^|\/)(index\.html)?$/.test(location.pathname.split('?')[0]);

function mount(){
  bar=null;
  const header=document.querySelector('header');
  if(!header||onHome())return;
  bar=document.createElement('div');
  bar.className='miksbar';
  bar.innerHTML='<span class="nm"></span><button type="button"></button>';
  bar.querySelector('button').addEventListener('click',e=>{e.preventDefault();toggleMute();});
  header.appendChild(bar);
  header.classList.add('miks-pl');
  paint();
}
function toggleMute(){
  muted=!muted;
  const m=MIKS.master();
  if(muted){ vol=m.volume.gain.value||1; m.setVolume(0); } else m.setVolume(vol);
  paint();
}
function paint(){
  if(!bar)return;
  const t=mixer.track, on=!!t;
  bar.classList.toggle('on',on);
  bar.classList.toggle('muted',muted);
  if(!on)return;
  const inc=mixer.incoming;
  bar.querySelector('.nm').innerHTML=inc
    ? '<b>'+esc(t.title)+'</b> → '+esc(inc.title)
    : '<b>'+esc(t.title)+'</b>';
  const b=bar.querySelector('button');
  b.innerHTML=muted?ICO_OFF:ICO_ON;
  b.setAttribute('aria-label',muted?'Unmute':'Mute');
  b.title=muted?'Unmute':'Mute';
}
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
['load','play','pause','handoff','transition','cancel','ended','status'].forEach(ev=>mixer.addEventListener(ev,paint));

/* ── the router ────────────────────────────────────────────────── */
const loaded=new Set([...document.querySelectorAll('script[src]')].map(s=>s.src));
const HARD=/music\.html$/;                 /* its own player takes over there */

function internal(a){
  if(a.target&&a.target!=='_self')return null;
  const href=a.getAttribute('href');
  if(!href||href[0]==='#')return null;
  let u; try{ u=new URL(href,location.href); }catch(e){ return null; }
  if(u.origin!==location.origin)return null;
  if(!/\.html$/.test(u.pathname))return null;
  return u;
}
addEventListener('click',e=>{
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  const a=e.target.closest&&e.target.closest('a[href]');
  if(!a)return;
  const u=internal(a);
  if(!u||HARD.test(u.pathname))return;                     /* let the browser do it */
  if(u.href===location.href){e.preventDefault();return;}
  e.preventDefault();
  go(u.href,true);
});
addEventListener('popstate',()=>{ if(HARD.test(location.pathname))location.reload(); else go(location.href,false); });

let busy=false;
async function go(href,push){
  if(busy)return; busy=true;
  try{
    const r=await fetch(href,{cache:'no-cache'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const doc=new DOMParser().parseFromString(await r.text(),'text/html');
    endPage();
    if(push)history.pushState({},'',href);
    document.title=doc.title;
    /* page styles: drop the old page's, take the new one's */
    document.querySelectorAll('style[data-page]').forEach(s=>s.remove());
    doc.querySelectorAll('style').forEach(s=>{
      const st=document.createElement('style');
      st.setAttribute('data-page',''); st.textContent=s.textContent;
      document.head.appendChild(st);
    });
    document.body.className=doc.body.className;
    document.body.innerHTML=doc.body.innerHTML;
    document.body.querySelectorAll('script').forEach(s=>s.remove());   /* inert copies */
    scrollTo(0,0);
    await scripts(doc);
    mount();
    if(window.ScrollTrigger&&ScrollTrigger.refresh)try{ScrollTrigger.refresh();}catch(e){}
  }catch(e){
    location.href=href; return;                            /* fall back to a real navigation */
  }finally{ busy=false; }
}

async function scripts(doc){
  for(const s of [...doc.querySelectorAll('script')]){
    const src=s.getAttribute('src');
    if(src){
      const abs=new URL(src,location.href).href;
      if(loaded.has(abs))continue;
      await new Promise(res=>{
        const el=document.createElement('script');
        el.src=abs; el.onload=res; el.onerror=res;
        document.head.appendChild(el);
      });
      loaded.add(abs);
    }else{
      /* wrapped so a page's top-level const can be declared again on a
         second visit, and tagged with this generation so its loops die
         when the page is left */
      const el=document.createElement('script');
      el.textContent='(function(){'+s.textContent+'\n})();';
      const prev=ctxGen; ctxGen=gen;
      try{ document.body.appendChild(el); }finally{ ctxGen=prev; }
    }
  }
}

/* first load: the page's own scripts already ran in global scope — just
   tag this generation so their loops are disposable, and mount the bar */
ctxGen=gen;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);
else mount();
stO(()=>{ctxGen=null;},0);
})();
