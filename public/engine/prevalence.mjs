export function loadPrevalence(data,sha256){
  if(data.format!=='brick-prevalence'||data.version!==1||data.sha256!==sha256||!data.parts||typeof data.parts!=='object'||Array.isArray(data.parts))throw Error('Prevalence data is invalid or stale. Run npm run setup:prevalence.');
  let max=0;for(const [id,p] of Object.entries(data.parts)){if(!/^[a-z0-9_-]{1,64}$/.test(id)||!Number.isInteger(p.sets)||p.sets<0||!Number.isInteger(p.quantity)||p.quantity<0||typeof p.family!=='string')throw Error('Invalid prevalence entry');max=Math.max(max,p.sets);}
  return {...data,maxSets:max};
}
// A capped log-prior term: at most eight similarity points separate the
// most common part and an unmapped part. Strong geometry still dominates.
export function prevalencePenalty(data,id,strength=1){
  if(!data?.maxSets||strength<=0)return 0;
  const sets=data.parts[id]?.sets||0,normalizer=Math.log1p(data.maxSets/5);
  return .08*Math.min(1,Math.max(0,strength))*(1-Math.min(1,Math.log1p(sets/5)/normalizer));
}
export function commonCandidates(data,ids,families=new Map(),limit=100){
  if(!data?.maxSets)return [];
  const seen=new Set();return ids.filter(id=>data.parts[id]).sort((a,b)=>data.parts[b].sets-data.parts[a].sets||a.localeCompare(b)).filter(id=>{const family=families.get(id)||id;if(seen.has(family))return false;seen.add(family);return true;}).slice(0,limit);
}

