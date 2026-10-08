import {spawn} from 'node:child_process';
import {access,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const revision='f706ad9c4eb7f219c00d9050e46328518ffb65d2';
const sha256='6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f';
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${command} failed (${code})`)));});
try{
  try{await access(new URL('../.venv-sam/bin/python',import.meta.url));}
  catch{await run('uv',['venv','--python',process.env.SAM_PYTHON||'3.11','.venv-sam']);}
  await run('uv',['pip','install','--python','.venv-sam/bin/python','--cache-dir',process.env.BRICK_MODEL_CACHE||'.cache/uv','--only-binary',':all:','-r','scripts/requirements-sam.txt']);
  const weights=new URL('../.cache/sam/mobile_sam.pt',import.meta.url);
  const valid=async()=>{try{return createHash('sha256').update(await readFile(weights)).digest('hex')===sha256;}catch{return false;}};
  await mkdir(new URL('../.cache/sam/',import.meta.url),{recursive:true});
  if(!await valid()){
    console.log('Downloading the official MobileSAM checkpoint (39 MB)…');
    const response=await fetch(`https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/${revision}/weights/mobile_sam.pt`);
    if(!response.ok)throw Error(`Checkpoint download failed (${response.status})`);
    const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Checkpoint checksum mismatch');
    const temporary=new URL('../.cache/sam/mobile_sam.pt.download',import.meta.url);await writeFile(temporary,bytes);await rename(temporary,weights);
  }
  await run('.venv-sam/bin/python',['-c','import torch, torchvision, cv2; from mobile_sam import sam_model_registry; print("MobileSAM ready. Restart npm start, then select Local SAM in Photo settings.")']);
}catch(e){console.error(e.message);process.exitCode=1;}

