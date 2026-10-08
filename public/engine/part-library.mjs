// Metadata first; load CAD only for parts actually inspected or searched.
export function searchParts(parts,query='',{category='',decorated=true,limit=100}={}){
  const tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return parts.filter(p=>(!category||p.category===category)&&(decorated||!p.decorated)&&tokens.every(t=>(p.id+' '+p.label).toLowerCase().includes(t)))
    .sort((a,b)=>(b.id===query.trim())-(a.id===query.trim())||a.id.localeCompare(b.id,'en',{numeric:true})).slice(0,limit);
}
export function safeReference(name){
  name=name.toLowerCase().replaceAll('\\','/');
  if(!/^[a-z0-9_./-]+\.dat$/.test(name)||name.split('/').some(p=>!p||p==='..'||p==='.')||name.length>180)throw Error('Invalid LDraw reference.');
  return name;
}
export function createPartLibrary(fetcher=fetch){
  let metadata;const cache=new Map();
  async function catalogue(){
    if(!metadata)metadata=fetcher('ldraw/catalogue.json').then(async r=>{
      if(!r.ok)throw Error('LDraw is not installed. In the project terminal run npm run setup:ldraw, then reload.');
      const value=await r.json();if(value.format!=='ldraw-catalogue'||value.version!==1||!Array.isArray(value.parts))throw Error('Invalid installed catalogue.');return value;
    }).catch(e=>{metadata=null;throw e;});
    return metadata;
  }
  async function resolve(name){
    name=safeReference(name);
    if(cache.has(name)){const value=cache.get(name);cache.delete(name);cache.set(name,value);return value;}
    const pending=(async()=>{
      for(const candidate of name.startsWith('parts/')||name.startsWith('p/')?[name]:['parts/'+name,'p/'+name]){
        const r=await fetcher('ldraw/'+candidate);if(r.ok)return r.text();if(r.status!==404)throw Error('Could not load LDraw dependency: '+name);
      }
      throw Error('Missing installed LDraw dependency: '+name);
    })();
    cache.set(name,pending);if(cache.size>512)cache.delete(cache.keys().next().value);
    try{return await pending;}catch(e){cache.delete(name);throw e;}
  }
  return {catalogue,resolve};
}

