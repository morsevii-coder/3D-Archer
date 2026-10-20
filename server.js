const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const PUB=fs.existsSync(path.join(__dirname,'public','shared.js'))?path.join(__dirname,'public'):__dirname;
if(!fs.existsSync(path.join(PUB,'shared.js'))||!fs.existsSync(path.join(PUB,'index.html')))
  throw new Error('shared.js / index.html not found. Put them in a "public" folder next to server.js. Looked in: '+PUB);
const S=require(path.join(PUB,'shared.js'));
const MAXP=8,HP=3;
const types={'.html':'text/html','.js':'text/javascript'};
const server=http.createServer((q,r)=>{
  let f=q.url.split('?')[0];if(f==='/')f='/index.html';
  const p=path.join(PUB,f);
  if(!p.startsWith(PUB))return r.writeHead(403).end();
  fs.readFile(p,(e,d)=>{if(e)return r.writeHead(404).end('404');r.writeHead(200,{'Content-Type':types[path.extname(p)]||'text/plain'});r.end(d)});
});
const wss=new WebSocketServer({server});
const rooms=new Map();let nid=1;
const send=(p,m)=>p.ws.readyState===1&&p.ws.send(JSON.stringify(m));
const bc=(r,m)=>{for(const p of r.players.values())send(p,m)};
function mkRoom(pub){
  let code;do code=Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('');while(rooms.has(code));
  const r={code,pub,seed:Math.random()*1e9|0,players:new Map(),arrows:[]};
  r.trees=S.genTrees(r.seed);rooms.set(code,r);return r;
}
function spawn(r){
  for(let i=0;i<30;i++){const x=(Math.random()*2-1)*50,z=(Math.random()*2-1)*50;
    if(r.trees.every(t=>(t.x-x)**2+(t.z-z)**2>(t.r+1.5)**2))return{x,z}}
  return{x:0,z:0};
}
const num=(v,d=0)=>Number.isFinite(v)?v:d;
function applyMove(p,m){
  p.x=Math.max(-S.MAP,Math.min(S.MAP,num(m.x,p.x)));p.z=Math.max(-S.MAP,Math.min(S.MAP,num(m.z,p.z)));
  p.y=Math.max(0,Math.min(6,num(m.y,p.y)));p.yaw=num(m.yaw,p.yaw);p.pitch=Math.max(-1.5,Math.min(1.5,num(m.pitch,p.pitch)));
}
wss.on('connection',ws=>{
  let room=null,me=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='join'&&!room){
      let r;
      if(m.mode==='public'){r=[...rooms.values()].find(x=>x.pub&&x.players.size<MAXP)||mkRoom(true)}
      else if(m.mode==='create')r=mkRoom(false);
      else{r=rooms.get(String(m.code||'').toUpperCase());
        if(!r)return send({ws},{t:'err',msg:'Lobby not found'});
        if(r.players.size>=MAXP)return send({ws},{t:'err',msg:'Lobby is full'})}
      const s=spawn(r);
      me={id:nid++,ws,name:String(m.name||'Archer').slice(0,14),x:s.x,y:0,z:s.z,yaw:0,pitch:0,hearts:HP,score:0,kills:0,dead:false,respawnAt:0,lastShot:0};
      room=r;r.players.set(me.id,me);
      send(me,{t:'welcome',id:me.id,code:r.code,pub:r.pub,seed:r.seed,x:me.x,z:me.z});
    }else if(!me)return;
    else if(m.t==='m'&&!me.dead)applyMove(me,m);
    else if(m.t==='s'&&!me.dead){
      const now=Date.now();if(now-me.lastShot<600)return;me.lastShot=now;
      applyMove(me,m);const c=Math.max(.2,Math.min(1,num(m.c,.5))),sp=25+45*c;
      const dx=-Math.sin(me.yaw)*Math.cos(me.pitch),dy=Math.sin(me.pitch),dz=-Math.cos(me.yaw)*Math.cos(me.pitch);
      room.arrows.push({id:nid++,owner:me.id,x:me.x,y:me.y+1.6,z:me.z,vx:dx*sp,vy:dy*sp,vz:dz*sp,age:0});
    }
  });
  ws.on('close',()=>{if(!room)return;room.players.delete(me.id);if(!room.players.size)rooms.delete(room.code)});
});
function hit(r,a,v){
  const k=r.players.get(a.owner);v.hearts--;send(v,{t:'hurt'});
  if(v.hearts<=0){v.dead=true;v.respawnAt=Date.now()+3000;
    if(k){k.score+=100;k.kills++}
    bc(r,{t:'kill',k:k?k.name:'?',v:v.name,ki:k?k.id:0,vi:v.id});
  }else if(k)k.score+=25;
  if(k)send(k,{t:'hit'});
}
function step(r,dt){
  for(let i=r.arrows.length-1;i>=0;i--){
    const a=r.arrows[i];let gone=false;const n=4,h=dt/n;
    for(let s=0;s<n&&!gone;s++){
      a.vy-=S.G*h;a.x+=a.vx*h;a.y+=a.vy*h;a.z+=a.vz*h;
      if(a.y<=0||Math.abs(a.x)>S.MAP+5||Math.abs(a.z)>S.MAP+5){gone=true;break}
      for(const t of r.trees){const dx=a.x-t.x,dz=a.z-t.z;if(dx*dx+dz*dz<t.r*t.r&&a.y<t.h){gone=true;break}} // trees block arrows
      if(gone)break;
      for(const p of r.players.values()){
        if(p.id===a.owner||p.dead)continue;
        const dx=a.x-p.x,dz=a.z-p.z;
        if(dx*dx+dz*dz<.25&&a.y>p.y&&a.y<p.y+1.9){hit(r,a,p);gone=true;break}
      }
    }
    a.age+=dt;if(gone||a.age>8)r.arrows.splice(i,1);
  }
  const now=Date.now();
  for(const p of r.players.values())if(p.dead&&now>p.respawnAt){
    const s=spawn(r);p.dead=false;p.hearts=HP;p.x=s.x;p.z=s.z;p.y=0;send(p,{t:'rs',x:s.x,z:s.z});
  }
}
let tick=0;
setInterval(()=>{
  tick++;
  for(const r of rooms.values()){
    step(r,1/60);
    if(tick%2)continue; // 30 Hz snapshots
    bc(r,{t:'s',
      p:[...r.players.values()].map(p=>[p.id,p.name,p.x,p.y,p.z,p.yaw,p.pitch,p.hearts,p.score,p.dead?1:0,p.kills]),
      a:r.arrows.map(a=>[a.id,a.x,a.y,a.z,a.vx,a.vy,a.vz])});
  }
},1000/60);
server.listen(process.env.PORT||3000,()=>console.log('3D Archer on port',process.env.PORT||3000));
