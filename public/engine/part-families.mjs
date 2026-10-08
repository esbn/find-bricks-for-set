// Group only documented decoration suffixes whose base exists in this library.
// Do not collapse mould revisions, assemblies, or unrelated similar outlines.
export function partFamilies(parts){
  const byId=new Map(parts.map(p=>[p.id,p])),families=new Map();
  for(const p of parts){const match=p.decorated&&!/[pd][a-z0-9]{2,}c\d\d$/.test(p.id)&&p.id.match(/^(.+?)[pd][a-z0-9]{2,}$/),base=match&&byId.get(match[1]);
    const compatible=base&&(base.kind===p.kind||(p.category==='Sticker Shortcut'&&p.kind==='Shortcut'&&base.kind==='Part'));
    families.set(p.id,base&&!base.decorated&&compatible?base.id:p.id);}
  return families;
}
export function groupCandidates(scores,families=new Map(),limit=10){
  const groups=new Map();for(const candidate of scores){const family=families.get(candidate.id)||candidate.id;
    if(!groups.has(family))groups.set(family,{...candidate,family,variants:[]});const g=groups.get(family);g.variants.push(candidate.id);
    // Prefer the undecorated reference for display, without inventing an ID
    // that was excluded from the search or was never actually scored.
    if(candidate.id===family){const variants=g.variants;Object.assign(g,candidate,{family,variants});}
  }
  return [...groups.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
}

