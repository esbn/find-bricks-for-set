// Explicit, resumable offline preparation. Only generated CAD data is written.
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import {Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {HNSW} from '../public/engine/hnsw.mjs';
import {INDEX_VERSION,feature,unpack} from '../public/engine/view-index.mjs';
import {buildSurfaceCatalogue} from './surface-catalogue.mjs';
const root=new URL('../',import.meta.url);
export async function buildIndex(options={}){
  const output=options.output||new URL(Number.isFinite(options.limit)?`artifacts/index-${options.limit}/`:'public/search-index/',root);await mkdir(output,{recursive:true});const lockURL=new URL('build.lock',output);let lock;
  try{lock=await open(lockURL,'wx');}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const previous=JSON.parse(await readFile(lockURL,'utf8'));
    if(!Number.isInteger(previous.pid)||previous.pid<1)throw Error('Invalid index build lock');
    let active=true;try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')active=false;}
    if(active)throw Error(`An index build is already running (PID ${previous.pid}).`);
    await unlink(lockURL);lock=await open(lockURL,'wx');
  }
  try{await lock.writeFile(JSON.stringify({pid:process.pid}));return await prepareIndex({...options,output});}
  finally{await lock.close();await unlink(lockURL);}
}
async function prepareIndex({limit=Infinity,jobs=Math.min(4,availableParallelism()),output,onProgress=console.log}){
  const meta=JSON.parse(await readFile(new URL('public/ldraw/catalogue.json',root))),parts=meta.parts.filter(p=>!p.alias).slice(0,limit);
  const cache=new URL(`.cache/view-index-${INDEX_VERSION}-${meta.sha256}/`,root);await mkdir(cache,{recursive:true});await mkdir(output,{recursive:true});
  const records=new Map(),missing=[];for(const p of parts){try{const r=JSON.parse(await readFile(new URL(p.id+'.json',cache)));if(r.error)missing.push(p);else records.set(p.id,r);}catch{missing.push(p);}}
  onProgress(`Preparing ${parts.length} parts (${records.size} cached), ${jobs} workers. Checkpoints survive interruption.`);
  let cursor=0,done=records.size,last=0;
  await Promise.all(Array.from({length:Math.min(jobs,missing.length)},async()=>{
    let worker;
    const spawn=()=>worker=new Worker(new URL('./index-part-worker.mjs',import.meta.url));spawn();
    try{while(cursor<missing.length){const part=missing[cursor++];
      const result=await new Promise(resolve=>{
        const cleanup=()=>{clearTimeout(timer);worker.removeListener('message',message);worker.removeListener('error',error);worker.removeListener('exit',exited);};
        const message=value=>{cleanup();resolve(value);};
        const error=e=>{cleanup();const old=worker;old.terminate();spawn();resolve({id:part.id,error:e.message});};
        const exited=code=>error(Error(`Index worker exited (${code})`));
        const timer=setTimeout(()=>error(Error('CAD preparation exceeded 45 seconds')),45000);
        worker.once('message',message);worker.once('error',error);worker.once('exit',exited);worker.postMessage(part.id);
      });
      records.set(part.id,result);const file=new URL(part.id+'.json',cache),tmp=new URL(part.id+'.'+process.pid+'.tmp',cache);await writeFile(tmp,JSON.stringify(result));await rename(tmp,file);done++;
      if(Date.now()-last>3000||done===parts.length){onProgress(`Rendered ${done}/${parts.length} parts · ${part.id}${result.error?' · skipped: '+result.error:''}`);last=Date.now();}
    }}finally{await worker.terminate();}
  }));
  const graph=new HNSW(),views=[],masks=[],failures=[],sizes={},nodes=[],vectorIds=new Map(),shapeIds=new Map();let n=0;
  for(const part of parts){const r=records.get(part.id);if(r.error){failures.push({id:part.id,message:r.error});continue;}sizes[part.id]=r.size;
    for(const t of r.templates){
      const mask=Buffer.from(t.mask,'base64'),vector=feature(unpack(mask)),key=Buffer.from(vector.buffer).toString('base64');
      let node=vectorIds.get(key);if(node===undefined){node=graph.add(vector);vectorIds.set(key,node);nodes.push([]);}nodes[node].push(views.length);
      const shapeKey=t.mask+':'+t.filledArea+':'+(t.elevation>=60?0:t.elevation>=25?1:2);if(!shapeIds.has(shapeKey))shapeIds.set(shapeKey,shapeIds.size);
      masks.push(mask);views.push({id:part.id,elevation:t.elevation,yaw:t.yaw,filledArea:t.filledArea,shape:shapeIds.get(shapeKey)});
    }
    if(++n%250===0)onProgress(`Indexed ${n}/${parts.length} parts · ${views.length} views`);
  }
  if(!views.length)throw Error('No usable views to index');
  const generation=`v${INDEX_VERSION}-${Date.now()}`,manifest={format:'brick-view-index',version:INDEX_VERSION,sha256:meta.sha256,release:meta.release,complete:limit===Infinity,partCount:parts.length-failures.length,sourcePartCount:meta.parts.filter(p=>!p.alias).length,failures,sizes,views,nodes,graph:generation+'-graph.json.gz',masks:generation+'-masks.bin.gz',vectors:generation+'-vectors.bin.gz'};
  const vectors=new Float32Array(graph.vectors.length*64);graph.vectors.forEach((v,i)=>vectors.set(v,i*64));
  await writeFile(new URL(manifest.graph,output),gzipSync(JSON.stringify(graph.serialize())));
  await writeFile(new URL(manifest.masks,output),gzipSync(Buffer.concat(masks)));
  await writeFile(new URL(manifest.vectors,output),gzipSync(Buffer.from(vectors.buffer)));
  // Publish the manifest last so interrupted builds cannot replace a usable index.
  await writeFile(new URL('manifest.tmp',output),JSON.stringify(manifest));await rename(new URL('manifest.tmp',output),new URL('manifest.json',output));
  onProgress(`Index ready: ${manifest.partCount} parts, ${views.length} views, ${failures.length} skipped${manifest.complete?'':' (test subset; not a full-library index)'}.`);
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  const jobs=args.includes('--jobs')?Number(value('--jobs')):undefined;
  if(jobs!==undefined&&(!Number.isInteger(jobs)||jobs<1||jobs>16))throw Error('--jobs must be 1–16');
  const limit=args.includes('--limit')?Number(value('--limit')):Infinity;
  if(limit!==Infinity&&(!Number.isInteger(limit)||limit<1))throw Error('--limit must be positive');
  // Test subsets never overwrite the app's full-library index.
  buildIndex({jobs,limit,output:limit===Infinity?undefined:new URL(`artifacts/index-${limit}/`,root)}).then(async manifest=>{if(manifest.complete)await buildSurfaceCatalogue();}).catch(e=>{console.error(e);process.exitCode=1;});
}

