// Deterministic CAD projection and foreground shape matching. No image coordinates are hardcoded.
export const identity=[1,0,0,0,0,1,0,0,0,0,1,0];
const transform=(m,p)=>[m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3],m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7],m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11]];
function compose(a,b){const o=[];for(let r=0;r<3;r++){for(let c=0;c<3;c++)o.push(a[r*4]*b[c]+a[r*4+1]*b[4+c]+a[r*4+2]*b[8+c]);o.push(a[r*4]*b[3]+a[r*4+1]*b[7]+a[r*4+2]*b[11]+a[r*4+3]);}return o;}
export async function parseLDraw(text,resolve){
 const triangles=[],studs=[];let faces=0;
 async function visit(src,m,chain){
  if(chain.length>40)throw Error('LDraw subpart nesting is too deep.');
  const refs=[];
  for(const line of src.split(/\r?\n/)){const t=line.trim().split(/\s+/),kind=t[0];
   if(kind==='1'&&t.length>=15){const v=t.slice(2,14).map(Number);if(!v.every(Number.isFinite))throw Error('Invalid transform in model.');const name=t.slice(14).join(' ').toLowerCase().replaceAll('\\','/');if(chain.includes(name))throw Error('Circular LDraw dependency: '+name);const b=[v[3],v[4],v[5],v[0],v[6],v[7],v[8],v[1],v[9],v[10],v[11],v[2]];const combined=compose(m,b);if(name==='stud.dat'&&Math.abs(combined[5]-1)<.001&&Math.abs(combined[1])+Math.abs(combined[9])<.001)studs.push(transform(combined,[0,0,0]));refs.push([name,combined]);}
   if(kind==='3'||kind==='4'){const n=kind==='3'?3:4,v=t.slice(2,2+n*3).map(Number);if(v.length!==n*3||!v.every(Number.isFinite))throw Error('Invalid face in model.');const p=Array.from({length:n},(_,i)=>transform(m,v.slice(i*3,i*3+3)));triangles.push(...p[0],...p[1],...p[2]);if(n===4)triangles.push(...p[0],...p[2],...p[3]);if(++faces>120000)throw Error('This model is too complex. Upload one part, not an assembly.');}
  }
  for(const [name,matrix] of refs)await visit(await resolve(name),matrix,[...chain,name]);
 }
 await visit(text,identity,[]);if(!triangles.length)throw Error('No surface geometry found in this file.');
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<triangles.length;i++) {const j=i%3;min[j]=Math.min(min[j],triangles[i]);max[j]=Math.max(max[j],triangles[i]);}
 const centre=min.map((x,i)=>(x+max[i])/2);for(let i=0;i<triangles.length;i++)triangles[i]-=centre[i%3];
 return {studs:studs.map(p=>[p[0]-centre[0],max[1]-p[1],p[2]-centre[2]]),vertices:new Float32Array(triangles),size:max.map((x,i)=>x-min[i]),name:(text.split(/\r?\n/).find(l=>/^0\s+[^!]/.test(l))||'LDraw part').replace(/^0\s*/,''),faces:triangles.length/9};
}
export function project(model,yaw,elevation){const {vertices:v}=model,cy=Math.cos(yaw),sy=Math.sin(yaw),ce=Math.cos(elevation),se=Math.sin(elevation),out=new Float32Array(v.length);for(let i=0;i<v.length;i+=3){const x=v[i],y=-v[i+1],z=v[i+2];out[i]=cy*x-sy*z;out[i+1]=-(se*(sy*x+cy*z)+ce*y);out[i+2]=ce*(sy*x+cy*z)-se*y;}return out;}
export function drawModel(canvas,model,yaw,elevation,silhouette=false){const p=project(model,yaw,elevation);let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(let i=0;i<p.length;i+=3){x0=Math.min(x0,p[i]);x1=Math.max(x1,p[i]);y0=Math.min(y0,p[i+1]);y1=Math.max(y1,p[i+1]);}const w=canvas.width,h=canvas.height,s=.83*Math.min(w/Math.max(x1-x0,.01),h/Math.max(y1-y0,.01)),ox=w/2-(x0+x1)*s/2,oy=h/2-(y0+y1)*s/2,ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.clearRect(0,0,w,h);ctx.fillStyle=silhouette?'black':'#edf2f8';ctx.fillRect(0,0,w,h);const order=Array.from({length:p.length/9},(_,i)=>i*9);if(!silhouette)order.sort((a,b)=>(p[b+2]+p[b+5]+p[b+8])-(p[a+2]+p[a+5]+p[a+8]));for(const i of order){if(silhouette)ctx.fillStyle='white';else{const ax=p[i+3]-p[i],ay=p[i+4]-p[i+1],az=p[i+5]-p[i+2],bx=p[i+6]-p[i],by=p[i+7]-p[i+1],bz=p[i+8]-p[i+2],nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,len=Math.hypot(nx,ny,nz)||1,light=.5+.5*Math.abs((-.3*nx-.5*ny+.8*nz)/len);ctx.fillStyle=`rgb(${Math.round(30+light*45)},${Math.round(70+light*70)},${Math.round(170+light*75)})`;}
 ctx.beginPath();ctx.moveTo(p[i]*s+ox,p[i+1]*s+oy);ctx.lineTo(p[i+3]*s+ox,p[i+4]*s+oy);ctx.lineTo(p[i+6]*s+ox,p[i+7]*s+oy);ctx.closePath();ctx.fill();if(!silhouette){ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.35;ctx.stroke();}}
 ctx.projectedScale=s;ctx.projectedBoxArea=(x1-x0)*(y1-y0);return ctx;
}

