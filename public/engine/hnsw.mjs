// Dependency-free HNSW, squared L2. The base layer also has a protected chain
// (implicit consecutive node IDs) so neighbour pruning cannot isolate nodes.
export const distance=(a,b)=>{let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;};
class Heap {
  constructor(max=false){this.items=[];this.max=max;}
  before(a,b){return this.max?a.distance>b.distance:a.distance<b.distance;}
  get size(){return this.items.length;}
  peek(){return this.items[0];}
  push(x){const a=this.items;let i=a.length;a.push(x);while(i){const p=(i-1)>>1;if(!this.before(x,a[p]))break;a[i]=a[p];i=p;}a[i]=x;}
  pop(){const a=this.items,out=a[0],x=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&this.before(a[c+1],a[c]))c++;if(!this.before(a[c],x))break;a[i]=a[c];i=c;}a[i]=x;}return out;}
}
export class HNSW {
  constructor({M=12,efConstruction=80,seed=12345}={}){this.M=M;this.efConstruction=efConstruction;this.seed=seed;this.vectors=[];this.links=[];this.entry=-1;this.level=-1;this.visited=new Uint32Array(1024);this.epoch=0;}
  random(){let x=this.seed;x^=x<<13;x^=x>>>17;x^=x<<5;this.seed=x>>>0;return (this.seed+1)/4294967297;}
  *neighbours(id,level){yield* this.links[id][level]||[];if(level===0){if(id>0)yield id-1;if(id+1<this.vectors.length)yield id+1;}}
  greedy(q,entry,level){let best={id:entry,distance:distance(q,this.vectors[entry])},changed=true;while(changed){changed=false;for(const id of this.neighbours(best.id,level)){const d=distance(q,this.vectors[id]);if(d<best.distance){best={id,distance:d};changed=true;}}}return best.id;}
  layer(q,entry,ef,level){
    if(this.visited.length<this.vectors.length)this.visited=new Uint32Array(Math.max(this.visited.length*2,this.vectors.length));
    this.epoch=(this.epoch+1)>>>0;if(!this.epoch){this.visited.fill(0);this.epoch=1;}
    const todo=new Heap(),best=new Heap(true),first={id:entry,distance:distance(q,this.vectors[entry])};todo.push(first);best.push(first);this.visited[entry]=this.epoch;
    while(todo.size){const c=todo.pop();if(best.size>=ef&&c.distance>best.peek().distance)break;
      for(const id of this.neighbours(c.id,level)){if(this.visited[id]===this.epoch)continue;this.visited[id]=this.epoch;const d=distance(q,this.vectors[id]);if(best.size<ef||d<best.peek().distance){const v={id,distance:d};todo.push(v);best.push(v);if(best.size>ef)best.pop();}}
    }
    return best.items.sort((a,b)=>a.distance-b.distance||a.id-b.id);
  }
  select(q,candidates,limit){const chosen=[];for(const c of candidates){if(chosen.every(id=>distance(this.vectors[c.id],this.vectors[id])>=c.distance))chosen.push(c.id);if(chosen.length===limit)break;}return chosen;}
  add(vector){
    if(!vector.length||!Array.from(vector).every(Number.isFinite)||(this.vectors.length&&vector.length!==this.vectors[0].length))throw Error('Invalid HNSW vector');
    const id=this.vectors.length,level=Math.min(16,Math.floor(-Math.log(this.random())/Math.log(this.M)));
    // Search before publishing the node: implicit chain must not connect it yet.
    let ep=this.entry;const selected=[];
    if(ep>=0){for(let l=this.level;l>level;l--)ep=this.greedy(vector,ep,l);for(let l=Math.min(level,this.level);l>=0;l--){const hits=this.layer(vector,ep,this.efConstruction,l);selected[l]=this.select(vector,hits,this.M);ep=hits[0].id;}}
    this.vectors.push(Float32Array.from(vector));this.links.push(Array.from({length:level+1},(_,l)=>selected[l]||[]));
    for(let l=0;l<selected.length;l++)for(const neighbour of selected[l]){const list=this.links[neighbour][l];list.push(id);const limit=l===0?2*this.M:this.M;if(list.length>limit){const q=this.vectors[neighbour],hits=list.map(id=>({id,distance:distance(q,this.vectors[id])})).sort((a,b)=>a.distance-b.distance);this.links[neighbour][l]=this.select(q,hits,limit);}}
    if(level>this.level){this.level=level;this.entry=id;}return id;
  }
  search(q,k=100,ef=200){if(this.entry<0)return [];let ep=this.entry;for(let l=this.level;l>0;l--)ep=this.greedy(q,ep,l);return this.layer(q,ep,Math.max(k,ef),0).slice(0,k);}
  serialize(){return {M:this.M,entry:this.entry,level:this.level,links:this.links};}
  static restore(data,vectors){
    if(!Array.isArray(data.links)||data.links.length!==vectors.length||!Number.isInteger(data.entry)||data.entry<0||data.entry>=vectors.length)throw Error('Invalid search graph');
    for(const layers of data.links){if(!Array.isArray(layers)||!layers.length||layers.length>17)throw Error('Invalid graph layers');for(const list of layers)if(!Array.isArray(list)||list.some(id=>!Number.isInteger(id)||id<0||id>=vectors.length))throw Error('Invalid graph edge');}
    const h=new HNSW({M:data.M});Object.assign(h,{vectors,links:data.links,entry:data.entry,level:data.level});return h;
  }
}

