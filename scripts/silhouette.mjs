import {project} from '../public/engine/cad.mjs';
// Union all projected triangles with consistent winding in one native fill.
// This avoids a JavaScript->canvas fill call for every triangle in every view.
export function silhouette(canvas,model,yaw,elevation){
  const p=project(model,yaw,elevation);let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(let i=0;i<p.length;i+=3){x0=Math.min(x0,p[i]);x1=Math.max(x1,p[i]);y0=Math.min(y0,p[i+1]);y1=Math.max(y1,p[i+1]);}
  const w=canvas.width,h=canvas.height,s=.83*Math.min(w/Math.max(x1-x0,.01),h/Math.max(y1-y0,.01)),ox=w/2-(x0+x1)*s/2,oy=h/2-(y0+y1)*s/2,ctx=canvas.getContext('2d');
  ctx.fillStyle='black';ctx.fillRect(0,0,w,h);ctx.fillStyle='white';ctx.beginPath();
  for(let i=0;i<p.length;i+=9){
    const cross=(p[i+3]-p[i])*(p[i+7]-p[i+1])-(p[i+4]-p[i+1])*(p[i+6]-p[i]);
    if(Math.abs(cross)<1e-9)continue;
    const b=cross>0?i+3:i+6,c=cross>0?i+6:i+3;
    ctx.moveTo(p[i]*s+ox,p[i+1]*s+oy);ctx.lineTo(p[b]*s+ox,p[b+1]*s+oy);ctx.lineTo(p[c]*s+ox,p[c+1]*s+oy);ctx.closePath();
  }
  ctx.fill('nonzero');ctx.projectedScale=s;ctx.projectedBoxArea=(x1-x0)*(y1-y0);return ctx;
}

