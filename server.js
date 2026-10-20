const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const PUB=fs.existsSync(path.join(__dirname,'public','shared.js'))?path.join(__dirname,'public'):__dirname;
if(!fs.existsSync(path.join(PUB,'shared.js'))||!fs.existsSync(path.join(PUB,'index.html')))
  throw new Error('shared.js / index.html not found. Put them in a "public" folder next to server.js. Looked in: '+PUB);
const S=require(path.join(PUB,'shared.js'));
const MAXP=8,HP=3;
// ---- WEAPON TABLE (tweak freely). charge/reload in ms, speed in m/s, g = arrow gravity (0 = straight) ----
const W=[
  {name:'crossbow',charge:1500,reload:0,speed:95,g:0},
  {name:'bow',charge:500,reload:0,speed:45,g:S.G},
  {name:'musket',charge:0,reload:5000,speed:160,g:0},
  {name:'dagger',charge:0,reload:0,speed:85,g:0,miss:.5},
  {name:'knife',charge:0,reload:100,melee:2.6}
];
const types={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
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
function mkRoom(pub,mode='skirmish'){
  let code;do code=Array.from({length:5},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('');while(rooms.has(code));
  const r={code,pub,mode,seed:Math.random()*1e9|0,players:new Map(),arrows:[],mobs:[],mobsStarted:false,nextMobSpawn:0,bearsKilled:0,round:false,nextStart:0};
  r.trees=S.genTrees(r.seed);rooms.set(code,r);return r;
}
function spawn(r){ // skirmish: pick the free spot farthest from other living players
  let best={x:0,z:0},bd=-1;
  for(let i=0;i<12;i++){
    const x=(Math.random()*2-1)*50,z=(Math.random()*2-1)*50;
    if(!r.trees.every(t=>(t.x-x)**2+(t.z-z)**2>(t.r+1.5)**2))continue;
    let d=1e9;for(const p of r.players.values())if(!p.dead)d=Math.min(d,Math.hypot(p.x-x,p.z-z));
    if(d>bd){bd=d;best={x,z}}
  }
  return best;
}
const num=(v,d=0)=>Number.isFinite(v)?v:d;
function applyMove(p,m){
  p.x=Math.max(-S.MAP,Math.min(S.MAP,num(m.x,p.x)));p.z=Math.max(-S.MAP,Math.min(S.MAP,num(m.z,p.z)));
  p.y=Math.max(0,Math.min(6,num(m.y,p.y)));p.yaw=num(m.yaw,p.yaw);p.pitch=Math.max(-1.5,Math.min(1.5,num(m.pitch,p.pitch)));
}
function respawn(r,p){const s=spawn(r);p.dead=false;p.prot=Date.now()+2000;p.hearts=HP;p.x=s.x;p.z=s.z;p.y=0;send(p,{t:'rs',x:s.x,z:s.z})}
const MOB_RULES={chicken:{hp:1,points:10,radius:.3,height:.75,speed:.65},rabbit:{hp:2,points:15,radius:.3,height:.7,speed:.85},bear:{hp:5,points:50,radius:.65,height:1.8,speed:1.65}};
function spawnMob(r,type){
  const rule=MOB_RULES[type],minPlayerDistance=type==='bear'?14:6,maxPlayerDistance=type==='bear'?32:24;
  for(let i=0;i<40;i++){
    const x=(Math.random()*2-1)*(S.MAP-4),z=(Math.random()*2-1)*(S.MAP-4);
    if(!r.trees.every(t=>Math.hypot(t.x-x,t.z-z)>t.r+rule.radius+1))continue;
    const activePlayers=[...r.players.values()].filter(p=>!p.gameOver);
    if(activePlayers.length){const nearest=Math.min(...activePlayers.map(p=>Math.hypot(p.x-x,p.z-z)));if(nearest<minPlayerDistance||nearest>maxPlayerDistance)continue}
    if(!r.mobs.every(m=>Math.hypot(m.x-x,m.z-z)>m.radius+rule.radius+3))continue;
    const mob={id:nid++,type,x,y:0,z,hp:rule.hp,maxHp:rule.hp,radius:rule.radius,height:rule.height,speed:rule.speed,moveX:0,moveZ:0,moveUntil:0,attackAt:0};
    r.mobs.push(mob);return mob;
  }
  return null;
}
function maintainMobs(r,now){
  if(!r.mobsStarted){
    r.mobsStarted=true;
    for(const type of ['chicken','chicken','chicken','rabbit','rabbit','bear','bear','bear','bear','bear'])spawnMob(r,type);
    r.nextMobSpawn=now+2500;
  }
  if(now<r.nextMobSpawn)return;
  const counts={chicken:0,rabbit:0,bear:0};for(const mob of r.mobs)counts[mob.type]++;
  const bearTarget=5+Math.floor(r.bearsKilled/2);
  const next=counts.chicken<6?'chicken':counts.rabbit<4?'rabbit':counts.bear<bearTarget?'bear':null;
  if(next)spawnMob(r,next);
  r.nextMobSpawn=now+2500;
}
function damageMob(r,player,mob,damage){
  mob.hp=Math.max(0,mob.hp-damage);
  if(mob.hp>0)return;
  r.mobs.splice(r.mobs.indexOf(mob),1);
  if(mob.type==='bear'){
    r.bearsKilled++;
    const bearTarget=5+Math.floor(r.bearsKilled/2);
    let bearCount=r.mobs.filter(other=>other.type==='bear').length;
    while(bearCount<bearTarget&&spawnMob(r,'bear'))bearCount++;
  }
  player.score+=MOB_RULES[mob.type].points;
  const healed=mob.type==='bear'&&player.hearts<HP;
  if(healed)player.hearts=Math.min(HP,player.hearts+1);
  send(player,{t:'mobKill',mobType:mob.type,points:MOB_RULES[mob.type].points,healed});
}
function updateMobs(r,dt,now){
  for(const mob of r.mobs){
    let target=null,best=Infinity;
    if(mob.type==='bear')for(const p of r.players.values())if(!p.dead&&!p.gameOver){const d=Math.hypot(p.x-mob.x,p.z-mob.z);if(d<best){best=d;target=p}}
    if(target){
      const dx=target.x-mob.x,dz=target.z-mob.z,d=Math.hypot(dx,dz)||1;mob.moveX=dx/d;mob.moveZ=dz/d;
      if(d<mob.radius+.55&&now>=mob.attackAt){
        mob.attackAt=now+1100;target.hearts=Math.max(0,target.hearts-1);send(target,{t:'hurt'});
        if(target.hearts===0){
          target.dead=true;target.gameOver=true;
          target.survivedMs=now-target.survivalStart;
          send(target,{t:'gameover',survivedMs:target.survivedMs,score:target.score});
        }
      }
    }else if(now>=mob.moveUntil){
      const angle=Math.random()*Math.PI*2;mob.moveX=Math.cos(angle);mob.moveZ=Math.sin(angle);mob.moveUntil=now+900+Math.random()*2200;
    }
    const speed=target?mob.speed:mob.speed*.35,x=mob.x+mob.moveX*speed*dt,z=mob.z+mob.moveZ*speed*dt;
    if(Math.abs(x)<S.MAP-2&&Math.abs(z)<S.MAP-2&&r.trees.every(t=>Math.hypot(t.x-x,t.z-z)>t.r+mob.radius)){
      mob.x=x;mob.z=z;
    }else if(!target)mob.moveUntil=0;
  }
}
wss.on('connection',ws=>{
  let room=null,me=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='join'&&!room){
      let r;
      if(m.mode==='survival')r=mkRoom(false,'survival');
      else if(m.mode==='public')r=[...rooms.values()].find(x=>x.pub&&x.mode==='skirmish'&&x.players.size<MAXP)||mkRoom(true,'skirmish');
      else if(m.mode==='create')r=mkRoom(false);
      else{r=rooms.get(String(m.code||'').toUpperCase());
        if(!r)return send({ws},{t:'err',msg:'Lobby not found'});
        if(r.mode==='survival')return send({ws},{t:'err',msg:'Survival runs are solo'});
        if(r.players.size>=MAXP)return send({ws},{t:'err',msg:'Lobby is full'})}
      const s=spawn(r);
      me={id:nid++,ws,name:String(m.name||'Archer').slice(0,14),x:s.x,y:0,z:s.z,yaw:0,pitch:0,hearts:HP,score:0,kills:0,knifeSlash:2,
          survivalStart:r.mode==='survival'?Date.now():0,gameOver:false,
          dead:false,prot:Date.now()+2000,respawnAt:0,w:0,cs:0,ready:[0,0,0,0,0]};
      room=r;r.players.set(me.id,me);
      send(me,{t:'welcome',id:me.id,code:r.code,pub:r.pub,mode:r.mode,seed:r.seed,x:me.x,z:me.z});
    }else if(!me)return;
    else if(m.t==='m'&&!me.dead&&!me.gameOver)applyMove(me,m);
    else if(m.t==='w'&&!me.gameOver){me.w=Math.max(0,Math.min(W.length-1,m.i|0));me.cs=0}
    else if(m.t==='c'&&!me.dead&&!me.gameOver)me.cs=Date.now();
    else if(m.t==='s'&&!me.dead&&!me.gameOver){
      const now=Date.now(),w=W[me.w];
      if(now<me.ready[me.w])return;
      if(w.charge&&(!me.cs||now-me.cs<w.charge-250))return; // must have held the full charge (250ms lag grace)
      me.cs=0;me.ready[me.w]=now+w.reload;applyMove(me,m);
      const dx=-Math.sin(me.yaw)*Math.cos(me.pitch),dy=Math.sin(me.pitch),dz=-Math.cos(me.yaw)*Math.cos(me.pitch);
      if(w.melee){ // knife: nearest player in front within range = instant kill
        const slash=me.knifeSlash=(me.knifeSlash+1)%3;
        let best=null,bd=w.melee;
        if(room.mode==='survival'){
          for(const mob of room.mobs){
            const ex=mob.x-me.x,ey=mob.y+mob.height*.55-(me.y+1.6),ez=mob.z-me.z,d=Math.hypot(ex,ey,ez);
            if(d<bd&&(ex*dx+ey*dy+ez*dz)/d>.45){best=mob;bd=d}
          }
        }else for(const p of room.players.values()){
          if(p===me||p.dead||p.prot>Date.now())continue;
          const ex=p.x-me.x,ey=p.y+1-(me.y+1.6),ez=p.z-me.z,d=Math.hypot(ex,ey,ez);
          if(d<bd&&(ex*dx+ey*dy+ez*dz)/d>.6){best=p;bd=d}
        }
        if(best){
          const mob=room.mode==='survival',nx=me.x-best.x,ny=me.y+1.6-(best.y+(mob?best.height*.55:1)),nz=me.z-best.z,n=Math.hypot(nx,ny,nz)||1;
          bc(room,{t:'slash',style:slash,surface:mob?'mob':'player',x:best.x+nx/n*(mob?best.radius:.35),y:best.y+(mob?best.height*.55:1)+ny/n*.2,z:best.z+nz/n*(mob?best.radius:.35),nx:nx/n,ny:ny/n,nz:nz/n});
          if(mob)damageMob(room,me,best,1);else damage(room,me,best,HP,me.w);
        }else{
          let mark=null,markDistance=w.melee;
          const originY=me.y+1.6;
          for(const t of room.trees){
            const ox=me.x-t.x,oz=me.z-t.z,radius=t.r*(1-.2*originY/t.h),radiusSlope=-t.r*.2*dy/t.h;
            const qa=dx*dx+dz*dz-radiusSlope*radiusSlope,qb=2*(ox*dx+oz*dz-radius*radiusSlope),qc=ox*ox+oz*oz-radius*radius;
            const discriminant=qb*qb-4*qa*qc;
            if(discriminant<0)continue;
            const roots=qa? [(-qb-Math.sqrt(discriminant))/(2*qa),(-qb+Math.sqrt(discriminant))/(2*qa)]:[-qc/qb];
            for(const distance of roots){
              if(distance<=0||distance>=markDistance)continue;
              const x=me.x+dx*distance,y=originY+dy*distance,z=me.z+dz*distance;
              if(y<=0||y>=t.h)continue;
              const treeRadius=t.r*(1-.2*y/t.h),nx=x-t.x,nz=z-t.z,ny=treeRadius*.2*t.r/t.h,n=Math.hypot(nx,ny,nz)||1;
              mark={surface:'tree',x,y,z,nx:nx/n,ny:ny/n,nz:nz/n};markDistance=distance;break;
            }
          }
          if(dy<0){
            const distance=-originY/dy;
            if(distance>0&&distance<markDistance){mark={surface:'ground',x:me.x+dx*distance,y:0,z:me.z+dz*distance,nx:0,ny:1,nz:0};}
          }
          if(mark)bc(room,{t:'slash',style:slash,surface:mark.surface,x:mark.x,y:mark.y,z:mark.z,nx:mark.nx,ny:mark.ny,nz:mark.nz});
        }
      }else room.arrows.push({id:nid++,owner:me.id,k:me.w,g:w.g,miss:w.miss||0,skip:new Set(),
        x:me.x,y:me.y+1.6,z:me.z,vx:dx*w.speed,vy:dy*w.speed,vz:dz*w.speed,age:0,n:Math.max(4,Math.ceil(w.speed/60/.25))});
    }
  });
  ws.on('close',()=>{if(!room)return;room.players.delete(me.id);if(!room.players.size)rooms.delete(room.code)});
});
function damage(r,k,v,dmg,wi){
  v.hearts=Math.max(0,v.hearts-dmg);send(v,{t:'hurt'});
  if(v.hearts<=0){v.dead=true;v.respawnAt=Date.now()+3000;
    if(k){k.score+=100;k.kills++}
    bc(r,{t:'kill',k:k?k.name:'?',v:v.name,ki:k?k.id:0,vi:v.id,w:wi});
  }else if(k)k.score+=25;
  if(k)send(k,{t:'hit'});
}
function broadcastImpact(r,a,surface,x,y,z,nx,ny,nz,targetId=0){
  bc(r,{t:'impact',id:a.id,k:a.k,surface,x,y,z,nx,ny,nz,vx:a.vx,vy:a.vy,vz:a.vz,targetId});
}
function step(r,dt){
  const now=Date.now();
  if(r.mode==='survival'){maintainMobs(r,now);updateMobs(r,dt,now)}
  for(let i=r.arrows.length-1;i>=0;i--){
    const a=r.arrows[i];let gone=false;const h=dt/a.n;
    for(let s=0;s<a.n&&!gone;s++){
      a.vy-=a.g*h;a.x+=a.vx*h;a.y+=a.vy*h;a.z+=a.vz*h;
      if(a.y<=0){a.y=0;broadcastImpact(r,a,'ground',a.x,a.y,a.z,0,1,0);gone=true;break}
      if(Math.abs(a.x)>S.MAP+5||Math.abs(a.z)>S.MAP+5){gone=true;break}
      for(const t of r.trees){
        const dx=a.x-t.x,dz=a.z-t.z,d=Math.hypot(dx,dz);
        if(d<t.r&&a.y<t.h){const nx=dx/(d||1),nz=dz/(d||1);broadcastImpact(r,a,'tree',t.x+nx*t.r,a.y,t.z+nz*t.r,nx,0,nz);gone=true;break}
      } // trees block shots
      if(gone)break;
      if(r.mode==='survival')for(const mob of r.mobs){
        const dx=a.x-mob.x,dz=a.z-mob.z,dy=a.y-(mob.y+mob.height*.5);
        if(dx*dx+dz*dz<mob.radius*mob.radius&&a.y>mob.y&&a.y<mob.y+mob.height){
          const n=Math.hypot(dx,dy,dz)||1;broadcastImpact(r,a,'mob',a.x,a.y,a.z,dx/n,dy/n,dz/n);
          const owner=r.players.get(a.owner);if(owner&&!owner.gameOver)damageMob(r,owner,mob,1);
          gone=true;break;
        }
      }
      if(gone)break;
      for(const p of r.players.values()){
        if(p.id===a.owner||p.dead||p.prot>Date.now()||a.skip.has(p.id))continue; // 2s spawn protection
        const dx=a.x-p.x,dz=a.z-p.z;
        if(dx*dx+dz*dz<.25&&a.y>p.y&&a.y<p.y+1.9){
          if(a.miss&&Math.random()<a.miss){a.skip.add(p.id);continue} // dagger: 50% chance to miss
          const nx=dx,ny=a.y-(p.y+1),nz=dz,n=Math.hypot(nx,ny,nz)||1;
          broadcastImpact(r,a,'player',a.x,a.y,a.z,nx/n,ny/n,nz/n,p.id);
          damage(r,r.players.get(a.owner),p,1,a.k);gone=true;break;
        }
      }
    }
    a.age+=dt;if(gone||a.age>8)r.arrows.splice(i,1);
  }
  const ps=[...r.players.values()];
  if(r.mode!=='survival')for(const p of ps)if(p.dead&&now>p.respawnAt)respawn(r,p); // skirmish: respawn at a new location
}
let tick=0;
setInterval(()=>{
  tick++;
  for(const r of rooms.values()){
    step(r,1/60);
    if(tick%2)continue;
    const now=Date.now();
    bc(r,{t:'s',mode:r.mode,
      p:[...r.players.values()].map(p=>[p.id,p.name,p.x,p.y,p.z,p.yaw,p.pitch,p.hearts,p.score,p.dead?1:0,p.kills]),
      a:r.arrows.map(a=>[a.id,a.x,a.y,a.z,a.vx,a.vy,a.vz,a.g,a.k]),
      mobs:r.mode==='survival'?r.mobs.map(m=>[m.id,m.type,m.x,m.y,m.z,m.hp,m.maxHp]):[],
      sv:r.mode==='survival'?[...r.players.values()].map(p=>[p.id,p.gameOver?p.survivedMs:now-p.survivalStart,p.gameOver?1:0]):[]});
  }
},1000/60);
server.listen(process.env.PORT||3000,()=>console.log('3D Archer on port',process.env.PORT||3000));
