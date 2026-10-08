// Surface evidence complements (and does not replace) the silhouette index.
// A failed detector means unknown, never "zero studs".
export function alignedCrop(image,component,maxSize=256){
  const {pixels}=component,w=image.width;let cx=0,cy=0;
  for(const p of pixels){cx+=p%w;cy+=Math.floor(p/w);}cx/=pixels.length;cy/=pixels.length;
  let xx=0,xy=0,yy=0;for(const p of pixels){const x=p%w-cx,y=Math.floor(p/w)-cy;xx+=x*x;xy+=x*y;yy+=y*y;}
  const angle=.5*Math.atan2(2*xy,xx-yy),c=Math.cos(angle),s=Math.sin(angle);
  let lo=Infinity,hi=-Infinity,left=Infinity,right=-Infinity;
  for(const p of pixels){const x=p%w-cx,y=Math.floor(p/w)-cy,u=x*c+y*s,v=-x*s+y*c;lo=Math.min(lo,u);hi=Math.max(hi,u);left=Math.min(left,v);right=Math.max(right,v);}
  const scale=Math.min(1,(maxSize-8)/Math.max(hi-lo,right-left,1)),width=Math.ceil((right-left)*scale)+9,height=Math.ceil((hi-lo)*scale)+9,gray=new Float32Array(width*height),mask=new Uint8Array(width*height),membership=new Set(pixels);
  // Major PCA coordinate -> y. One inverse mapping, one bilinear resample.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const u=(y-4)/scale+lo,v=(x-4)/scale+left,sx=cx+u*c-v*s,sy=cy+u*s+v*c,ix=Math.floor(sx),iy=Math.floor(sy),dx=sx-ix,dy=sy-iy,k=y*width+x;
    if(ix<0||iy<0||ix+1>=w||iy+1>=image.height)continue;
    mask[k]=membership.has(Math.round(sy)*w+Math.round(sx))?1:0;
    const l=p=>image.data[p*4]*.299+image.data[p*4+1]*.587+image.data[p*4+2]*.114;
    gray[k]=(1-dy)*((1-dx)*l(iy*w+ix)+dx*l(iy*w+ix+1))+dy*((1-dx)*l((iy+1)*w+ix)+dx*l((iy+1)*w+ix+1));
  }
  return {gray,mask,width,height,angle,scale,cx,cy,lo,left};
}
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]||0;};
const spacing=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/4)]||0;};
function axisEstimate(vectors){const p=spacing(vectors.map(v=>v.d)),near=vectors.filter(v=>Math.abs(v.d-p)<p*.25);let x=0,y=0;for(const v of near){const a=Math.atan2(v.dy,v.dx);x+=Math.cos(2*a);y+=Math.sin(2*a);}let angle=Math.atan2(y,x)/2;if(angle<0)angle+=Math.PI;return {angle,pitch:median(near.map(v=>v.d))};}
// Validate repeated spacing along two directions. Isolated logos/shadows do
// not supply enough evidence to constrain a part's surface topology.
export function lattice(points,{allowThree=false}={}){
  if(points.length<(allowThree?3:4))return null;
  const vectors=[];
  for(const a of points){const near=points.filter(b=>a!==b).map(b=>({dx:b.x-a.x,dy:b.y-a.y,d:Math.hypot(b.x-a.x,b.y-a.y)})).sort((a,b)=>a.d-b.d).slice(0,4);vectors.push(...near);}
  const bins=new Map();for(const v of vectors){let angle=Math.atan2(v.dy,v.dx);if(angle<0)angle+=Math.PI;const key=Math.round(angle/(Math.PI/18))%18;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(v);}
  const axes=[...bins.entries()].sort((a,b)=>b[1].length-a[1].length);let best=null;
  for(const [a,va] of axes.slice(0,4))for(const [b,vb] of axes.slice(0,6)){
    let delta=Math.abs(a-b)*Math.PI/18;delta=Math.min(delta,Math.PI-delta);if(delta<Math.PI/4)continue;
    const ea=axisEstimate(va),eb=axisEstimate(vb),aa=ea.angle,bb=eb.angle,pa=ea.pitch,pb=eb.pitch;if(pa<5||pb<5)continue;
    const ax=Math.cos(aa)*pa,ay=Math.sin(aa)*pa,bx=Math.cos(bb)*pb,by=Math.sin(bb)*pb,det=ax*by-ay*bx;if(Math.abs(det)<1)continue;
    for(const origin of points.slice(0,8)){
      const cells=new Map();for(const p of points){const x=p.x-origin.x,y=p.y-origin.y,u=(x*by-y*bx)/det,v=(y*ax-x*ay)/det,iu=Math.round(u),iv=Math.round(v);if(Math.hypot(u-iu,v-iv)<.24)cells.set(iu+','+iv,{u:iu,v:iv,p});}
      const kept=[...cells.values()];if(kept.length<4)continue;
      const rows=Math.max(...kept.map(c=>c.u))-Math.min(...kept.map(c=>c.u))+1,columns=Math.max(...kept.map(c=>c.v))-Math.min(...kept.map(c=>c.v))+1;
      if(rows<2||columns<2)continue;const completeness=kept.length/(rows*columns),support=kept.length/points.length,quality=completeness*support;
      if(completeness>=.7&&support>=.65&&(!best||kept.length*quality>best.count*best.quality))best={count:kept.length,grid:[rows,columns].sort((a,b)=>a-b),completeness,support,quality,points:kept.map(c=>c.p),basis:[ax,ay,bx,by]};
    }
  }
  if(!best)for(const [axis,vs] of axes.slice(0,3)){
    const {angle,pitch}=axisEstimate(vs),c=Math.cos(angle),s=Math.sin(angle);
    for(const origin of points.slice(0,8)){
      const cells=new Map();for(const p of points){const x=p.x-origin.x,y=p.y-origin.y,u=(x*c+y*s)/pitch,v=(-x*s+y*c)/pitch,k=Math.round(u);if(Math.abs(u-k)<.2&&Math.abs(v)<.2)cells.set(k,p);}
      const count=cells.size,keys=[...cells.keys()],span=Math.max(...keys)-Math.min(...keys)+1,completeness=count/span,support=count/points.length;
      if(count>=(allowThree?3:4)&&completeness>=.8&&support>=.8&&(!best||count>best.count))best={count,grid:[1,span],completeness,support,quality:completeness*support*.85,points:[...cells.values()],basis:[pitch*c,pitch*s,-pitch*s,pitch*c]};
    }
  }
  return best;
}
export function detectSurface(image,component,diagnostics=false){
  const crop=alignedCrop(image,component),{gray,mask,width:w,height:h}=crop,gx=new Float32Array(w*h),gy=new Float32Array(w*h),edges=[];
  for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){const k=y*w+x;if(!mask[k]||!mask[k-2]||!mask[k+2]||!mask[k-2*w]||!mask[k+2*w])continue;gx[k]=(gray[k+1]-gray[k-1])/2;gy[k]=(gray[k+w]-gray[k-w])/2;const mag=Math.hypot(gx[k],gy[k]);if(mag>1.5)edges.push({x,y,gx:gx[k]/mag,gy:gy[k]/mag,mag});}
  if(edges.length<24)return {count:null,confidence:0,reason:'No reliable repeated circular features'};
  const threshold=Math.max(2,median(edges.map(e=>e.mag))*.6),strong=edges.filter(e=>e.mag>=threshold),all=[];
  const maxRadius=Math.min(18,Math.floor(Math.min(w,h)/5));
  // Ellipse gradient voting; polarity-independent so lit studs and dark tubes
  // can both contribute. Aspect ratios cover moderate foreshortening.
  for(const aspect of [1,.7,1.4])for(let r=3;r<=maxRadius;r+=1){
    const votes=new Uint16Array(w*h),rx=r,ry=r*aspect;
    for(const e of strong){const norm=Math.hypot(rx*e.gx,ry*e.gy),dx=rx*rx*e.gx/norm,dy=ry*ry*e.gy/norm;for(const sign of [-1,1]){const x=Math.round(e.x+sign*dx),y=Math.round(e.y+sign*dy);if(x>1&&y>1&&x<w-2&&y<h-2&&mask[y*w+x])votes[y*w+x]++;}}
    const minimum=Math.max(5,Math.round(r*.7));
    for(let y=Math.ceil(ry)+2;y<h-ry-2;y++)for(let x=r+2;x<w-r-2;x++){
      const k=y*w+x,v=votes[k];if(v<minimum||v<votes[k-1]||v<votes[k+1]||v<votes[k-w]||v<votes[k+w])continue;
      let support=0,inside=0;
      for(let j=0;j<16;j++){const angle=j*Math.PI/8,dx=rx*Math.cos(angle),dy=ry*Math.sin(angle),nx=Math.cos(angle)/rx,ny=Math.sin(angle)/ry;let response=0;
        for(const scale of [.85,1,1.15]){const xx=Math.round(x+dx*scale),yy=Math.round(y+dy*scale),p=yy*w+xx;if(mask[p])inside++;response=Math.max(response,Math.abs(gx[p]*nx+gy[p]*ny)/(Math.hypot(nx,ny)||1));}
        if(response>threshold*.55)support++;
      }
      if(support>=11&&inside>=44)all.push({x,y,r,aspect,strength:support+v/16});
    }
  }
  all.sort((a,b)=>b.strength-a.strength);const points=[];
  for(const p of all){if(points.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>Math.max(p.r,q.r)*1.2))points.push(p);if(points.length>=180)break;}
  const grid=lattice(points);if(!grid)return {count:null,confidence:0,reason:'Circular features do not form a reliable grid',detected:points.length,...(diagnostics?{points}: {})};
  const confidence=Math.min(.95,.55+.4*grid.quality);
  return {count:grid.count,grid:grid.grid,confidence,coverage:grid.completeness,kind:'stud-or-tube',points:grid.points.map(p=>({x:p.x,y:p.y})),alignment:{width:w,height:h,angle:crop.angle,scale:crop.scale,cx:crop.cx,cy:crop.cy,lo:crop.lo,left:crop.left}};
}
export function surfaceFromDetections(detections){
  const dots=[];
  for(const p of [...(detections||[])].sort((a,b)=>b.confidence-a.confidence)){
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.confidence)||p.confidence<.25)continue;
    if(dots.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>Math.max(p.radius||1,q.radius||1)*.8))dots.push(p);
  }
  if(!dots.length)return {count:null,confidence:0,source:'yolo',reason:'YOLO found no reliable studs; surface remains unknown'};
  const grid=lattice(dots),meanScore=dots.reduce((s,p)=>s+p.confidence,0)/dots.length;
  // YOLO scores are stored separately. Confidence here is a heuristic for
  // using the detected count: repeated geometry makes moderate scores useful.
  if(!grid)return {count:dots.length,confidence:.45,source:'yolo',kind:'studs',grid:null,points:dots,detectorScore:meanScore,reason:'Detected studs do not form a reliable grid'};
  return {count:grid.count,grid:grid.grid,confidence:Math.min(.95,.9*grid.quality*Math.min(1,meanScore/.4)),coverage:grid.completeness,
    source:'yolo',kind:'studs',points:grid.points,basis:grid.basis,detectorScore:meanScore};
}
export function surfaceFromTubes(detections,pixels,width){
  const dots=[];for(const p of [...(detections||[])].sort((a,b)=>b.confidence-a.confidence))if(p.confidence>=.7&&dots.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>Math.max(p.radius,q.radius)*.8))dots.push(p);
  const grid=lattice(dots,{allowThree:true});
  if(!grid||grid.completeness<.95||grid.support<.9)return null;
  let observed={count:grid.count,grid:grid.grid,confidence:Math.min(.9,.85*grid.completeness*grid.support),source:'tubes',kind:'tubes',points:grid.points,basis:grid.basis};
  observed=surfaceFootprint(observed,pixels,width);
  if(!observed.footprint)return null;
  const [u0,v0,u1,v1]=observed.footprint,spans=[u1-u0,v1-v0].sort((a,b)=>a-b),expected=grid.grid.map(n=>n+1),ratio=spans.map((n,i)=>n/expected[i]);
  // Require a complete centered grid inside an approximately rectangular
  // body. Missing/occluded tubes cannot justify the +1-per-axis inference.
  const det=observed.basis[0]*observed.basis[3]-observed.basis[1]*observed.basis[2],fill=pixels.length/Math.abs(det)/((u1-u0)*(v1-v0));
  const pitch=Math.min(Math.hypot(...observed.basis.slice(0,2)),Math.hypot(...observed.basis.slice(2)));
  if(fill<.72||ratio.some(r=>r<.75||r>1.18)||Math.abs(u0+u1)>.5||Math.abs(v0+v1)>.5||grid.points.some(p=>p.radius/pitch<.15||p.radius/pitch>.45))return null;
  return {...observed,inferredStudGrid:expected,inferredStudCount:expected[0]*expected[1],inference:'Complete rectangular underside: one more stud position per axis than tubes'};
}
export function surfaceAgreement(observed,expected){
  if(!observed?.count||observed.confidence<.7)return {penalty:0,face:null};
  if(!expected?.known)return {penalty:['yolo','tubes'].includes(observed.source)?.12*observed.confidence:0,face:null,reason:'CAD surface features are unknown'};
  const groups=(expected.groups||[]).filter(g=>observed.kind==='tubes'?g.kind==='tubes'&&g.face==='bottom':observed.source!=='yolo'||g.kind==='studs');if(!groups.length)return {penalty:.65*observed.confidence,face:null,reason:'Visible dot grid conflicts with a surface without known studs/tubes'};
  let best=null;for(const g of groups){const ratio=Math.min(g.count,observed.count)/Math.max(g.count,observed.count),grid=observed.grid&&g.grid?Math.min(...observed.grid.map((n,i)=>Math.min(n,g.grid[i])/Math.max(n,g.grid[i]))):ratio;
    const inferred=observed.inferredStudGrid,top=inferred&&(expected.groups||[]).some(t=>t.kind==='studs'&&t.face==='top'&&t.grid?.join(',')===inferred.join(',')&&t.count===observed.inferredStudCount);
    const penalty=(.4*(1-ratio)+.2*(1-grid)+(inferred&&!top?.25:0))*observed.confidence;if(!best||penalty<best.penalty)best={penalty,face:g.face,kind:g.kind,expectedCount:g.count,reason:`${observed.count} observed circular features; ${g.count} ${g.kind} in CAD`};}
  return best;
}
// Measure the body in stud-pitch units, not photo pixels. This prevents a
// small matching stud patch on an otherwise incompatible large part winning.
export function surfaceFootprint(surface,pixels,width){
  if(!['yolo','tubes'].includes(surface?.source)||surface.confidence<.7||!surface.basis)return surface;
  if(surface.source==='yolo'&&surface.grid?.[0]===1)return surface;
  const [ax,ay,bx,by]=surface.basis,det=ax*by-ay*bx;
  if(Math.abs(det)<1)return surface;
  const cx=surface.points.reduce((s,p)=>s+p.x,0)/surface.points.length,cy=surface.points.reduce((s,p)=>s+p.y,0)/surface.points.length;
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];
  for(const p of pixels){const x=p%width-cx,y=Math.floor(p/width)-cy,u=(x*by-y*bx)/det,v=(y*ax-x*ay)/det;bounds[0]=Math.min(bounds[0],u);bounds[1]=Math.min(bounds[1],v);bounds[2]=Math.max(bounds[2],u);bounds[3]=Math.max(bounds[3],v);}
  const trace=ax*ax+ay*ay+bx*bx+by*by,delta=Math.hypot(ax*ax+ay*ay-bx*bx-by*by,2*(ax*bx+ay*by));
  return {...surface,footprint:bounds,sinElevation:Math.sqrt(Math.max(0,(trace-delta)/(trace+delta)))};
}
export function surfaceGeometryAgreement(observed,expected,view){
  if(observed?.source!=='yolo'||!observed.footprint||!expected?.known||!expected.bounds)return 0;
  const groups=(expected.groups||[]).filter(g=>g.kind==='studs'&&g.face==='top'&&g.count===observed.count&&g.centres?.length===g.count&&g.grid?.join(',')===observed.grid?.join(','));
  if(!groups.length)return 0;
  const yaw=view.yaw*Math.PI/180,el=view.elevation*Math.PI/180,sy=Math.sin(yaw),cy=Math.cos(yaw),se=Math.sin(el),ce=Math.cos(el);
  const project=([x,y,z])=>[cy*x-sy*z,-se*(sy*x+cy*z)+ce*y];
  let best=Infinity;
  for(const group of groups){
    const centres=group.centres;
    if(Math.max(...centres.map(p=>p[1]))-Math.min(...centres.map(p=>p[1]))>.1)continue;
    const step=axis=>{const values=[...new Set(centres.map(p=>Math.round(p[axis]*100)/100))].sort((a,b)=>a-b);return values.length>1?median(values.slice(1).map((n,i)=>n-values[i])):0;};
    const sx=step(0),sz=step(2);if(!sx||!sz)continue;
    const [ax,ay]=project([sx,0,0]),[bx,by]=project([0,0,sz]),det=ax*by-ay*bx;if(Math.abs(det)<1)continue;
    const centre=project([0,1,2].map(axis=>centres.reduce((s,p)=>s+p[axis],0)/centres.length)),bounds=[Infinity,Infinity,-Infinity,-Infinity];
    for(let k=0;k<8;k++){const point=project([0,1,2].map(axis=>expected.bounds[axis+((k>>axis)&1)*3])),x=point[0]-centre[0],y=point[1]-centre[1],u=(x*by-y*bx)/det,v=(y*ax-x*ay)/det;bounds[0]=Math.min(bounds[0],u);bounds[1]=Math.min(bounds[1],v);bounds[2]=Math.max(bounds[2],u);bounds[3]=Math.max(bounds[3],v);}
    // Lattice axes have arbitrary order and signs; compare all symmetries.
    for(const swap of [false,true])for(const a of [-1,1])for(const b of [-1,1]){
      const u=swap?1:0,v=swap?0:1,actual=observed.footprint,loU=a>0?bounds[u]:-bounds[u+2],hiU=a>0?bounds[u+2]:-bounds[u],loV=b>0?bounds[v]:-bounds[v+2],hiV=b>0?bounds[v+2]:-bounds[v];
      const error=(Math.abs(actual[0]-loU)+Math.abs(actual[2]-hiU))/Math.max(1,actual[2]-actual[0])+(Math.abs(actual[1]-loV)+Math.abs(actual[3]-hiV))/Math.max(1,actual[3]-actual[1]);best=Math.min(best,error/2);
    }
  }
  if(!Number.isFinite(best))return 0;
  // Pose is only approximate (perspective/lens distortion), hence a soft cost.
  return observed.confidence*(.45*Math.min(1,best)+.25*Math.abs(se-observed.sinElevation));
}

