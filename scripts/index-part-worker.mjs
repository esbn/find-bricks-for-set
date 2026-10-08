import {parentPort} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createCanvas} from '@napi-rs/canvas';
import {parseLDraw} from '../public/engine/cad.mjs';
import {makeTemplates} from '../public/engine/matching.mjs';
import {createPartLibrary} from '../public/engine/part-library.mjs';
import {pack} from '../public/engine/view-index.mjs';
import {silhouette} from './silhouette.mjs';
const base=new URL('../public/',import.meta.url);
const library=createPartLibrary(async name=>{try{return new Response(await readFile(new URL(name,base)));}catch{return new Response('',{status:404});}});
parentPort.on('message',async id=>{
  try{
    const model=await parseLDraw(await library.resolve(id+'.dat'),library.resolve),templates=await makeTemplates(model,createCanvas,undefined,silhouette);
    if(!templates.length)throw Error('No usable rendered views');
    parentPort.postMessage({id,renderer:'union-v1',size:Array.from(model.size),templates:templates.map(({mask,...t})=>({...t,mask:Buffer.from(pack(mask)).toString('base64')}))});
  }catch(e){parentPort.postMessage({id,error:e.message});}
});

