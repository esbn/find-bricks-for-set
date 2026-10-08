import {readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPartLibrary} from '../public/engine/part-library.mjs';
const root=new URL('../public/',import.meta.url);
const transform=(m,p)=>[m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3],m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7],m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11]];
export function surfaceExtractor(resolve){
  const memo=new Map();
  async function walk(name,chain=[]){
    if(chain.includes(name)||chain.length>40)throw Error('Circular or excessive CAD nesting');if(memo.has(name))return memo.get(name);
    const text=await resolve(name),header=text.split(/\r?\n/)[0];
    let captured;
    if(/^(?:8\/|48\/)?stud[^/]*\.dat$/.test(name)){
      const kind=/\bTube\b/.test(header)?'tubes':/\bStud\b/.test(header)?'studs':null;
      // Half/edge/logo-only primitives do not denote complete circular features.
      if(kind&&!/Half|Edge|Line|Logo Only|Duplo|Technic/i.test(header))captured=kind;
    }
    let known=!!captured||!/^(?:8\/|48\/)?stud/.test(name);const points=[],min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    const include=p=>p.forEach((x,i)=>{min[i]=Math.min(min[i],x);max[i]=Math.max(max[i],x);});
    for(const line of text.split(/\r?\n/)){const t=line.trim().split(/\s+/);
      if(t[0]==='3'||t[0]==='4'){const n=t[0]==='3'?3:4,v=t.slice(2,2+n*3).map(Number);if(v.length===n*3&&v.every(Number.isFinite))for(let i=0;i<n;i++)include(v.slice(i*3,i*3+3));continue;}
      if(t[0]!=='1'||t.length<15)continue;
      const v=t.slice(2,14).map(Number);if(!v.every(Number.isFinite))throw Error('Invalid CAD transform');const child=t.slice(14).join(' ').toLowerCase().replaceAll('\\','/'),m=[v[3],v[4],v[5],v[0],v[6],v[7],v[8],v[1],v[9],v[10],v[11],v[2]],result=await walk(child,[...chain,name]);if(!captured)known&&=result.known;
      if(result.bounds)for(let i=0;i<8;i++)include(transform(m,[result.bounds[i&1?3:0],result.bounds[i&2?4:1],result.bounds[i&4?5:2]]));
      if(!captured)for(const dot of result.points){const normal=transform({...m,3:0,7:0,11:0},dot.normal);points.push({...dot,p:transform(m,dot.p),tip:transform(m,dot.tip||dot.p),normal});}
      if(points.length>3000){known=false;break;}
    }
    const bounds=Number.isFinite(min[0])?[...min,...max]:null;
    if(captured)points.push({kind:captured,p:[0,0,0],tip:[0,bounds?.[1]||0,0],normal:[0,-1,0]});
    const result={known,points,bounds};memo.set(name,result);return result;
  }
  return async id=>{
    const result=await walk(id+'.dat'),groups=new Map();
    for(const dot of result.points){const n=dot.normal,length=Math.hypot(...n);if(!length)continue;const axis=n.map(v=>Math.round(v/length*10)/10),face=axis[1]<-.9?'top':axis[1]>.9?'bottom':'side',key=dot.kind+':'+axis.join(',')+':'+Math.round(dot.p.reduce((s,x,i)=>s+x*axis[i],0));
      if(!groups.has(key))groups.set(key,{kind:dot.kind,face,points:new Map()});groups.get(key).points.set(dot.p.map(n=>Math.round(n*100)/100).join(','),dot);
    }
    return {known:result.known,bounds:result.bounds,groups:[...groups.values()].map(g=>{const dots=[...g.points.values()],points=dots.map(d=>d.p),axes=[0,1,2].map(i=>new Set(points.map(p=>Math.round(p[i]*10)/10)).size).filter(n=>n>1).sort((a,b)=>a-b);return {kind:g.kind,face:g.face,count:points.length,centres:dots.map(d=>d.tip||d.p),...(axes.length===2&&axes[0]*axes[1]===points.length?{grid:axes}:{})};})};
  };
}
export async function buildSurfaceCatalogue(){
  const library=createPartLibrary(async name=>{try{return new Response(await readFile(new URL(name,root)));}catch{return new Response('',{status:404});}}),meta=await library.catalogue(),extract=surfaceExtractor(library.resolve),parts={},failures=[];
  let n=0;for(const part of meta.parts.filter(p=>!p.alias)){try{parts[part.id]=await extract(part.id);}catch(e){parts[part.id]={known:false,groups:[]};failures.push({id:part.id,message:e.message});}if(++n%2000===0)console.log(`Surface metadata ${n}/${meta.parts.length}`);}
  const data={format:'brick-surface-index',version:1,sha256:meta.sha256,parts,failures};const tmp=new URL('search-index/surfaces.tmp',root);await writeFile(tmp,JSON.stringify(data));await rename(tmp,new URL('search-index/surfaces.json',root));console.log(`Surface metadata ready: ${n} parts, ${failures.length} unavailable`);return data;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)buildSurfaceCatalogue().catch(e=>{console.error(e);process.exitCode=1;});

