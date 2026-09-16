/* ═══════════════════════════ the figure ═══════════════════════════
   One renderer, six shapes (shapes.js), and a morph between any two.
   Everything is built from ring tables — centre, frame, radius per ring —
   in two slots, A and B, and one number uMorph lerps between them:

     occluder  a dark ring-built tube just inside the surface, depth-written
               first so crossings read over/under. Two index buffers (one per
               slot's path topology); the visible one swaps at the midpoint.
     tiles     an InstancedMesh of metal blocks in rings, sized to the ring
               spacing and tube radius, so thin lines get bead-sized tiles.
               Lerp position, slerp rotation, shrink mid-morph.
     swarm     points on the surface with two homes each. The beat wave
               (left → right once per bar) pulls them dense and bright; a
               mix floods the incoming tone in from the left; mid-morph the
               cloud loosens and re-settles on the new figure.

   Driven from outside: setBeat, setAudio, setTone, setMix, commitMix,
   setPlaying, and for the shape: setShape, morphTo, setMorph, commit,
   reverse.                                                                */
(function(){
'use strict';
const MIKS=window.MIKS=window.MIKS||{};

MIKS.figure=function(canvas,opts={}){
  const THREE=window.THREE; if(!THREE||!MIKS.shapes)return null;
  const SHAPES=MIKS.SHAPES, S=MIKS.shapes;
  const SMALL=opts.small!=null?opts.small:(Math.min(innerWidth,innerHeight)<700||/Mobi|Android/i.test(navigator.userAgent));
  const PIX=Math.min(devicePixelRatio||1,2);

  const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:!SMALL,powerPreference:'high-performance'});
  renderer.setPixelRatio(PIX);
  renderer.setClearColor(0x000000,0);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.05;
  const scene=new THREE.Scene();
  const cam=new THREE.PerspectiveCamera(30,1,0.1,60);
  const group=new THREE.Group(); scene.add(group);

  /* ring budgets — identical for every shape, so each tile and point has
     exactly one home in each */
  const OR=SMALL?220:360, OA=SMALL?18:28;         /* occluder rings, verts around */
  const TR=SMALL?110:170, TA=SMALL?12:14;         /* tile rings, tiles around */
  const SR=SMALL?150:320, SA=SMALL?70:150;        /* swarm rings, points around */

  /* ── studio cube map for the metal (generated, no assets) ────── */
  function face(paint){const c=document.createElement('canvas');c.width=c.height=64;paint(c.getContext('2d'),64);return c;}
  const grad=(g,n,stops)=>{const lg=g.createLinearGradient(0,0,0,n);stops.forEach(([o,col])=>lg.addColorStop(o,col));g.fillStyle=lg;g.fillRect(0,0,n,n);};
  const side=(g,n)=>{grad(g,n,[[0,'#f4e6c8'],[0.28,'#6d5a40'],[0.55,'#1a120a'],[1,'#0a0604']]);g.fillStyle='rgba(255,244,214,.55)';g.fillRect(0,n*0.36,n,n*0.06);};
  const envMap=new THREE.CubeTexture([face(side),face(side),
    face((g,n)=>grad(g,n,[[0,'#fff6dc'],[0.6,'#d9c39a'],[1,'#8a6d45']])),
    face((g,n)=>grad(g,n,[[0,'#241a10'],[1,'#050302']])),face(side),face(side)]);
  envMap.colorSpace=THREE.SRGBColorSpace; envMap.needsUpdate=true;

  /* ── lights ───────────────────────────────────────────────────── */
  const key=new THREE.DirectionalLight(0xfff1d6,1.7); key.position.set(-3,4,5); scene.add(key);
  const rim=new THREE.DirectionalLight(0xe09f3e,0.7); rim.position.set(4,-2,3); scene.add(rim);
  scene.add(new THREE.AmbientLight(0x4a3822,0.9));

  /* ═══ slot tables ═══ */
  /* A slot holds, per layer, the flat arrays the GPU or the tile loop reads. */
  function makeSlot(){
    return {
      name:null, halfW:1, halfH:1, tilt:0.4,
      occ:{pos:new Float32Array(OR*OA*3), index:null},
      tile:{pos:new Float32Array(TR*TA*3), dir:new Float32Array(TR*TA*3),
            quat:new Float32Array(TR*TA*4), size:new Float32Array(TR*TA*3), x:new Float32Array(TR*TA)},
      swarm:{center:new Float32Array(SR*SA*3), dir:new Float32Array(SR*SA*3), r:new Float32Array(SR*SA)},
      rings:null                                   /* swarm-resolution table, for alignment */
    };
  }
  const A=makeSlot(), B=makeSlot();

  /* fill a slot from a shape (with optional per-path alignment) */
  const _n=new THREE.Vector3(),_b=new THREE.Vector3(),_d=new THREE.Vector3(),_t=new THREE.Vector3(),_y=new THREE.Vector3(),
        _m=new THREE.Matrix4(),_q=new THREE.Quaternion();
  function fillSlot(slot,shape,align){
    const occ=S.sample(shape,OR,align), tl=S.sample(shape,TR,align), sw=S.sample(shape,SR,align);
    slot.name=shape.name; slot.halfW=sw.halfW; slot.halfH=sw.halfH; slot.tilt=shape.tilt; slot.rings=sw;
    /* occluder verts + index (per path topology) */
    const op=slot.occ.pos; let k=0;
    for(let i=0;i<OR;i++){
      const off=(i&1)*(Math.PI/OA), R=occ.r[i]*0.86;
      for(let j=0;j<OA;j++){
        const v=j/OA*Math.PI*2+off, cv=Math.cos(v), sv=Math.sin(v);
        op[k*3]  =occ.center[i*3]  +(occ.N[i*3]  *cv+occ.B[i*3]  *sv)*R;
        op[k*3+1]=occ.center[i*3+1]+(occ.N[i*3+1]*cv+occ.B[i*3+1]*sv)*R;
        op[k*3+2]=occ.center[i*3+2]+(occ.N[i*3+2]*cv+occ.B[i*3+2]*sv)*R;
        k++;
      }
    }
    const idx=[];
    const quad=(r0,r1)=>{for(let j=0;j<OA;j++){const j1=(j+1)%OA;
      const a0=r0*OA+j,a1=r0*OA+j1,b0=r1*OA+j,b1=r1*OA+j1; idx.push(a0,b0,a1,a1,b0,b1);}};
    occ.blocks.forEach(bl=>{for(let i=0;i<bl.count-1;i++)quad(bl.start+i,bl.start+i+1);
      if(bl.closed&&bl.count>2)quad(bl.start+bl.count-1,bl.start);});
    slot.occ.index=new THREE.BufferAttribute(new Uint32Array(idx),1);
    /* tiles */
    const tp=slot.tile.pos,td=slot.tile.dir,tq=slot.tile.quat,ts=slot.tile.size,tx=slot.tile.x; k=0;
    for(let i=0;i<TR;i++){
      const off=(i&1)*(Math.PI/TA), r=tl.r[i];
      _n.set(tl.N[i*3],tl.N[i*3+1],tl.N[i*3+2]); _b.set(tl.B[i*3],tl.B[i*3+1],tl.B[i*3+2]);
      _t.crossVectors(_n,_b).normalize();            /* B = T × N  ⇒  T = N × B */
      const len=tl.spacing[i]*0.72, wid=(2*Math.PI*r/TA)*0.78, thick=r*0.42;
      for(let j=0;j<TA;j++){
        const v=j/TA*Math.PI*2+off;
        _d.copy(_n).multiplyScalar(Math.cos(v)).addScaledVector(_b,Math.sin(v)).normalize();
        tp[k*3]=tl.center[i*3]; tp[k*3+1]=tl.center[i*3+1]; tp[k*3+2]=tl.center[i*3+2];
        td[k*3]=_d.x; td[k*3+1]=_d.y; td[k*3+2]=_d.z;
        _y.crossVectors(_d,_t).normalize(); _m.makeBasis(_t,_y,_d); _q.setFromRotationMatrix(_m);
        tq[k*4]=_q.x; tq[k*4+1]=_q.y; tq[k*4+2]=_q.z; tq[k*4+3]=_q.w;
        ts[k*3]=len; ts[k*3+1]=wid; ts[k*3+2]=thick;
        tx[k]=r*0.86+thick/2-0.01;                   /* radial seat: face just proud of the tube */
        k++;
      }
    }
    /* swarm */
    const sc=slot.swarm.center,sd=slot.swarm.dir,sr=slot.swarm.r; k=0;
    for(let i=0;i<SR;i++){
      const off=(i&1)*(Math.PI/SA);
      for(let j=0;j<SA;j++){
        const v=j/SA*Math.PI*2+off, cv=Math.cos(v), sv=Math.sin(v);
        sc[k*3]=sw.center[i*3]; sc[k*3+1]=sw.center[i*3+1]; sc[k*3+2]=sw.center[i*3+2];
        sd[k*3]=sw.N[i*3]*cv+sw.B[i*3]*sv; sd[k*3+1]=sw.N[i*3+1]*cv+sw.B[i*3+1]*sv; sd[k*3+2]=sw.N[i*3+2]*cv+sw.B[i*3+2]*sv;
        sr[k]=sw.r[i];
        k++;
      }
    }
  }
  /* bake the current lerp into A so an interrupted morph continues smoothly */
  function bake(m){
    if(m<=0)return; if(m>=1){copySlot(B,A);return;}
    const L=(a,b)=>{for(let i=0;i<a.length;i++)a[i]+=(b[i]-a[i])*m;};
    L(A.occ.pos,B.occ.pos); L(A.tile.pos,B.tile.pos); L(A.tile.dir,B.tile.dir); L(A.tile.size,B.tile.size); L(A.tile.x,B.tile.x);
    L(A.swarm.center,B.swarm.center); L(A.swarm.dir,B.swarm.dir); L(A.swarm.r,B.swarm.r);
    const qa=new THREE.Quaternion(),qb=new THREE.Quaternion();
    for(let k=0;k<TR*TA;k++){
      qa.set(A.tile.quat[k*4],A.tile.quat[k*4+1],A.tile.quat[k*4+2],A.tile.quat[k*4+3]);
      qb.set(B.tile.quat[k*4],B.tile.quat[k*4+1],B.tile.quat[k*4+2],B.tile.quat[k*4+3]);
      qa.slerp(qb,m); A.tile.quat[k*4]=qa.x;A.tile.quat[k*4+1]=qa.y;A.tile.quat[k*4+2]=qa.z;A.tile.quat[k*4+3]=qa.w;
    }
    A.halfW+=(B.halfW-A.halfW)*m; A.halfH+=(B.halfH-A.halfH)*m; A.tilt+=(B.tilt-A.tilt)*m;
    if(m>=0.5){A.occ.index=B.occ.index;A.name=B.name;A.rings=B.rings;}
    L(A.rings.center,B.rings.center);
  }
  function copySlot(src,dst){
    dst.name=src.name; dst.halfW=src.halfW; dst.halfH=src.halfH; dst.tilt=src.tilt; dst.rings=src.rings; dst.occ.index=src.occ.index;
    dst.occ.pos.set(src.occ.pos);
    dst.tile.pos.set(src.tile.pos); dst.tile.dir.set(src.tile.dir); dst.tile.quat.set(src.tile.quat); dst.tile.size.set(src.tile.size); dst.tile.x.set(src.tile.x);
    dst.swarm.center.set(src.swarm.center); dst.swarm.dir.set(src.swarm.dir); dst.swarm.r.set(src.swarm.r);
  }

  /* ═══ occluder ═══ */
  const occGeo=new THREE.BufferGeometry();
  occGeo.setAttribute('position',new THREE.BufferAttribute(A.occ.pos,3));
  occGeo.setAttribute('aPosB',new THREE.BufferAttribute(B.occ.pos,3));
  occGeo.boundingSphere=new THREE.Sphere(new THREE.Vector3(),12);
  const occMat=new THREE.ShaderMaterial({
    uniforms:{uMorph:{value:0}},
    vertexShader:`uniform float uMorph; attribute vec3 aPosB;
      void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(mix(position,aPosB,uMorph),1.0); }`,
    fragmentShader:`void main(){ gl_FragColor=vec4(0.043,0.027,0.016,1.0); }`
  });
  const occ=new THREE.Mesh(occGeo,occMat); occ.renderOrder=0; occ.frustumCulled=false; group.add(occ);

  /* ═══ tiles ═══ */
  const tileMat=new THREE.MeshStandardMaterial({
    color:0xc4bfb3, metalness:0.94, roughness:0.28, envMap, envMapIntensity:1.2,
    emissive:0x1a1208, emissiveIntensity:0.6
  });
  const tiles=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),tileMat,TR*TA);
  tiles.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(TR*TA*3).fill(1),3);
  tiles.renderOrder=1; tiles.frustumCulled=false; group.add(tiles);

  /* ═══ swarm ═══ */
  const N=SR*SA;
  const pRand=new Float32Array(N), pRing=new Float32Array(N);
  for(let k=0;k<N;k++){pRand[k]=Math.random();pRing[k]=((k/SA)|0)&1;}
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(A.swarm.center,3));
  geo.setAttribute('aDirA',new THREE.BufferAttribute(A.swarm.dir,3));
  geo.setAttribute('aRA',new THREE.BufferAttribute(A.swarm.r,1));
  geo.setAttribute('aCenterB',new THREE.BufferAttribute(B.swarm.center,3));
  geo.setAttribute('aDirB',new THREE.BufferAttribute(B.swarm.dir,3));
  geo.setAttribute('aRB',new THREE.BufferAttribute(B.swarm.r,1));
  geo.setAttribute('aRand',new THREE.BufferAttribute(pRand,1));
  geo.setAttribute('aRing',new THREE.BufferAttribute(pRing,1));
  geo.boundingSphere=new THREE.Sphere(new THREE.Vector3(),12);

  const NOISE=`
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0);
      const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy));
      vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz);
      vec3 l=1.0-g;
      vec3 i1=min(g.xyz,l.zxy);
      vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx;
      vec3 x2=x0-i2+C.yyy;
      vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(
          i.z+vec4(0.0,i1.z,i2.z,1.0))
        + i.y+vec4(0.0,i1.y,i2.y,1.0))
        + i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=0.142857142857;
      vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z);
      vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy;
      vec4 y=y_*ns.x+ns.yyyy;
      vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy);
      vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0;
      vec4 s1=floor(b1)*2.0+1.0;
      vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
      vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x);
      vec3 p1=vec3(a0.zw,h.y);
      vec3 p2=vec3(a1.xy,h.z);
      vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
      m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }`;

  const uni={
    uTime:{value:0}, uMorph:{value:0}, uHalfWA:{value:3}, uHalfWB:{value:3},
    uWave:{value:-1}, uBeat:{value:0},
    uLevel:{value:0}, uBass:{value:0}, uHigh:{value:0}, uPlaying:{value:0},
    uMix:{value:0}, uSize:{value:SMALL?13:18}, uPix:{value:PIX},
    uColA:{value:new THREE.Color(0xf3c969)}, uColB:{value:new THREE.Color(0xfff6d8)},
    uColIn:{value:new THREE.Color(0xf3c969)}, uColInB:{value:new THREE.Color(0xfff6d8)}
  };
  const mat=new THREE.ShaderMaterial({
    uniforms:uni, transparent:true, depthWrite:false, depthTest:true,
    blending:THREE.AdditiveBlending,
    vertexShader:NOISE+`
      uniform float uTime,uMorph,uHalfWA,uHalfWB,uWave,uBeat,uLevel,uBass,uHigh,uPlaying,uMix,uSize,uPix;
      uniform vec3 uColA,uColB,uColIn,uColInB;
      attribute vec3 aDirA,aCenterB,aDirB; attribute float aRA,aRB,aRand,aRing;
      varying vec3 vCol; varying float vGlow;
      void main(){
        float m=uMorph, dis=4.0*m*(1.0-m);          /* 1 at mid-morph */
        vec3 c=mix(position,aCenterB,m);
        vec3 dir=normalize(mix(aDirA,aDirB,m)+vec3(1e-4));
        float R=mix(aRA,aRB,m)*1.06;
        float aX=c.x/mix(uHalfWA,uHalfWB,m);
        /* the crest runs left → right once per bar */
        float crest=mix(-1.45,1.45,uWave);
        float near=(1.0-smoothstep(0.0,0.62,abs(aX-crest)))*uPlaying;
        float n=snoise(c*1.7+dir*0.6+vec3(0.0,uTime*0.32,uTime*0.11));
        float loose=(1.0-near)*(0.42+uLevel*0.4+uBass*0.2)*uPlaying+(1.0-uPlaying)*0.14+dis*0.9;
        float rad=R*(1.0+max(n,-0.35)*loose*(1.0+dis)+aRand*0.05)+near*uBeat*0.05;
        vec3 p=c+dir*rad;
        float glow=0.38+near*1.0+near*uBeat*0.8+uHigh*0.3+aRing*0.08+dis*0.35;
        float split=mix(-1.6,1.6,uMix);
        float old=smoothstep(-0.18,0.18,aX-split);
        vec3 cm=mix(uColIn,uColA,old), cl=mix(uColInB,uColB,old);
        vCol=mix(cm,cl,clamp(glow*0.55,0.0,1.0));
        vGlow=glow;
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        gl_Position=projectionMatrix*mv;
        gl_PointSize=uSize*uPix*(0.55+aRand*0.7)*(0.7+near*1.2+dis*0.3)/max(0.4,-mv.z);
      }`,
    fragmentShader:`
      precision mediump float;
      varying vec3 vCol; varying float vGlow;
      void main(){
        vec2 c=gl_PointCoord-0.5; float d2=dot(c,c);
        if(d2>0.25)discard;
        float a=smoothstep(0.25,0.03,d2);
        gl_FragColor=vec4(vCol,a*(0.22+vGlow*0.55));
      }`
  });
  const pts=new THREE.Points(geo,mat); pts.renderOrder=2; pts.frustumCulled=false; group.add(pts);

  function markDirty(slot){
    if(slot===A){geo.attributes.position.needsUpdate=true;geo.attributes.aDirA.needsUpdate=true;geo.attributes.aRA.needsUpdate=true;occGeo.attributes.position.needsUpdate=true;}
    else{geo.attributes.aCenterB.needsUpdate=true;geo.attributes.aDirB.needsUpdate=true;geo.attributes.aRB.needsUpdate=true;occGeo.attributes.aPosB.needsUpdate=true;}
  }

  /* ═══ framing ═══ */
  let W=2,H=2, dist=10, distT=10;
  function fitDist(halfW,halfH){
    const tan=Math.tan(cam.fov/2*Math.PI/180);
    return Math.max((halfW*1.15)/(0.84*tan*cam.aspect),(halfH*1.25+0.3)/(0.72*tan));
  }
  function resize(){
    const r=canvas.parentElement.getBoundingClientRect();
    W=Math.max(2,r.width); H=Math.max(2,r.height);
    renderer.setSize(W,H,false);
    cam.aspect=W/H; cam.updateProjectionMatrix();
    dist=distT=fitDist(A.halfW,A.halfH);
  }
  addEventListener('resize',resize);

  /* ═══ state ═══ */
  const tgtA=new THREE.Color(0xf3c969), tgtB=new THREE.Color(0xfff6d8);
  let level=0,bass=0,mid=0,high=0, lvT=0,bsT=0,mdT=0,hiT=0;
  let wave=-1, waveT=-1, beat=0, lastBeat=-1, playing=0, playT=0;
  let mixP=0, mixT=0, mixing=false;
  let px=0,py=0,ptx=0,pty=0;
  let morph=0, morphT=0, mode='idle', autoSecs=2, clock0=0, clockFrom=0;   /* idle | ext | auto | rev */
  const white=new THREE.Color(1,1,1);
  canvas.addEventListener('pointermove',e=>{const r=canvas.getBoundingClientRect();
    ptx=(e.clientX-r.left)/r.width*2-1; pty=-((e.clientY-r.top)/r.height*2-1);});
  canvas.addEventListener('pointerleave',()=>{ptx=0;pty=0;});

  /* initial shape */
  fillSlot(A,SHAPES[opts.shape||'infinity'],null); copySlot(A,B); markDirty(A); markDirty(B);
  occGeo.setIndex(A.occ.index);
  resize();

  const smooth=x=>x*x*(3-2*x);
  const _pos=new THREE.Vector3(),_mm=new THREE.Matrix4(),_sc=new THREE.Vector3(),_c=new THREE.Color(),
        _qa=new THREE.Quaternion(),_qb=new THREE.Quaternion();
  let lastT=0, shownIdx=A.occ.index;
  function frame(t){
    const dt=Math.min(0.05,t-lastT||0.016); lastT=t;
    level+=(lvT-level)*(lvT>level?0.12:0.05);
    bass +=(bsT-bass )*(bsT>bass ?0.14:0.05);
    mid  +=(mdT-mid  )*(mdT>mid  ?0.08:0.05);
    high +=(hiT-high )*(hiT>high ?0.10:0.06);
    playing+=(playT-playing)*0.04;
    beat*=Math.exp(-dt/0.17);
    mixP+=(mixT-mixP)*0.12;
    uni.uColA.value.lerp(tgtA,0.05); uni.uColB.value.lerp(tgtB,0.05);
    px+=(ptx-px)*0.05; py+=(pty-py)*0.05;

    /* morph clock */
    /* timed morphs run on the wall clock, so a hidden tab still lands them */
    if(mode==='auto'){morph=morphT=Math.min(1,clockFrom+(performance.now()-clock0)/1000/autoSecs); if(morph>=1)commit();}
    else if(mode==='rev'){morph=morphT=Math.max(0,clockFrom-(performance.now()-clock0)/1000); if(morph<=0){mode='idle';}}
    else if(mode==='ext'){morph+=(morphT-morph)*0.25;}
    const m=Math.max(0,Math.min(1,morph)), dis=4*m*(1-m);
    uni.uMorph.value=m; occMat.uniforms.uMorph.value=m;
    const idx=m<0.5?A.occ.index:B.occ.index;
    if(idx!==shownIdx){shownIdx=idx;occGeo.setIndex(idx);}

    /* the wave: continuous while a bar plays, parked off-screen otherwise */
    if(waveT>=0){ if(wave<0||Math.abs(waveT-wave)>0.5)wave=waveT; else wave+=(waveT-wave)*0.35; }
    else wave+=(-1-wave)*0.05;
    uni.uTime.value=t; uni.uWave.value=wave; uni.uBeat.value=beat;
    uni.uLevel.value=level; uni.uBass.value=bass; uni.uHigh.value=high;
    uni.uPlaying.value=playing; uni.uMix.value=mixP;
    uni.uHalfWA.value=A.halfW; uni.uHalfWB.value=B.halfW;

    /* tiles: lerp/slerp between slots, lift and tint under the crest, flood
       with the incoming tone, dissolve mid-morph */
    const crest=-1.45+2.9*(wave<0?-1:wave), split=-1.6+3.2*mixP;
    const colA=uni.uColA.value, colIn=uni.uColIn.value;
    const ic=tiles.instanceColor.array, halfW=A.halfW+(B.halfW-A.halfW)*m;
    const ap=A.tile.pos,bp=B.tile.pos,ad=A.tile.dir,bd=B.tile.dir,aq=A.tile.quat,bq=B.tile.quat,as=A.tile.size,bs=B.tile.size,ax=A.tile.x,bx=B.tile.x;
    const shrink=1-0.85*dis;
    for(let k=0;k<TR*TA;k++){
      const k3=k*3,k4=k*4;
      const cx=ap[k3]+(bp[k3]-ap[k3])*m, cy=ap[k3+1]+(bp[k3+1]-ap[k3+1])*m, cz=ap[k3+2]+(bp[k3+2]-ap[k3+2])*m;
      let dx=ad[k3]+(bd[k3]-ad[k3])*m, dy=ad[k3+1]+(bd[k3+1]-ad[k3+1])*m, dz=ad[k3+2]+(bd[k3+2]-ad[k3+2])*m;
      const dl=Math.hypot(dx,dy,dz)||1; dx/=dl;dy/=dl;dz/=dl;
      const near=Math.max(0,1-Math.abs(cx/halfW-crest)/0.55)*playing;
      const rad=ax[k]+(bx[k]-ax[k])*m+near*(0.05+beat*0.06)+bass*0.012;
      _pos.set(cx+dx*rad,cy+dy*rad,cz+dz*rad);
      if(m<=0){_qa.set(aq[k4],aq[k4+1],aq[k4+2],aq[k4+3]);}
      else if(m>=1){_qa.set(bq[k4],bq[k4+1],bq[k4+2],bq[k4+3]);}
      else{_qa.set(aq[k4],aq[k4+1],aq[k4+2],aq[k4+3]);_qb.set(bq[k4],bq[k4+1],bq[k4+2],bq[k4+3]);_qa.slerp(_qb,m);}
      _sc.set((as[k3]+(bs[k3]-as[k3])*m)*shrink,(as[k3+1]+(bs[k3+1]-as[k3+1])*m)*shrink,(as[k3+2]+(bs[k3+2]-as[k3+2])*m)*shrink);
      _mm.compose(_pos,_qa,_sc); tiles.setMatrixAt(k,_mm);
      const old=Math.max(0,Math.min(1,(cx/halfW-split)/0.3+0.5));
      _c.copy(colIn).lerp(colA,old); _c.lerp(white,1-Math.min(1,near*1.15));
      ic[k3]=_c.r; ic[k3+1]=_c.g; ic[k3+2]=_c.b;
    }
    tiles.instanceMatrix.needsUpdate=true; tiles.instanceColor.needsUpdate=true;
    tileMat.emissiveIntensity=0.5+level*0.8+beat*0.6+dis*0.5;

    /* framing follows the morph; never edge-on: yaw sway, tilt from above, parallax */
    distT=fitDist(A.halfW+(B.halfW-A.halfW)*m,A.halfH+(B.halfH-A.halfH)*m);
    dist+=(distT-dist)*0.08;
    cam.position.set(0,0,dist); cam.lookAt(0,0,0);
    const tilt=A.tilt+(B.tilt-A.tilt)*m;
    group.rotation.y=Math.sin(t*0.19)*0.34+px*0.16+dis*0.35;
    group.rotation.x=tilt+Math.sin(t*0.11)*0.07-py*0.10;
    group.rotation.z=Math.sin(t*0.07)*0.04;

    renderer.render(scene,cam);
  }
  let raf=0;
  const stats={frames:0,ms:0};                    /* cpu time per frame, for tuning */
  (function loop(ts){const t0=performance.now();frame((ts||0)*0.001);stats.ms+=performance.now()-t0;stats.frames++;raf=requestAnimationFrame(loop);})();

  /* ═══ shape API ═══ */
  function commit(){ copySlot(B,A); markDirty(A); morph=morphT=0; mode='idle'; }
  function loadB(name){
    const shape=SHAPES[name]; if(!shape)return false;
    if(morph>0){bake(Math.max(0,Math.min(1,morph)));markDirty(A);}
    const align=S.alignTo(shape,A.rings,SR);
    fillSlot(B,shape,align); markDirty(B);
    morph=morphT=0; return true;
  }
  const api={
    get shape(){return morph>=0.5?B.name:A.name;},
    get morph(){return morph;},
    /* jump straight to a shape */
    setShape(name){ const s=SHAPES[name]; if(!s)return; fillSlot(A,s,null); copySlot(A,B); markDirty(A); markDirty(B); morph=morphT=0; mode='idle'; dist=distT=fitDist(A.halfW,A.halfH); },
    /* prepare a morph. With seconds it runs on its own clock; without, feed setMorph(). */
    morphTo(name,o={}){
      if(!SHAPES[name])return false;
      const inFlight=mode!=='idle'&&morph>0.001;
      if(!inFlight&&name===A.name){ mode='idle'; morph=morphT=0; return false; }   /* already there */
      if(inFlight&&name===B.name&&mode!=='rev'){                                   /* already heading there */
        if(o.seconds){mode='auto';autoSecs=o.seconds;clock0=performance.now();clockFrom=morph;} else mode='ext';
        return true;
      }
      loadB(name);                                    /* bakes any half-morph into A first */
      if(o.seconds){mode='auto';autoSecs=o.seconds;clock0=performance.now();clockFrom=0;} else mode='ext';
      return true;
    },
    setMorph(p){ if(mode!=='ext')return; morphT=smooth(Math.max(0,Math.min(1,p))); },
    commit(){ if(mode==='idle')return; morphT=1;morph=1; commit(); },
    reverse(){ if(mode==='ext'||mode==='auto'){mode='rev';morphT=morph;clock0=performance.now();clockFrom=morph;} },

    /* ═══ music API (unchanged) ═══ */
    setTone(tn){ tgtA.setHex(tn.main); tgtB.setHex(tn.l1); if(!mixing){uni.uColIn.value.copy(tgtA);uni.uColInB.value.copy(tgtB);} },
    setMix(progress,toneIn){
      if(progress==null||!toneIn){ mixing=false; mixT=0; if(mixP<0.02)mixP=0; return; }
      if(!mixing){ mixing=true; uni.uColIn.value.setHex(toneIn.main); uni.uColInB.value.setHex(toneIn.l1); }
      mixT=Math.max(0,progress);
    },
    commitMix(tn){ mixing=false; tgtA.setHex(tn.main); tgtB.setHex(tn.l1);
      uni.uColA.value.copy(tgtA); uni.uColB.value.copy(tgtB); uni.uColIn.value.copy(tgtA); uni.uColInB.value.copy(tgtB);
      mixP=0; mixT=0; },
    setBeat(beatPos){
      if(beatPos==null){waveT=-1;return;}
      const b=Math.floor(beatPos);
      if(b!==lastBeat){ if(lastBeat>=0&&b>lastBeat)beat=1; lastBeat=b; }
      waveT=((beatPos%4)+4)%4/4;
    },
    setAudio(l,b,mm,h){ lvT=l; bsT=b; mdT=mm; hiT=h; },
    setPlaying(on){ playT=on?1:0; if(!on){waveT=-1;} },
    resize, stats,
    dispose(){ cancelAnimationFrame(raf); renderer.dispose(); }
  };
  return api;
};
})();
