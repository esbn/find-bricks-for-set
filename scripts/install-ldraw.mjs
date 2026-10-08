// Install data, never executable code, from a checksum-pinned official archive.
import {readFile,writeFile,mkdir,rename,copyFile,access,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CATALOG} from '../public/engine/catalogue.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const exists=async p=>access(p).then(()=>true,()=>false);
const digest=b=>createHash('sha256').update(b).digest('hex');

export function archiveEntries(zip){
  // Central directory sizes are authoritative; reject ZIP64, links and traversal.
  let end=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.readUInt32LE(i)===0x06054b50&&i+22+zip.readUInt16LE(i+20)===zip.length){end=i;break;}
  if(end<0)throw Error('Invalid ZIP directory.');
  const count=zip.readUInt16LE(end+10),size=zip.readUInt32LE(end+12),offset=zip.readUInt32LE(end+16);
  if(zip.readUInt16LE(end+4)||zip.readUInt16LE(end+6)||count===65535||offset+size!==end)throw Error('Split/ZIP64 archives are not supported.');
  const entries=[],names=new Set();let cursor=offset,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||zip.readUInt32LE(cursor)!==0x02014b50)throw Error('Invalid ZIP entry.');
    const flags=zip.readUInt16LE(cursor+8),method=zip.readUInt16LE(cursor+10),compressed=zip.readUInt32LE(cursor+20),length=zip.readUInt32LE(cursor+24);
    const n=zip.readUInt16LE(cursor+28),extra=zip.readUInt16LE(cursor+30),comment=zip.readUInt16LE(cursor+32),local=zip.readUInt32LE(cursor+42),mode=zip.readUInt32LE(cursor+38)>>>16;
    const name=zip.subarray(cursor+46,cursor+46+n).toString('utf8').replaceAll('\\','/').toLowerCase();cursor+=46+n+extra+comment;
    if(cursor>end||!name.startsWith('ldraw/')||name.split('/').some(s=>s==='..'||s==='.')||name.includes('\0')||(mode&0xf000)===0xa000)throw Error('Unsafe ZIP path or symbolic link.');
    if(flags&1||![0,8].includes(method)||length>16e6||(total+=length)>2e9)throw Error('Unsupported or oversized ZIP entry.');
    if(names.has(name))throw Error('Duplicate ZIP path.');names.add(name);
    if(local+30>offset||zip.readUInt32LE(local)!==0x04034b50)throw Error('Invalid ZIP file header.');
    const data=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);
    if(data+compressed>offset)throw Error('Invalid ZIP data bounds.');
    entries.push({name:name.slice(6),method,length,data,compressed});
  }
  if(cursor!==end)throw Error('Invalid ZIP directory size.');
  return entries;
}
export function partMetadata(id,text){
  const kind=text.match(/^0\s+!LDRAW_ORG\s+(\S+)/m)?.[1];
  if(!['Part','Shortcut'].includes(kind))return null;
  const label=text.split(/\r?\n/)[0].replace(/^0\s*/,'').trim();
  const moved=label.match(/^~Moved to (\S+)/i),alias=!!moved||label.startsWith('=')||/\bAlias\b/.test(text.match(/^0\s+!LDRAW_ORG.*$/m)?.[0]||'');
  if(!label||(label.startsWith('~')&&!moved))return null;
  const category=text.match(/^0\s+!CATEGORY\s+(.+)$/m)?.[1].trim()||label.replace(/^[_~]/,'').split(/\s+/)[0];
  return {id,label,category,kind,decorated:/\b(?:Pattern|Sticker)\b/i.test(label),alias,...(moved?{aliasOf:moved[1]}:{})};
}
export async function install({archive,check=false}={}){
  const lock=JSON.parse(await readFile(path.join(root,'ldraw.lock.json'),'utf8'));
  const target=path.join(root,'public/ldraw'),compat=path.join(root,'public/library.json');
  let installed;try{installed=JSON.parse(await readFile(path.join(target,'catalogue.json'),'utf8'));}catch{}
  if(installed?.sha256===lock.sha256&&!await exists(compat)&&!check&&await exists(path.join(target,'legacy-library.json')))await copyFile(path.join(target,'legacy-library.json'),compat);
  if(installed?.sha256===lock.sha256&&await exists(compat)){
    if(installed.indexVersion!==2){
      if(check)throw Error('LDraw catalogue index needs refreshing. Run npm run setup:ldraw.');
      const parts=[];for(const name of await readdir(path.join(target,'parts'))){if(!/^[a-z0-9_-]+\.dat$/.test(name))continue;const p=partMetadata(name.slice(0,-4),await readFile(path.join(target,'parts',name),'utf8'));if(p)parts.push(p);}
      parts.sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));installed={...installed,indexVersion:2,parts};await writeFile(path.join(target,'catalogue.json'),JSON.stringify(installed));
    }
    console.log(`LDraw ${installed.release}: ${installed.parts.length.toLocaleString()} catalogue entries installed.`);return;
  }
  if(check)throw Error('LDraw is not installed. Run npm run setup:ldraw first (one-time download).');
  if(await exists(target))throw Error('An incomplete or different library exists in public/ldraw. Move that directory aside before installing; it has not been overwritten.');
  const cache=path.join(root,'.cache/ldraw');await mkdir(cache,{recursive:true});
  const cached=path.join(cache,lock.sha256+'.zip');let zip;
  if(archive)zip=await readFile(path.resolve(archive));
  else if(await exists(cached))zip=await readFile(cached);
  else{
    console.log('Downloading the official LDraw archive (~140 MB)…');
    const response=await fetch(lock.url,{signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error(`LDraw download failed: HTTP ${response.status}.`);
    if(Number(response.headers.get('content-length'))>250e6)throw Error('Archive exceeds download limit.');
    const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>250e6)throw Error('Archive exceeds download limit.');chunks.push(chunk);}zip=Buffer.concat(chunks);
  }
  if(digest(zip)!==lock.sha256)throw Error('LDraw checksum mismatch. The upstream complete.zip may have changed. Use --archive with the locked ZIP or explicitly review/update ldraw.lock.json. No files were installed.');
  const entries=archiveEntries(zip);
  if(!await exists(cached))await writeFile(cached,zip,{flag:'wx'});
  const staging=path.join(root,'public',`.ldraw-install-${Date.now()}`);await mkdir(staging);
  const parts=[],library=Object.create(null);
  for(const entry of entries){
    if(!/^(?:(?:parts|p)\/.*\.(?:dat|png)|(?:calicense4?|careadme|readme)\.txt|ldconfig\.ldr)$/.test(entry.name))continue;
    const compressed=zip.subarray(entry.data,entry.data+entry.compressed),bytes=entry.method===8?inflateRawSync(compressed,{maxOutputLength:16e6}):compressed;
    if(bytes.length!==entry.length)throw Error('Invalid uncompressed size.');
    const destination=path.join(staging,entry.name);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx'});
    if(entry.name.endsWith('.dat')){
      const text=bytes.toString('utf8');library[entry.name]=text;
      const match=entry.name.match(/^parts\/([a-z0-9_-]+)\.dat$/);
      if(match){const part=partMetadata(match[1],text);if(part)parts.push(part);}
    }
  }
  if(parts.length<1000)throw Error('Archive did not contain the expected official parts catalogue.');
  parts.sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));
  await writeFile(path.join(staging,'catalogue.json'),JSON.stringify({format:'ldraw-catalogue',version:1,indexVersion:2,release:lock.release,sha256:lock.sha256,source:lock.url,parts}));
  // Legacy demo / Builder compatibility: generated locally, never committed.
  const subset=Object.create(null);
  function include(name){const key=['parts/'+name,'p/'+name,name].find(k=>library[k]);if(!key)throw Error('Missing dependency: '+name);if(subset[key])return;subset[key]=library[key];for(const line of library[key].split(/\r?\n/)){const t=line.trim().split(/\s+/);if(t[0]==='1')include(t.slice(14).join(' ').toLowerCase().replaceAll('\\','/'));}}
  for(const part of CATALOG)include(part.id+'.dat');
  await writeFile(path.join(staging,'legacy-library.json'),JSON.stringify(subset));
  await rename(staging,target);await copyFile(path.join(target,'legacy-library.json'),compat);
  console.log(`Installed LDraw ${lock.release}: ${parts.length.toLocaleString()} searchable parts/shortcuts. CAD data and archive cache are ignored by Git.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),i=args.indexOf('--archive');
  if(i>=0&&!args[i+1]){console.error('--archive requires a ZIP path.');process.exitCode=1;}
  else install({archive:i<0?undefined:args[i+1],check:args.includes('--check')}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
