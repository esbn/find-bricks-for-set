export function decodeSegmentation(result,width,height){
  if(result.width!==width||result.height!==height||!Array.isArray(result.components))throw Error('Segmentation dimensions do not match the photo.');
  const mask=new Uint8Array(width*height),components=[];
  for(const component of result.components){
    const {runs,box}=component;
    if(!Array.isArray(runs)||runs.length%2||!Array.isArray(box)||box.length!==4||!box.every(Number.isInteger)||box[0]<0||box[1]<0||box[2]<1||box[3]<1||box[0]+box[2]>width||box[1]+box[3]>height)throw Error('Invalid segmentation mask.');
    const pixels=[];let end=0;
    for(let i=0;i<runs.length;i+=2){const start=runs[i],length=runs[i+1];if(!Number.isInteger(start)||!Number.isInteger(length)||start<end||length<1||start+length>mask.length)throw Error('Invalid segmentation run.');for(let k=start;k<start+length;k++){pixels.push(k);mask[k]=1;}end=start+length;}
    if(!pixels.length||pixels.length!==component.area)throw Error('Invalid segmentation area.');
    for(const key of ['studDetections','tubeDetections'])if(component[key]!==undefined&&(!Array.isArray(component[key])||component[key].length>1000||component[key].some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>=width||p.y<0||p.y>=height||!Number.isFinite(p.radius)||p.radius<=0||!Number.isFinite(p.confidence)||p.confidence<0||p.confidence>1)))throw Error(`Invalid ${key==='studDetections'?'stud':'tube'} detections.`);
    components.push({...component,pixels,runs:undefined});
  }
  return {...result,components,mask};
}

export async function segmentLocal(canvas,{density=16,mode='sam',signal,onProgress=()=>{},fetcher=fetch}={}){
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw Error('Could not prepare the photo for segmentation.');
  const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Could not read the photo'));reader.readAsDataURL(blob);});
  const response=await fetcher('/api/segment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,density,mode}),signal});
  if(!response.ok)throw Error(await response.text());
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result;
  function consume(line){if(!line.trim())return;const message=JSON.parse(line);if(message.type==='error')throw Error(message.message);if(message.type==='result')result=message;else onProgress(message);}
  try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let pos;while((pos=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,pos));buffer=buffer.slice(pos+1);}}buffer+=decoder.decode();consume(buffer);}finally{reader.releaseLock();}
  if(!result)throw Error('Local SAM ended without returning masks.');
  return decodeSegmentation(result,canvas.width,canvas.height);
}

