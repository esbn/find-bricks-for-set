import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),revision='3aef8aade8cb74a04780d5e809e49dfa1fc57a47';
const run=(cmd,args)=>new Promise((resolve,reject)=>{const c=spawn(cmd,args,{cwd:root,stdio:'inherit'});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(Error(`${cmd} failed (${code})`)));});
const models=[['bricks','bricks_model_kaggle50epoch_10032025.pt','a1cb24df060c08886cbce3bdca8d18e4da0fead3f722cf7e088bc21bcadbcd63'],['studs','studs_model_kaggle50epoch_10032025.pt','42cd13baa96d0edfd6d48db737a58e61e2a7344c1b1b6dc59abed80dab28a45b']];
try{
  await run(process.execPath,['scripts/setup-sam.mjs']);
  await run('uv',['pip','install','--python','.venv-sam/bin/python','--cache-dir',process.env.BRICK_MODEL_CACHE||'.cache/uv','--only-binary',':all:','-r','scripts/requirements-yolo.txt']);
  await run('uv',['pip','install','--python','.venv-sam/bin/python','--cache-dir',process.env.BRICK_MODEL_CACHE||'.cache/uv','--no-deps','ultralytics==8.3.40']);
  await mkdir(new URL('../.cache/yolo/',import.meta.url),{recursive:true});
  for(const [name,file,sha] of models){const target=new URL(`../.cache/yolo/${name}.pt`,import.meta.url);let valid=false;try{valid=createHash('sha256').update(await readFile(target)).digest('hex')===sha;}catch{}
    if(!valid){console.log(`Downloading LEGO ${name} YOLOv8 nano checkpoint…`);const r=await fetch(`https://raw.githubusercontent.com/MiguelDiLalla/Brickssifier_Studwise/${revision}/models/${file}`);if(!r.ok)throw Error(`Download failed (${r.status})`);const bytes=Buffer.from(await r.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Checkpoint checksum mismatch');const tmp=new URL(`../.cache/yolo/${name}.download`,import.meta.url);await writeFile(tmp,bytes);await rename(tmp,target);}
  }
  const licence=await fetch(`https://raw.githubusercontent.com/MiguelDiLalla/Brickssifier_Studwise/${revision}/LICENSE`);if(!licence.ok)throw Error('Cannot fetch model licence');await writeFile(new URL('../.cache/yolo/UPSTREAM-LICENSE.txt',import.meta.url),await licence.text());
  await writeFile(new URL('../.cache/yolo/ready.json',import.meta.url),JSON.stringify({runtime:'8.3.40',revision,models}));
  console.log('LEGO YOLO detection ready. Restart npm start and use YOLO + SAM.');
}catch(e){console.error(e.message);process.exitCode=1;}

