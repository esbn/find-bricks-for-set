import {HNSW,distance} from './hnsw.mjs';
import {descriptor} from './matching.mjs';
import {detectSurface,surfaceAgreement,surfaceFromDetections,surfaceFromTubes,surfaceFootprint,surfaceGeometryAgreement} from './surface-features.mjs';
import {groupCandidates} from './part-families.mjs';
import {prevalencePenalty,commonCandidates} from './prevalence.mjs';
export const INDEX_VERSION=1, MASK_BYTES=288;
// 48x48 silhouette -> 16x16 pooled occupancy -> mirror-invariant 8x8 vector.
// Fine comparison below retains the original silhouette and all four flips.
export function feature(mask){const v=new Float32Array(64);for(let y=0;y<48;y++)for(let x=0;x<48;x++){const a=Math.floor(x/3),b=Math.floor(y/3);v[Math.min(b,15-b)*8+Math.min(a,15-a)]+=mask[y*48+x]/36;}return v;}
export function pack(mask){const b=new Uint8Array(MASK_BYTES);for(let i=0;i<2304;i++)if(mask[i])b[i>>3]|=1<<(i&7);return b;}
export function unpack(b){return Uint8Array.from({length:2304},(_,i)=>(b[i>>3]>>(i&7))&1);}
const counts=Uint8Array.from({length:256},(_,i)=>{let n=0;while(i){i&=i-1;n++;}return n;});
function flips(mask){return Array.from({length:4},(_,f)=>pack(Uint8Array.from({length:2304},(_,i)=>mask[((f&1)?47-Math.floor(i/48):Math.floor(i/48))*48+((f&2)?47-i%48:i%48)])));}
function overlap(variants,b){let best=0;for(const a of variants){let intersection=0,union=0;for(let i=0;i<MASK_BYTES;i++){intersection+=counts[a[i]&b[i]];union+=counts[a[i]|b[i]];}best=Math.max(best,intersection/(union||1));}return best;}
export function loadIndex(manifest,graph,bytes,sha256,vectorBytes){
  if(manifest.format!=='brick-view-index'||manifest.version!==INDEX_VERSION||manifest.sha256!==sha256)throw Error('Search index is out of date. Run npm run build:index.');
  if(!manifest.complete||!manifest.views.length||bytes.length!==manifest.views.length*MASK_BYTES)throw Error('Search index is incomplete. Run npm run build:index.');
  const masks=manifest.views.map((_,i)=>bytes.subarray(i*MASK_BYTES,(i+1)*MASK_BYTES));
  const nodes=manifest.nodes||manifest.views.map((_,i)=>[i]);
  const covered=new Set();for(const node of nodes){if(!Array.isArray(node)||!node.length)throw Error('Invalid index bucket');for(const id of node){if(!Number.isInteger(id)||id<0||id>=masks.length||covered.has(id))throw Error('Invalid index view reference');covered.add(id);}}
  if(covered.size!==masks.length)throw Error('Index is missing view references');
  if(vectorBytes&&vectorBytes.byteLength!==nodes.length*64*4)throw Error('Invalid index vectors');
  const raw=vectorBytes?new Float32Array(vectorBytes):null;
  const vectors=nodes.map((ids,i)=>raw?raw.subarray(i*64,(i+1)*64):feature(unpack(masks[ids[0]])));
  const viewNodes=new Int32Array(masks.length);nodes.forEach((ids,node)=>{for(const id of ids)viewNodes[id]=node;});
  return {manifest,masks,nodes,viewNodes,graph:HNSW.restore(graph,vectors)};
}
export async function searchIndex({index,components,width,pitch,ids,imageData,signal,onProgress=()=>{},ef=240,commonPrior=true}){
  const allowed=new Set(ids),{manifest,masks,graph}=index,byPart=new Map();
  for(let i=0;i<manifest.views.length;i++){const id=manifest.views[i].id;if(allowed.has(id)){if(!byPart.has(id))byPart.set(id,[]);byPart.get(id).push(i);}}
  const prior=commonPrior?index.prevalence:null,common=commonCandidates(prior,[...byPart.keys()],index.families);
  const candidates=components.map(c=>({...c,scores:[]}));let completed=0,comparisons=0;
  for(const c of candidates){
    if(signal?.aborted)break;
    if(c.studDetections?.length)c.surface=surfaceFromDetections(c.studDetections);
    if(!c.surface||c.surface.confidence<.7){const tubes=surfaceFromTubes(c.tubeDetections,c.pixels,width);if(tubes)c.surface=tubes;else if(imageData)c.surface=detectSurface(imageData,c);}
    c.surface=surfaceFootprint(c.surface,c.pixels,width);
    const mask=descriptor(c.pixels,width),q=feature(mask),variants=flips(mask),seen=new Set(),scoreCache=new Map();
    const bounds=m=>{let x0=48,y0=48,x1=0,y1=0,area=0;for(let i=0;i<m.length;i++)if(m[i]){area++;x0=Math.min(x0,i%48);x1=Math.max(x1,i%48);y0=Math.min(y0,Math.floor(i/48));y1=Math.max(y1,Math.floor(i/48));}return area/Math.max(1,(x1-x0+1)*(y1-y0+1));};
    const rectangularity=bounds(mask);index.rectangularity??=new Map();
    function rerank(hits){const queue=[...hits];for(const hit of queue){const id=manifest.views[hit.id].id;if(!allowed.has(id)||seen.has(id))continue;seen.add(id);let best=null;
      const family=index.families?.get(id);if(family&&family!==id&&allowed.has(family)&&byPart.has(family)&&!seen.has(family))queue.push({id:byPart.get(family)[0]});
      const surface=surfaceAgreement(c.surface,index.surfaces?.[id]);
      const priorPenalty=prevalencePenalty(prior,id);
      for(const i of byPart.get(id)||[]){const t=manifest.views[i],key=t.shape??i;let score=scoreCache.get(key);
        if(score===undefined){const sim=overlap(variants,masks[i]),penalty=t.elevation>=60?0:t.elevation>=25?.035:.07,sizeScore=pitch?Math.exp(-Math.abs(Math.log(c.area/(t.filledArea*(pitch/20)**2)))):sim;
          if(!index.rectangularity.has(key))index.rectangularity.set(key,bounds(unpack(masks[i])));
          const shapePenalty=rectangularity>.9?.25*Math.max(0,rectangularity-index.rectangularity.get(key)-.05):0;
          score=Math.max(0,(pitch ? .72*sim+.28*sizeScore : sim)-penalty-shapePenalty);scoreCache.set(key,score);}
        const geometryPenalty=surfaceGeometryAgreement(c.surface,index.surfaces?.[id],t);
        const visualScore=Math.max(0,score-surface.penalty-geometryPenalty),combined=Math.max(0,visualScore-priorPenalty);
        if(!best||combined>best.score)best={id,score:combined,visualScore,priorPenalty,silhouetteScore:score,surface,face:surface.face==='bottom'?'bottom':'top',view:{elevation:t.elevation,yaw:t.yaw}};
      }
      if(best)c.scores.push(best);
    }c.scores.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));}
    // Restricted searches can have no neighbours in the global top-k. Exact
    // retrieval for small scopes preserves their meaning without widening scope.
    if(byPart.size<=200)rerank([...byPart.values()].map(a=>({id:a[0]})));
    else{
      const views=hits=>hits.flatMap(hit=>index.nodes[hit.id].map(id=>({id})));
      rerank(views(graph.search(q,200,ef)));
      if(c.scores.length<10||(c.scores[0]?.score||0)<.8)rerank(views(graph.search(q,800,Math.max(1000,ef))));
      if(c.scores.length<10)rerank([...byPart.values()].map(a=>({id:a[0]})));
    }
    // Give prevalent parts a chance even when exotic silhouettes filled the
    // ANN shortlist. Exact silhouette/surface reranking still applies to them.
    if(common.length)rerank(common.map(id=>({id:byPart.get(id)[0]})));
    // Surface-compatible families can enter even when silhouette-only HNSW
    // retrieval missed them. Unknown detection never narrows the search.
    if(c.surface?.confidence>=.7&&index.surfaces){
      const extra=new Map();
      for(const [id,views] of byPart){const family=index.families?.get(id)||id,match=surfaceAgreement(c.surface,index.surfaces[id]);if(!match.expectedCount||match.penalty>=.06)continue;
        let closest=Infinity;for(const i of views)closest=Math.min(closest,distance(q,graph.vectors[index.viewNodes[i]]));
        const hit={id:views[0],distance:closest+match.penalty};if(!extra.has(family)||hit.distance<extra.get(family).distance)extra.set(family,hit);
      }
      rerank([...extra.values()].sort((a,b)=>a.distance-b.distance).slice(0,200));
    }
    comparisons+=seen.size;c.scores=groupCandidates(c.scores,index.families);completed++;
    onProgress({phase:'search',completed,total:components.length,compared:comparisons,libraryParts:byPart.size,best:candidates.map(c=>c.scores[0]||null)});
    await new Promise(r=>setTimeout(r,0));
  }
  return {candidates,compared:comparisons,indexed:true,libraryParts:byPart.size,completed,failures:manifest.failures||[],cancelled:!!signal?.aborted,priorApplied:!!prior,priorStatus:!commonPrior?'Common-part preference is off.':prior?`Rebrickable common-part preference applied (${prior.mappedFamilies} mapped families).`:index.priorWarning||'No prevalence data: visual-only ranking. Run npm run setup:prevalence.'};
}

