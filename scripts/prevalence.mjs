import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
// These numeric/ID CSV tables have no embedded newlines. Parse quoted commas
// and doubled quotes, and reject schema/row errors rather than invent counts.
export function csvLine(line){
  const fields=[];let value='',quoted=false;
  for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){fields.push(value);value='';}else value+=c;}
  if(quoted)throw Error('Multiline or malformed CSV row');fields.push(value);return fields;
}
export async function* rows(filename,required){
  const input=createReadStream(filename),stream=input.pipe(createGunzip()),lines=createInterface({input:stream,crlfDelay:Infinity});let header,failure;
  input.on('error',e=>stream.destroy(e));stream.on('error',e=>{failure=e;lines.close();});
  try{for await(const line of lines){if(!line)continue;if(line.length>100000)throw Error('Excessive CSV row');const values=csvLine(line);if(!header){header=values;if(required.some(k=>!header.includes(k)))throw Error('Unexpected CSV schema: '+filename);continue;}if(values.length!==header.length)throw Error('Invalid CSV field count: '+filename);yield Object.fromEntries(header.map((key,i)=>[key,values[i]]));}if(failure)throw failure;if(!header)throw Error('Empty CSV: '+filename);}finally{lines.close();input.destroy();stream.destroy();}
}
export function latestInventories(records){
  const latest=new Map();for(const row of records){const version=Number(row.version),id=Number(row.id);if(!Number.isInteger(version)||version<0||!Number.isInteger(id)||id<1)throw Error('Invalid inventory version/ID');const old=latest.get(row.set_num);if(!old||version>old.version||(version===old.version&&id>old.id))latest.set(row.set_num,{id,version});}
  return new Set([...latest.values()].map(r=>r.id));
}
export function canonicalPrinted(parts){
  const parents=new Map();for(const r of parts)if(r.rel_type==='P')parents.set(r.child_part_num,r.parent_part_num);
  return id=>{const seen=new Set();while(parents.has(id)){if(seen.has(id))throw Error('Circular print relationship');seen.add(id);id=parents.get(id);}return id;};
}
export function tallyPrevalence(records,selected,canonical=id=>id){
  const counts=new Map();
  function add(row){const inv=Number(row.inventory_id),qty=Number(row.quantity);if(!selected.has(inv))return;const spare=row.is_spare.toLowerCase();if(!['true','false'].includes(spare))throw Error('Invalid spare flag');if(spare==='true')return;
    if(!Number.isInteger(qty)||qty<0)throw Error('Invalid part quantity');if(!qty)return;const id=canonical(row.part_num);let entry=counts.get(id);if(!entry){entry={inventories:new Set(),quantity:0};counts.set(id,entry);}entry.inventories.add(inv);entry.quantity+=qty;
  }
  for(const row of records)add(row);return {counts,add};
}

