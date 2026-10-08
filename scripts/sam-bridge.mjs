import {spawn} from 'node:child_process';
import {existsSync,statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function createSamBridge(){
  let child,pending,lastError='',workerRevision;
  const revision=()=>['sam-runner.py','yolo_detector.py','tube_detector.py','tiled_pipeline.py'].map(file=>statSync(root+'scripts/'+file).mtimeMs).join(':');
  const available=()=>existsSync(root+'.venv-sam/bin/python')&&existsSync(root+'.cache/sam/mobile_sam.pt');
  function stop(){const current=child;child=undefined;current?.kill();if(pending){pending.reject(Error('Segmentation stopped.'));pending=undefined;}}
  function start(){
    // Models are persistent, but source changes must not leave an old Python
    // worker silently serving results without newer diagnostic stages.
    if(child && workerRevision!==revision())stop();
    if(child)return;
    workerRevision=revision();
    child=spawn(root+'.venv-sam/bin/python',['-u',root+'scripts/sam-runner.py'],{cwd:root,stdio:['pipe','pipe','pipe']});
    const current=child;let stderr='';current.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-2000);});
    createInterface({input:current.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(child!==current||!pending)return;if(msg.type==='result'){pending.resolve(msg);pending=undefined;}else if(msg.type==='error'){pending.reject(Error(msg.message));pending=undefined;}else pending.progress(msg);}catch{if(child===current){lastError='Invalid segmentation response';stop();}}});
    const failed=e=>{if(child!==current)return;child=undefined;lastError=e?.message||stderr.trim()||'Local SAM exited';if(pending){pending.reject(Error(lastError));pending=undefined;}};
    current.on('error',failed);current.on('exit',()=>failed());current.stdin.on('error',failed);
  }
  return {
    status:()=>({available:available(),yoloAvailable:available()&&existsSync(root+'.cache/yolo/ready.json')&&existsSync(root+'.cache/yolo/bricks.pt')&&existsSync(root+'.cache/yolo/studs.pt'),busy:!!pending,model:'MobileSAM',device:'cpu',error:lastError}),
    segment(payload,{signal,onProgress=()=>{}}={}){
      if(!available())return Promise.reject(Error('Local SAM is not installed. Run npm run setup:sam.'));
      if(pending)return Promise.reject(Object.assign(Error('Local SAM is already processing a photo.'),{status:409}));
      if(signal?.aborted)return Promise.reject(Error('Segmentation stopped.'));
      return new Promise((resolve,reject)=>{
        const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});
        const finish=fn=>value=>{signal?.removeEventListener('abort',abort);fn(value);};
        start();pending={resolve:finish(resolve),reject:finish(reject),progress:onProgress};
        onProgress({type:'progress',phase:'loading',message:payload.mode==='yolo'?'Loading local YOLO + SAM…':'Loading Local SAM…'});
        child.stdin.write(JSON.stringify(payload)+'\n');
      });
    },
    close:stop,
  };
}
