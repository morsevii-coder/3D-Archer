const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const PUB=fs.existsSync(path.join(__dirname,'public','shared.js'))?path.join(__dirname,'public'):__dirname;
if(!fs.existsSync(path.join(PUB,'shared.js'))||!fs.existsSync(path.join(PUB,'index.html')))
  throw new Error('shared.js / index.html not found. Put them in a "public" folder next to server.js. Looked in: '+PUB);
const S=require(path.join(PUB,'shared.js'));
// ---- TUNING: gameplay values (weapons, mobs, bots, timers, HP) live in config.json ----
const CFG=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
const P=CFG.player;
const MAXP=P.maxPlayers,HP=P.maxHp,HIT=P.bearHitDamage,AFK_MS=P.afkStrikeMs;
const W=CFG.weapons.map(w=>({name:w.name,damage:w.damage,charge:w.charge,reload:w.reload,speed:w.speed,g:w.gravity,miss:w.missChance,melee:w.meleeRange}));
const types={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((q,r)=>{
  let f=q.url.split('?')[0];if(f==='/')f='/index.html';
  const p=path.join(PUB,f);
  if(!p.startsWith(PUB))return r.writeHead(403).end();
  fs.readFile(p,(e,d)=>{
    if(e)return r.writeHead(404).end('404');
    if(f==='/index.html')d=Buffer.from(d.toString().replace('<!--CONFIG-->','<script>const CFG='+JSON.stringify(CFG)+';</script>'));
    r.writeHead(200,{'Content-Type':types[path.extname(p)]||'text/plain'});r.end(d)
  });
});
const wss=new WebSocketServer({server});
const rooms=new Map();let nid=1;
const send=(p,m)=>p.ws&&p.ws.readyState===1&&p.ws.send(JSON.stringify(m));
const bc=(r,m)=>{for(const p of r.players.values())send(p,m)};
function mkRoom(pub,mode='skirmish',difficulty=null){
  let code;do code=Array.from({length:5},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('');while(rooms.has(code));
  const r={code,pub,mode,difficulty,seed:Math.random()*1e9|0,players:new Map(),arrows:[],mobs:[],mobsStarted:false,nextMobSpawn:0,bearsKilled:0,round:false,nextStart:0};
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
  const ox=p.x,oy=p.y,oz=p.z,oyaw=p.yaw,opitch=p.pitch;
  p.x=Math.max(-S.MAP,Math.min(S.MAP,num(m.x,p.x)));p.z=Math.max(-S.MAP,Math.min(S.MAP,num(m.z,p.z)));
  p.y=Math.max(0,Math.min(6,num(m.y,p.y)));p.yaw=num(m.yaw,p.yaw);p.pitch=Math.max(-1.5,Math.min(1.5,num(m.pitch,p.pitch)));
  if(Math.abs(p.x-ox)+Math.abs(p.y-oy)+Math.abs(p.z-oz)>.01||Math.abs(p.yaw-oyaw)+Math.abs(p.pitch-opitch)>.01)p.lastActive=Date.now();
}
function respawn(r,p){const s=spawn(r);p.dead=false;p.prot=Date.now()+P.spawnProtectionMs;p.hp=HP;p.x=s.x;p.z=s.z;p.y=0;p.lastActive=Date.now();send(p,{t:'rs',x:s.x,z:s.z})}
const MOB_RULES=CFG.mobs,MS=CFG.mobSpawns;
function spawnMob(r,type){
  const rule=MOB_RULES[type],minPlayerDistance=rule.minPlayerDistance,maxPlayerDistance=rule.maxPlayerDistance;
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
    for(const [type,n] of Object.entries(MS.initial))for(let i=0;i<n;i++)spawnMob(r,type);
    r.nextMobSpawn=now+MS.intervalMs;
  }
  if(now<r.nextMobSpawn)return;
  const counts={chicken:0,rabbit:0,pig:0,bear:0};for(const mob of r.mobs)counts[mob.type]++;
  const bearTarget=MS.bearBase+Math.floor(r.bearsKilled/MS.bearKillsPerExtra);
  const next=Object.keys(MS.maxCounts).find(t=>counts[t]<MS.maxCounts[t])||(counts.bear<bearTarget?'bear':null);
  if(next)spawnMob(r,next);
  r.nextMobSpawn=now+MS.intervalMs;
}
function damageMob(r,player,mob,damage){
  mob.hp=Math.max(0,mob.hp-damage);
  if(mob.hp>0)return;
  r.mobs.splice(r.mobs.indexOf(mob),1);
  if(mob.type==='bear'){
    r.bearsKilled++;
    const bearTarget=MS.bearBase+Math.floor(r.bearsKilled/MS.bearKillsPerExtra);
    let bearCount=r.mobs.filter(other=>other.type==='bear').length;
    while(bearCount<bearTarget&&spawnMob(r,'bear'))bearCount++;
  }
  player.score+=MOB_RULES[mob.type].points;
  const healed=mob.type==='bear'&&player.hp<HP;
  if(healed)player.hp=Math.min(HP,player.hp+P.bearKillHeal);
  send(player,{t:'mobKill',mobType:mob.type,points:MOB_RULES[mob.type].points,healed});
}
function updateMobs(r,dt,now){
  for(const mob of r.mobs){
    let target=null,best=Infinity;
    if(mob.type==='bear')for(const p of r.players.values())if(!p.dead&&!p.gameOver){const d=Math.hypot(p.x-mob.x,p.z-mob.z);if(d<best){best=d;target=p}}
    if(target){
      const dx=target.x-mob.x,dz=target.z-mob.z,d=Math.hypot(dx,dz)||1;mob.moveX=dx/d;mob.moveZ=dz/d;
      if(d<mob.radius+MOB_RULES.bear.attackRange&&now>=mob.attackAt){
        mob.attackAt=now+MOB_RULES.bear.attackCooldownMs;target.hp=Math.max(0,target.hp-HIT);send(target,{t:'hurt'});
        if(target.hp===0){
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
const BOT_LEVELS=CFG.bots;
function addBot(r){
  const level=r.difficulty,s=spawn(r),id=nid++;
  r.players.set(id,{id,bot:true,level,name:'Bot ('+level[0].toUpperCase()+level.slice(1)+')',x:s.x,y:0,z:s.z,yaw:0,  pitch:0,hp:HP,score:0,kills:0,knifeSlash:2,
    survivalStart:0,gameOver:false,dead:false,prot:Date.now()+P.spawnProtectionMs,respawnAt:0,w:0,cs:0,ready:[0,0,0,0,0],
    ai:{target:0,aimAt:0,nextFireAt:0,strafe:1,turnAt:0,wx:0,wz:0,lx:0,lz:0,vx:0,vz:0}});
}
function clearShot(r,x0,z0,x1,z1){
  const vx=x1-x0,vz=z1-z0,len2=vx*vx+vz*vz||1;
  return r.trees.every(t=>{
    const u=Math.max(0,Math.min(1,((t.x-x0)*vx+(t.z-z0)*vz)/len2));
    return Math.hypot(x0+vx*u-t.x,z0+vz*u-t.z)>t.r+.1;
  });
}
function pickStep(r,x,z,mx,mz,step){
  const base=Math.atan2(mz,mx);
  for(const off of [0,.5,-.5,1,-1,1.6,-1.6,2.4,-2.4]){
    const dx=Math.cos(base+off),dz=Math.sin(base+off),nx=x+dx*step,nz=z+dz*step;
    if(Math.abs(nx)<=S.MAP&&Math.abs(nz)<=S.MAP&&r.trees.every(t=>Math.hypot(t.x-nx,t.z-nz)>t.r+.45))return [dx,dz];
  }
  return null;
}
function updateBots(r,dt,now){
  for(const bot of r.players.values()){
    if(!bot.bot||bot.dead)continue;
    const ai=bot.ai,L=BOT_LEVELS[bot.level];
    let target=null,best=Infinity;
    for(const p of r.players.values()){
      if(p===bot||p.dead||p.gameOver||p.prot>now)continue;
      const d=Math.hypot(p.x-bot.x,p.z-bot.z);
      if(d<best){best=d;target=p}
    }
    if(!target){ai.target=0}
    else if(target.id!==ai.target){ai.target=target.id;ai.aimAt=now+L.reaction;ai.lx=target.x;ai.lz=target.z;ai.vx=ai.vz=0}
    let mx,mz,speed=L.speed;
    if(target){
      const dx=target.x-bot.x,dz=target.z-bot.z,d=Math.hypot(dx,dz)||1,ux=dx/d,uz=dz/d;
      if(now>=ai.turnAt){ai.strafe=-ai.strafe;ai.turnAt=now+L.dodgeMs*(.6+Math.random()*.8)}
      const forward=d>L.range+3?1:d<L.range-3?-1:0;
      mx=ux*forward-uz*ai.strafe*.8;mz=uz*forward+ux*ai.strafe*.8;
    }else{
      if(now>=ai.turnAt){const a=Math.random()*Math.PI*2;ai.wx=Math.cos(a);ai.wz=Math.sin(a);ai.turnAt=now+1500+Math.random()*2000}
      mx=ai.wx;mz=ai.wz;speed=L.speed*.4;
    }
    const ml=Math.hypot(mx,mz)||1;mx/=ml;mz/=ml;
    const dir=pickStep(r,bot.x,bot.z,mx,mz,speed*dt);
    if(dir){bot.x+=dir[0]*speed*dt;bot.z+=dir[1]*speed*dt;mx=dir[0];mz=dir[1]}
    else ai.turnAt=0;
    if(Math.hypot(mx,mz)>0)bot.yaw=Math.atan2(-mx,-mz);
    if(!target)continue;
    ai.vx=ai.vx*.8+(target.x-ai.lx)/dt*.2;ai.vz=ai.vz*.8+(target.z-ai.lz)/dt*.2;ai.lx=target.x;ai.lz=target.z;
    const dist=Math.hypot(target.x-bot.x,target.z-bot.z),W0=W[0];
    let tx=target.x,tz=target.z;
    if(L.lead){const t=dist/W0.speed;tx+=ai.vx*t;tz+=ai.vz*t}
    const ex=tx-bot.x,ez=tz-bot.z,ey=target.y+1-(bot.y+1.6),h=Math.hypot(ex,ez)||1;
    const aimYaw=Math.atan2(-ex,-ez),aimPitch=Math.atan2(ey,h);
    bot.yaw=aimYaw;bot.pitch=aimPitch;
    if(now>=ai.aimAt&&now>=ai.nextFireAt&&dist<=L.fire&&clearShot(r,bot.x,bot.z,target.x,target.z)){
      ai.nextFireAt=now+L.interval;
      const yaw=aimYaw+(Math.random()*2-1)*L.aim,pitch=aimPitch+(Math.random()*2-1)*L.aim;
      const dx=-Math.sin(yaw)*Math.cos(pitch),dy=Math.sin(pitch),dz=-Math.cos(yaw)*Math.cos(pitch);
      r.arrows.push({id:nid++,owner:bot.id,k:0,g:W0.g,miss:0,skip:new Set(),
        x:bot.x,y:bot.y+1.6,z:bot.z,vx:dx*W0.speed,vy:dy*W0.speed,vz:dz*W0.speed,age:0,n:Math.max(4,Math.ceil(W0.speed/60/.25))});
    }
  }
}
wss.on('connection',ws=>{
  let room=null,me=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='join'&&!room){
      let r;
      if(m.mode==='survival')r=mkRoom(false,'survival');
      else if(m.mode==='bot')r=mkRoom(false,'bot',BOT_LEVELS[m.difficulty]?m.difficulty:'normal');
      else if(m.mode==='public')r=[...rooms.values()].find(x=>x.pub&&x.mode==='skirmish'&&x.players.size<MAXP)||mkRoom(true,'skirmish');
      else if(m.mode==='create')r=mkRoom(false);
      else{r=rooms.get(String(m.code||'').toUpperCase());
        if(!r)return send({ws},{t:'err',msg:'Lobby not found'});
        if(r.mode==='survival')return send({ws},{t:'err',msg:'Survival runs are solo'});
        if(r.mode==='bot')return send({ws},{t:'err',msg:'Bot matches are solo'});
        if(r.players.size>=MAXP)return send({ws},{t:'err',msg:'Lobby is full'})}
      const s=spawn(r);
      me={id:nid++,ws,name:String(m.name||'Archer').slice(0,14),x:s.x,y:0,z:s.z,yaw:0,      pitch:0,hp:HP,score:0,kills:0,knifeSlash:2,
          survivalStart:r.mode==='survival'?Date.now():0,gameOver:false,lastActive:Date.now(),
          dead:false,prot:Date.now()+P.spawnProtectionMs,respawnAt:0,w:0,cs:0,ready:[0,0,0,0,0]};
      room=r;r.players.set(me.id,me);
      if(r.mode==='bot')addBot(r);
      send(me,{t:'welcome',id:me.id,code:r.code,pub:r.pub,mode:r.mode,difficulty:r.difficulty,seed:r.seed,x:me.x,z:me.z});
    }else if(!me)return;
    else if(m.t==='m'&&!me.dead&&!me.gameOver)applyMove(me,m);
    else if(m.t==='w'&&!me.gameOver){me.w=Math.max(0,Math.min(W.length-1,m.i|0));me.cs=0;me.lastActive=Date.now()}
    else if(m.t==='c'&&!me.dead&&!me.gameOver){me.cs=Date.now();me.lastActive=me.cs}
    else if(m.t==='s'&&!me.dead&&!me.gameOver){
      const now=Date.now(),w=W[me.w];
      if(now<me.ready[me.w])return;
      if(w.charge&&(!me.cs||now-me.cs<w.charge-250))return; // must have held the full charge (250ms lag grace)
      me.cs=0;me.ready[me.w]=now+w.reload;me.lastActive=now;applyMove(me,m);
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
          if(mob)damageMob(room,me,best,w.damage);else damage(room,me,best,w.damage,me.w);
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
  ws.on('close',()=>{if(!room)return;room.players.delete(me.id);if(![...room.players.values()].some(p=>!p.bot))rooms.delete(room.code)});
});
function damage(r,k,v,dmg,wi){
  v.hp=Math.max(0,v.hp-dmg);send(v,{t:'hurt'});
  if(v.hp<=0){v.dead=true;v.respawnAt=Date.now()+P.respawnDelayMs;
    if(k){k.score+=P.killPoints;k.kills++}
    bc(r,{t:'kill',k:k?k.name:'?',v:v.name,ki:k?k.id:0,vi:v.id,w:wi});
  }else if(k)k.score+=P.hitPoints;
  if(k)send(k,{t:'hit'});
}
function broadcastImpact(r,a,surface,x,y,z,nx,ny,nz,targetId=0){
  bc(r,{t:'impact',id:a.id,k:a.k,surface,x,y,z,nx,ny,nz,vx:a.vx,vy:a.vy,vz:a.vz,targetId});
}
function afkStrike(r,p,now){
  const kind=Math.random()<.5?'lightning':'anvil';
  bc(r,{t:'hazard',kind,x:p.x,z:p.z,vi:p.id,v:p.name});
  p.hp=0;
  if(r.mode==='survival'){p.dead=true;p.gameOver=true;p.survivedMs=now-p.survivalStart;send(p,{t:'gameover',survivedMs:p.survivedMs,score:p.score})}
  else{p.dead=true;p.respawnAt=now+P.respawnDelayMs}
}
function step(r,dt){
  const now=Date.now();
  for(const p of r.players.values())if(!p.bot&&!p.dead&&!p.gameOver&&now-p.lastActive>=AFK_MS)afkStrike(r,p,now);
  if(r.mode==='survival'){maintainMobs(r,now);updateMobs(r,dt,now)}
  if(r.mode==='bot')updateBots(r,dt,now);
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
          const owner=r.players.get(a.owner);if(owner&&!owner.gameOver)damageMob(r,owner,mob,W[a.k].damage);
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
          damage(r,r.players.get(a.owner),p,W[a.k].damage,a.k);gone=true;break;
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
      p:[...r.players.values()].map(p=>[p.id,p.name,p.x,p.y,p.z,p.yaw,p.pitch,p.hp,p.score,p.dead?1:0,p.kills]),
      a:r.arrows.map(a=>[a.id,a.x,a.y,a.z,a.vx,a.vy,a.vz,a.g,a.k]),
      mobs:r.mode==='survival'?r.mobs.map(m=>[m.id,m.type,m.x,m.y,m.z,m.hp,m.maxHp]):[],
      sv:r.mode==='survival'?[...r.players.values()].map(p=>[p.id,p.gameOver?p.survivedMs:now-p.survivalStart,p.gameOver?1:0]):[]});
  }
},1000/60);
server.listen(process.env.PORT||3000,()=>console.log('3D Archer on port',process.env.PORT||3000));
