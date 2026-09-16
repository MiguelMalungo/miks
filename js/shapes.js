/* ═══════════════════════════ the shapes ═══════════════════════════
   Six figures, each a set of tube paths in one shared unit system (the
   infinity is 2.6 units to each side). A shape is pure geometry: the
   renderer (figure.js) samples it into ring tables — centre, frame, radius
   per ring — and builds the occluder, the tiles and the swarm from those.
   Because every shape is sampled to the same ring counts, a morph is a
   straight lerp between two tables.

   Path: {curve: THREE.Curve, closed: bool, r: tube radius}
   Shape: {name, paths, tilt}                                                */
(function(){
'use strict';
const MIKS=window.MIKS=window.MIKS||{};
const THREE=window.THREE; if(!THREE)return;
const V=(x,y,z=0)=>new THREE.Vector3(x,y,z);

/* ── analytic curves ─────────────────────────────────────────────── */
class Lemniscate extends THREE.Curve{
  constructor(a,lift){super();this.a=a;this.lift=lift;}
  getPoint(t,o=new THREE.Vector3()){
    const th=t*Math.PI*2,s=Math.sin(th),c=Math.cos(th),d=1+s*s;
    return o.set(this.a*c/d,this.a*s*c/d,this.lift*Math.sin(th));
  }
}
class Ring extends THREE.Curve{
  /* a circle with a sinusoidal lift: weave=2 makes it pass over then under
     twice per turn, which is what three overlapping rings need */
  constructor(cx,cy,rad,lift=0,weave=0,phase=0,z=0){super();Object.assign(this,{cx,cy,rad,lift,weave,phase,z});}
  getPoint(t,o=new THREE.Vector3()){
    const th=t*Math.PI*2+this.phase;
    return o.set(this.cx+Math.cos(th)*this.rad,this.cy+Math.sin(th)*this.rad,
                 this.z+this.lift*Math.sin(this.weave*th));
  }
}
class Trefoil extends THREE.Curve{
  constructor(s,zs){super();this.s=s;this.zs=zs;}
  getPoint(t,o=new THREE.Vector3()){
    const th=t*Math.PI*2;
    return o.set(this.s*(Math.sin(th)+2*Math.sin(2*th)),
                 this.s*(Math.cos(th)-2*Math.cos(2*th)),
                 this.zs*-Math.sin(3*th));
  }
}
const spline=(pts,closed)=>new THREE.CatmullRomCurve3(pts,closed,'centripetal',0.5);
const rot=(pts,deg)=>{const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return pts.map(p=>V(p.x*c-p.y*s,p.x*s+p.y*c,p.z));};
const mirror=pts=>pts.map(p=>V(-p.x,p.y,p.z));

/* ── the shapes — every tube the infinity's diameter ─────────────── */
const R=0.44;                                    /* one pipe radius for all */
const SHAPES={};

SHAPES.infinity={
  name:'infinity', tilt:0.42,
  paths:[{curve:new Lemniscate(2.6,0.36),closed:true,r:R}]
};

/* three rings on a triangle, each weaving over and under its neighbours */
SHAPES.rings=(()=>{
  const RR=1.3, d=0.95, dy=-0.2;                          /* circle radius, triangle circumradius */
  const c=[[0,d+dy],[-d*0.866,-d*0.5+dy],[d*0.866,-d*0.5+dy]];
  return {name:'rings', tilt:0.22,
    paths:c.map((p,k)=>({curve:new Ring(p[0],p[1],RR,0.34,2,k*Math.PI*2/3),closed:true,r:R}))};
})();

/* the triquetra as a trefoil knot: three interlaced lobes, one closed curve */
SHAPES.trefoil={
  name:'trefoil', tilt:0.36,
  paths:[{curve:new Trefoil(0.74,0.62),closed:true,r:R}]
};

/* triskelion: three arms sweeping out from the centre and curling in */
SHAPES.triskelion=(()=>{
  const arm=[V(0,0,0),V(0.18,0.8,0.05),V(0.58,1.65,0.10),V(1.22,2.22,0.14),V(1.98,2.3,0.16),
             V(2.5,1.82,0.14),V(2.34,1.2,0.10),V(1.78,1.12,0.06),V(1.6,1.5,0.04),V(1.82,1.82,0.02)]
             .map(p=>V(p.x*0.86,p.y*0.86,p.z));
  return {name:'triskelion', tilt:0.34,
    paths:[0,120,240].map(a=>({curve:spline(rot(arm,a),false),closed:false,r:R}))};
})();

/* six-pointed star as one line: the outer outline of the two triangles.
   Extra points near each corner keep the edges straight and only round
   the tips, so the tiles run clean along the sides. */
SHAPES.star=(()=>{
  const RO=2.35, RI=RO/Math.sqrt(3), pts=[];
  const v=[];
  for(let k=0;k<12;k++){const a=Math.PI/2+k*Math.PI/6, r=k%2?RI:RO; v.push([Math.cos(a)*r,Math.sin(a)*r]);}
  for(let k=0;k<12;k++){
    const a=v[k], b=v[(k+1)%12];
    pts.push(V(a[0],a[1]));
    pts.push(V(a[0]+(b[0]-a[0])*0.14,a[1]+(b[1]-a[1])*0.14));
    pts.push(V(a[0]+(b[0]-a[0])*0.86,a[1]+(b[1]-a[1])*0.86));
  }
  return {name:'star', tilt:0.30, paths:[{curve:spline(pts,true),closed:true,r:R}]};
})();

/* twin loops: two tall ovals, an S sweeping through the middle, a ball at
   the heart — the S sits forward so it passes over both ovals */
SHAPES.loops=(()=>{
  const oval=(cx,sx,sy)=>new (class extends THREE.Curve{getPoint(t,o=new THREE.Vector3()){
    const th=t*Math.PI*2; return o.set(cx+Math.cos(th)*sx,Math.sin(th)*sy,0.0);}})();
  const S=[V(-0.7,2.15,0.5),V(-1.3,1.3,0.48),V(-1.05,0.4,0.46),V(0,0.0,0.48),V(1.05,-0.4,0.46),V(1.3,-1.3,0.48),V(0.7,-2.15,0.5)];
  return {name:'loops', tilt:0.26,
    paths:[
      {curve:oval(-0.9,1.2,2.2),closed:true,r:R},
      {curve:oval(0.9,1.2,2.2),closed:true,r:R},
      {curve:spline(S,false),closed:false,r:R},
      {curve:new Ring(0,0,0.2,0,0,0,0.75),closed:true,r:R}
    ]};
})();

/* the stacked figure: three lobes, each a loop whose hole is the original
   cutout — a rounded diamond, two ovals side by side, a diamond — fused
   by the fat pipes into one body */
SHAPES.totem=(()=>{
  const oval=(cx,cy,sx,sy,z=0)=>new (class extends THREE.Curve{getPoint(t,o=new THREE.Vector3()){
    const th=t*Math.PI*2; return o.set(cx+Math.cos(th)*sx,cy+Math.sin(th)*sy,z);}})();
  const diamond=sgn=>[V(0,sgn*2.55),V(0.62,sgn*1.95),V(1.15,sgn*1.55),V(0.62,sgn*1.15),V(0,sgn*0.62),V(-0.62,sgn*1.15),V(-1.15,sgn*1.55),V(-0.62,sgn*1.95)];
  return {name:'totem', tilt:0.2,
    paths:[
      {curve:spline(diamond(1),true),closed:true,r:R},
      {curve:oval(-0.98,0,0.9,0.92,0.12),closed:true,r:R},
      {curve:oval(0.98,0,0.9,0.92,-0.12),closed:true,r:R},
      {curve:spline(diamond(-1),true),closed:true,r:R}
    ]};
})();

/* one ring around a sphere: the sphere is a spindle torus — a tiny circle
   with a tube fatter than its radius, which closes into a ball */
SHAPES.target={
  name:'target', tilt:0.34,
  paths:[
    {curve:new Ring(0,0,2.05,0,0,0,0),closed:true,r:R},
    {curve:new Ring(0,0,0.34,0,0,0,0),closed:true,r:R}
  ]
};

MIKS.SHAPES=SHAPES;
MIKS.SHAPE_ORDER=['infinity','rings','trefoil','triskelion','star','loops','totem','target'];

/* ── sampling ────────────────────────────────────────────────────── */
/* Split n rings across the paths in proportion to length (floor of 6 each). */
function allocate(shape,n){
  const lens=shape.paths.map(p=>p.curve.getLength());
  const total=lens.reduce((a,b)=>a+b,0);
  const MIN=Math.min(6,Math.floor(n/shape.paths.length));
  let counts=lens.map(l=>Math.max(MIN,Math.round(l/total*n)));
  let diff=n-counts.reduce((a,b)=>a+b,0);
  /* settle the rounding on the longest paths */
  const order=lens.map((l,i)=>i).sort((a,b)=>lens[b]-lens[a]);
  let k=0;
  while(diff!==0){const i=order[k%order.length];
    if(diff>0){counts[i]++;diff--;}else if(counts[i]>MIN){counts[i]--;diff++;}
    k++; if(k>n*4)break;}
  return {counts,lens};
}

/* Rotation-minimising frames along an arbitrary sequence of u values —
   parallel transport, closed with a distributed twist like three's own. */
function frames(curve,us,closed){
  const k=us.length, T=[],N=[],B=[];
  for(let i=0;i<k;i++)T.push(curve.getTangentAt(us[i]).normalize());
  /* first normal: any perpendicular */
  let n0=new THREE.Vector3(0,0,1);
  if(Math.abs(T[0].dot(n0))>0.9)n0.set(0,1,0);
  N.push(n0.clone().sub(T[0].clone().multiplyScalar(T[0].dot(n0))).normalize());
  B.push(new THREE.Vector3().crossVectors(T[0],N[0]));
  const axis=new THREE.Vector3(), q=new THREE.Quaternion();
  for(let i=1;i<k;i++){
    N.push(N[i-1].clone());
    axis.crossVectors(T[i-1],T[i]);
    if(axis.length()>1e-6){
      axis.normalize();
      const th=Math.acos(Math.max(-1,Math.min(1,T[i-1].dot(T[i]))));
      N[i].applyQuaternion(q.setFromAxisAngle(axis,th));
    }
    N[i].sub(T[i].clone().multiplyScalar(T[i].dot(N[i]))).normalize();
    B.push(new THREE.Vector3().crossVectors(T[i],N[i]));
  }
  if(closed){
    /* rotate the last frame onto the first and spread the difference */
    const last=N[k-1].clone(); axis.crossVectors(T[k-1],T[0]);
    if(axis.length()>1e-6){axis.normalize();
      const th=Math.acos(Math.max(-1,Math.min(1,T[k-1].dot(T[0]))));
      last.applyQuaternion(q.setFromAxisAngle(axis,th));}
    let tw=Math.acos(Math.max(-1,Math.min(1,N[0].dot(last))));
    if(new THREE.Vector3().crossVectors(N[0],last).dot(T[0])>0)tw=-tw;
    for(let i=1;i<k;i++){
      N[i].applyQuaternion(q.setFromAxisAngle(T[i],tw*i/k));
      B[i].crossVectors(T[i],N[i]);
    }
  }
  return {T,N,B};
}

/* Sample a shape into n rings. align = per-path {du, rev} (optional).
   Returns flat tables: center(n*3) N(n*3) B(n*3) r(n) path(n) u(n),
   plus per-path blocks and the bounding half-extents. */
function sample(shape,n,align){
  const {counts,lens}=allocate(shape,n);
  const center=new Float32Array(n*3),NN=new Float32Array(n*3),BB=new Float32Array(n*3),
        rr=new Float32Array(n),path=new Uint16Array(n),uu=new Float32Array(n),
        spacing=new Float32Array(n);
  const blocks=[]; let i0=0, maxX=0,maxY=0,maxR=0;
  shape.paths.forEach((p,pi)=>{
    const k=counts[pi], a=(align&&align[pi])||{du:0,rev:false};
    const us=[];
    for(let j=0;j<k;j++){
      let u=p.closed? j/k : j/(k-1);
      if(p.closed){u=(u+a.du)%1; if(a.rev)u=(1-u)%1;}
      else if(a.rev)u=1-u;
      us.push(Math.min(1,Math.max(0,u)));
    }
    const fr=frames(p.curve,us,p.closed);
    for(let j=0;j<k;j++){
      const i=i0+j, c=p.curve.getPointAt(us[j]);
      center[i*3]=c.x;center[i*3+1]=c.y;center[i*3+2]=c.z;
      NN[i*3]=fr.N[j].x;NN[i*3+1]=fr.N[j].y;NN[i*3+2]=fr.N[j].z;
      BB[i*3]=fr.B[j].x;BB[i*3+1]=fr.B[j].y;BB[i*3+2]=fr.B[j].z;
      rr[i]=p.r; path[i]=pi; uu[i]=us[j]; spacing[i]=lens[pi]/(p.closed?k:k-1);
      maxX=Math.max(maxX,Math.abs(c.x)+p.r); maxY=Math.max(maxY,Math.abs(c.y)+p.r); maxR=Math.max(maxR,p.r);
    }
    blocks.push({start:i0,count:k,closed:p.closed});
    i0+=k;
  });
  return {n,center,N:NN,B:BB,r:rr,path,u:uu,spacing,blocks,halfW:maxX,halfH:maxY,maxR,tilt:shape.tilt,name:shape.name};
}

/* Choose, per path, the start offset (and direction) that makes the
   incoming rings land nearest the rings they inherit — a swirl instead of
   a shuffle. Compared at the resolution given; applied at every one. */
function alignTo(shape,from,n){
  const plain=sample(shape,n,null);
  const align=[];
  plain.blocks.forEach((b,pi)=>{
    const k=b.count, step=Math.max(1,Math.floor(k/48));
    let best=Infinity, bo=0, br=false;
    const offsets=b.closed?[]:[0]; if(b.closed)for(let o=0;o<k;o+=step)offsets.push(o);
    for(const rev of [false,true])for(const o of offsets){
      let cost=0;
      for(let j=0;j<k;j++){
        let jj=b.closed?(j+o)%k:j; if(rev)jj=b.closed?(k-jj)%k:(k-1-j);
        const s=(b.start+jj)*3, d=(b.start+j)*3;
        const dx=plain.center[s]-from.center[d],dy=plain.center[s+1]-from.center[d+1],dz=plain.center[s+2]-from.center[d+2];
        cost+=Math.sqrt(dx*dx+dy*dy+dz*dz);
      }
      if(cost<best){best=cost;bo=o;br=rev;}
    }
    align.push({du:bo/k,rev:br});
  });
  return align;
}

MIKS.shapes={sample,alignTo,allocate,frames};
})();
