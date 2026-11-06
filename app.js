import {parseSurfaceEquation} from './parser.mjs';
import {XRPanel,clamp,rayFromMatrix,modelXRMatrix,quatMultiply,quatAxisAngle,quaternionFromPose,relativeControllerRotation,menuPositionFromRay,translatedMenuCenter,nextMeshResolution} from './xr-panel.mjs';
import {XRPlanarShadow,planeFromHitMatrix,modelClearance} from './xr-spatial.mjs';
import {findTableFit,fitScaleFromWidth,measureShortEdge} from './xr-table-fit.mjs';

const $=id=>document.getElementById(id);
const canvas=$('gl-canvas'), stage=$('stage-wrap'), video=$('camera-video');
const equation=$('equation'), feedback=$('feedback'), notice=$('notice');
let inputMode='explicit';
const gl=canvas.getContext('webgl2',{alpha:true,antialias:true,preserveDrawingBuffer:true,xrCompatible:true}) || canvas.getContext('webgl',{alpha:true,antialias:true,preserveDrawingBuffer:true,xrCompatible:true});
if(!gl){$('surface-stats').textContent='Este navegador no dispone de WebGL.';throw new Error('WebGL no disponible');}

// All maths and rendering operate locally; no external services or dependencies.
const state={domain:5,height:1,resolution:55,style:'both',palette:0,axes:true,grid:true,mode:'3d',surfaceType:'explicit',
  yaw:0.7,pitch:0.48,distance:5.8,target:[0,0,0],compiled:null,parameters:{},data:null,
  pointer:null,cameraStream:null,xrSession:null,xrSpace:null,xrModel:null,xrPose:null,
  program:null,lineProgram:null,surface:null,wire:null,axesBuffer:null,gridBuffer:null};

function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
function program(v,f){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,v));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,f));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;}
const vert=`attribute vec3 aPosition;attribute vec3 aNormal;attribute float aHeat;
uniform mat4 uMVP;varying vec3 vNormal;varying float vHeat;
void main(){gl_Position=uMVP*vec4(aPosition,1.0);vNormal=aNormal;vHeat=aHeat;}`;
const frag=`precision mediump float;varying vec3 vNormal;varying float vHeat;uniform float uPalette;
vec3 getColor(float t){
  vec3 low=vec3(.12,.47,.74),mid=vec3(.27,.80,.76),high=vec3(.98,.47,.31);
  if(uPalette>2.5){low=vec3(.25,.47,.64);mid=vec3(.40,.68,.78);high=vec3(.68,.86,.90);}
  else if(uPalette>1.5){low=vec3(.43,.29,.81);mid=vec3(.73,.48,.87);high=vec3(.99,.58,.70);}
  else if(uPalette>.5){low=vec3(.04,.47,.57);mid=vec3(.30,.76,.70);high=vec3(1.0,.75,.38);}
  return t<.5?mix(low,mid,t*2.0):mix(mid,high,(t-.5)*2.0);
}
void main(){vec3 n=normalize(vNormal);vec3 l=normalize(vec3(-.38,.85,.47));float light=.53+.47*abs(dot(n,l));
  vec3 color=getColor(clamp(vHeat,0.,1.));float highlight=pow(max(dot(n,normalize(vec3(.15,1.,.65))),0.),12.)*.13;
  gl_FragColor=vec4(color*light+highlight,1.0);}`;
const lineVert=`attribute vec3 aPosition;attribute vec3 aColor;uniform mat4 uMVP;varying vec3 vColor;
void main(){gl_Position=uMVP*vec4(aPosition,1.0);vColor=aColor;}`;
const lineFrag=`precision mediump float;varying vec3 vColor;uniform float uOpacity;void main(){gl_FragColor=vec4(vColor,uOpacity);}`;
state.program=program(vert,frag);state.lineProgram=program(lineVert,lineFrag);
const attribs={surf:{p:gl.getAttribLocation(state.program,'aPosition'),n:gl.getAttribLocation(state.program,'aNormal'),t:gl.getAttribLocation(state.program,'aHeat'),mvp:gl.getUniformLocation(state.program,'uMVP'),palette:gl.getUniformLocation(state.program,'uPalette')},
  line:{p:gl.getAttribLocation(state.lineProgram,'aPosition'),c:gl.getAttribLocation(state.lineProgram,'aColor'),mvp:gl.getUniformLocation(state.lineProgram,'uMVP'),opacity:gl.getUniformLocation(state.lineProgram,'uOpacity')}};
gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);

function createBuffer(values){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);return {buffer:b,count:values.length/6};}
function drop(b){if(b?.buffer)gl.deleteBuffer(b.buffer);if(b?.indices)gl.deleteBuffer(b.indices);}
const vec=(x,y,z)=>[x,y,z];
function pushLine(dest,a,b,color){dest.push(...a,...color,...b,...color);}
function heightAt(x,y,params){try{const v=state.compiled.evaluate({...params,x,y});return typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e9?v:null;}catch{return null;}}
function paramDefault(key){return key.toLowerCase()==='k'?1.5:key.toLowerCase()==='a'?1:1;}
function regenerateParametric() {
  const res=state.resolution,n=res+1;
  const uMin=Number($('u-min').value),uMax=Number($('u-max').value),vMin=Number($('v-min').value),vMax=Number($('v-max').value);
  if(![uMin,uMax,vMin,vMax].every(Number.isFinite)||uMax<=uMin||vMax<=vMin)throw new Error('Los límites de u y v deben ser números válidos y crecientes.');
  const samples=new Array(n*n).fill(null),bounds=[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]];let valid=0;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    const u=uMin+(uMax-uMin)*j/res,v=vMin+(vMax-vMin)*i/res,scope={...state.parameters,u,v};
    const point=[state.compiled.x.evaluate(scope),state.compiled.y.evaluate(scope),state.compiled.z.evaluate(scope)];
    if(!point.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<1e9))continue;
    samples[i*n+j]=point;valid++;for(let k=0;k<3;k++){bounds[k][0]=Math.min(bounds[k][0],point[k]);bounds[k][1]=Math.max(bounds[k][1],point[k]);}
  }
  if(!valid)throw new Error('La superficie no tiene valores reales y finitos en este dominio.');
  const center=bounds.map(([a,b])=>(a+b)/2),span=Math.max(...bounds.map(([a,b])=>b-a),1e-8),scale=2.4/span;
  const pos=samples.map(p=>p&&[(p[0]-center[0])*scale,(p[2]-center[2])*scale*state.height,(p[1]-center[1])*scale]);
  const verts=[],tri=[],lines=[],wireColor=[.18,.32,.41],sub=(a,b)=>a.map((x,k)=>x-b[k]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    const k=i*n+j,p=pos[k];if(!p){verts.push(0,0,0,0,1,0,0);continue;}
    const l=j?pos[k-1]:null,r=j<res?pos[k+1]:null,b=i?pos[k-n]:null,f=i<res?pos[k+n]:null;
    const du=l&&r?sub(r,l):r?sub(r,p):l?sub(p,l):[0,0,0],dv=b&&f?sub(f,b):f?sub(f,p):b?sub(p,b):[0,0,0];
    let normal=cross(dv,du),length=Math.hypot(...normal);if(length<1e-10){normal=[0,1,0];length=1;}
    const z=samples[k][2],zSpan=bounds[2][1]-bounds[2][0],heat=zSpan?(z-bounds[2][0])/zSpan:.5;
    verts.push(...p,normal[0]/length,normal[1]/length,normal[2]/length,heat);
  }
  const ok=k=>Boolean(pos[k]);
  for(let i=0;i<res;i++)for(let j=0;j<res;j++){const a=i*n+j,b=a+1,c=a+n,d=c+1;if(ok(a)&&ok(b)&&ok(c))tri.push(a,c,b);if(ok(b)&&ok(c)&&ok(d))tri.push(b,c,d);}
  function segment(a,b){if(!ok(a)||!ok(b))return;const p=[...pos[a]],q=[...pos[b]];p[1]+=.003;q[1]+=.003;pushLine(lines,p,q,wireColor);}
  for(let i=0;i<=res;i++)for(let j=0;j<res;j++)segment(i*n+j,i*n+j+1);
  for(let j=0;j<=res;j++)for(let i=0;i<res;i++)segment(i*n+j,(i+1)*n+j);
  drop(state.surface);drop(state.wire);
  const vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
  const ibo=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(tri),gl.STATIC_DRAW);
  state.surface={buffer:vbo,indices:ibo,count:tri.length};state.wire=createBuffer(lines);state.data={min:bounds[2][0],max:bounds[2][1],valid,total:n*n,triangles:tri.length/3};
  $('surface-stats').textContent=valid.toLocaleString('es-ES')+' puntos válidos · '+Math.round(tri.length/3).toLocaleString('es-ES')+' triángulos · z ∈ ['+fmt(bounds[2][0])+', '+fmt(bounds[2][1])+']';
}
function regenerate() {
  if(state.surfaceType==='parametric'){regenerateParametric();return;}
  if(!state.compiled)return;
  const res=state.resolution,n=res+1,D=state.domain, vals=new Array(n*n);let min=Infinity,max=-Infinity,valid=0;
  const params=state.parameters;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    const x=-D+2*D*j/res,y=-D+2*D*i/res,v=heightAt(x,y,params);
    vals[i*n+j]=v;
    if(v!==null){min=Math.min(min,v);max=Math.max(max,v);valid++;}
  }
  if(!valid)throw new Error('La ecuación no tiene valores reales y finitos en este dominio.');
  const amp=Math.max(Math.abs(min),Math.abs(max),1e-8),elev=v=>v/amp*1.12*state.height;
  const pos=[],norm=[],heat=[];
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    const v=vals[i*n+j],h=v===null?0:elev(v),x=-1.2+2.4*j/res,z=-1.2+2.4*i/res;
    const current=i*n+j;
    let dx=0,dz=0;
    if(v!==null){const L=j>0?vals[current-1]:null,R=j<res?vals[current+1]:null,
      B=i>0?vals[current-n]:null,F=i<res?vals[current+n]:null;
      if(L!==null&&R!==null)dx=(elev(R)-elev(L))/(4.8/res);
      else if(R!==null)dx=(elev(R)-h)/(2.4/res);
      else if(L!==null)dx=(h-elev(L))/(2.4/res);
      if(B!==null&&F!==null)dz=(elev(F)-elev(B))/(4.8/res);
      else if(F!==null)dz=(elev(F)-h)/(2.4/res);
      else if(B!==null)dz=(h-elev(B))/(2.4/res);
    }
    const len=Math.hypot(dx,1,dz)||1;
    pos.push(x,h,z);norm.push(-dx/len,1/len,-dz/len);heat.push(v===null?0:(v/amp+1)/2);
  }
  const verts=[],tri=[],lines=[];
  for(let k=0;k<pos.length/3;k++)verts.push(...pos.slice(k*3,k*3+3),...norm.slice(k*3,k*3+3),heat[k]);
  const wireCol=[.18,.32,.41];
  const p=(k)=>pos.slice(k*3,k*3+3);
  for(let i=0;i<res;i++)for(let j=0;j<res;j++){
    const a=i*n+j,b=a+1,c=a+n,d=c+1;
    if(vals[a]!==null&&vals[b]!==null&&vals[c]!==null)tri.push(a,c,b);
    if(vals[b]!==null&&vals[c]!==null&&vals[d]!==null)tri.push(b,c,d);
  }
  // Sparse overlay lines keep the mesh readable even for high-resolution surfaces.
  // Draw every grid interval: the visible wire density now tracks the chosen resolution.
  const step=1;
  function segment(a,b){if(vals[a]===null||vals[b]===null)return;const pa=p(a),pb=p(b);pa[1]+=.003;pb[1]+=.003;pushLine(lines,pa,pb,wireCol);}
  for(let i=0;i<=res;i+=step)for(let j=0;j<res;j++)segment(i*n+j,i*n+j+1);
  for(let j=0;j<=res;j+=step)for(let i=0;i<res;i++)segment(i*n+j,(i+1)*n+j);
  drop(state.surface);drop(state.wire);
  const vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
  const ibo=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(tri),gl.STATIC_DRAW);
  state.surface={buffer:vbo,indices:ibo,count:tri.length};state.wire=createBuffer(lines);
  state.data={min,max,valid,total:n*n,triangles:tri.length/3,amp};
  $('surface-stats').textContent=`${valid.toLocaleString('es-ES')} puntos válidos · ${Math.round(tri.length/3).toLocaleString('es-ES')} triángulos · z ∈ [${fmt(min)}, ${fmt(max)}]`;
}
function fmt(v){return Math.abs(v)>=1000?v.toExponential(2):Number(v.toFixed(3)).toLocaleString('es-ES');}
function axesBuffers(){const axes=[],grid=[];
  pushLine(axes,[-1.45,0,0],[1.47,0,0],[1,.44,.42]); // mathematical x
  pushLine(axes,[0,0,-1.45],[0,0,1.47],[.45,.88,.62]); // mathematical y
  pushLine(axes,[0,-1.52,0],[0,1.62,0],[.39,.66,1]); // mathematical z
  for(let i=-6;i<=6;i++){
    const c=i===0?[.16,.34,.39]:[.12,.21,.27];const a=i*.2;
    pushLine(grid,[a,-.015,-1.2],[a,-.015,1.2],c);
    pushLine(grid,[-1.2,-.015,a],[1.2,-.015,a],c);
  }
  state.axesBuffer=createBuffer(axes);state.gridBuffer=createBuffer(grid);
}
axesBuffers();

function perspective(fov,aspect,near,far){const f=1/Math.tan(fov/2),r=1/(near-far);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*r,-1,0,0,2*far*near*r,0]);}
function lookAt(eye,at,up=[0,1,0]){
  const normalize=v=>{const n=Math.hypot(...v)||1;return v.map(e=>e/n);};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const z=normalize(eye.map((e,i)=>e-at[i])),x=normalize(cross(up,z)),y=cross(z,x);
  return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-x.reduce((s,v,i)=>s+v*eye[i],0),-y.reduce((s,v,i)=>s+v*eye[i],0),-z.reduce((s,v,i)=>s+v*eye[i],0),1]);
}
function mul(a,b){const c=new Float32Array(16);for(let j=0;j<4;j++)for(let i=0;i<4;i++)for(let k=0;k<4;k++)c[j*4+i]+=a[k*4+i]*b[j*4+k];return c;}
function modelMatrix(tx=0,ty=0,tz=0,scale=1){return new Float32Array([scale,0,0,0,0,scale,0,0,0,0,scale,0,tx,ty,tz,1]);}
function drawLines(buffer,mvp,opacity=1){if(!buffer||!buffer.count)return;
  for(const index of [attribs.surf.p,attribs.surf.n,attribs.surf.t])if(index!==attribs.line.p&&index!==attribs.line.c)gl.disableVertexAttribArray(index);
  gl.useProgram(state.lineProgram);gl.uniformMatrix4fv(attribs.line.mvp,false,mvp);gl.uniform1f(attribs.line.opacity,opacity);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer.buffer);gl.enableVertexAttribArray(attribs.line.p);gl.enableVertexAttribArray(attribs.line.c);
  gl.vertexAttribPointer(attribs.line.p,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(attribs.line.c,3,gl.FLOAT,false,24,12);
  gl.drawArrays(gl.LINES,0,buffer.count);
}
function drawSurface(mvp){if(!state.surface?.count)return;
  for(const index of [attribs.line.p,attribs.line.c])if(index!==attribs.surf.p&&index!==attribs.surf.n&&index!==attribs.surf.t)gl.disableVertexAttribArray(index);
  gl.useProgram(state.program);gl.uniformMatrix4fv(attribs.surf.mvp,false,mvp);gl.uniform1f(attribs.surf.palette,state.palette);
  gl.bindBuffer(gl.ARRAY_BUFFER,state.surface.buffer);
  gl.enableVertexAttribArray(attribs.surf.p);gl.enableVertexAttribArray(attribs.surf.n);gl.enableVertexAttribArray(attribs.surf.t);
  gl.vertexAttribPointer(attribs.surf.p,3,gl.FLOAT,false,28,0);
  gl.vertexAttribPointer(attribs.surf.n,3,gl.FLOAT,false,28,12);
  gl.vertexAttribPointer(attribs.surf.t,1,gl.FLOAT,false,28,24);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,state.surface.indices);
  gl.drawElements(gl.TRIANGLES,state.surface.count,gl.UNSIGNED_SHORT,0);
}
function drawScene(mvp){
  if(state.grid){gl.disable(gl.DEPTH_TEST);drawLines(state.gridBuffer,mvp,state.mode==='camera'?.65:.52);gl.enable(gl.DEPTH_TEST);}
  if(state.style!=='wire')drawSurface(mvp);
  if(state.style!=='solid'){if(state.style==='wire')gl.disable(gl.DEPTH_TEST);drawLines(state.wire,mvp,state.style==='wire'?1:.75);gl.enable(gl.DEPTH_TEST);}
  if(state.axes){gl.disable(gl.DEPTH_TEST);drawLines(state.axesBuffer,mvp,.95);gl.enable(gl.DEPTH_TEST);}
}
function resize(){const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
  const bw=Math.max(1,Math.round(w*dpr)),bh=Math.max(1,Math.round(h*dpr));
  if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh;}}
function frame(){if(state.xrSession)return;resize();gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  const x=state.target[0]+Math.sin(state.yaw)*Math.cos(state.pitch)*state.distance;
  const y=state.target[1]+Math.sin(state.pitch)*state.distance;
  const z=state.target[2]+Math.cos(state.yaw)*Math.cos(state.pitch)*state.distance;
  const vp=mul(perspective(Math.PI/4,canvas.width/canvas.height,.03,100),lookAt([x,y,z],state.target));
  drawScene(vp);requestAnimationFrame(frame);
}

function setFeedback(message,error=false){feedback.textContent=message;feedback.classList.toggle('error',error);}
let noticeTimer;
function showNotice(msg){notice.textContent=msg;notice.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.hidden=true,7000);}
function makeParams(keys){const parent=$('params');parent.replaceChildren();$('params-section').classList.toggle('hidden',!keys.length);
  for(const key of keys){if(!(key in state.parameters))state.parameters[key]=paramDefault(key);
    const wrap=document.createElement('div'),hdr=document.createElement('div'),lab=document.createElement('label'),out=document.createElement('output'),r=document.createElement('input');
    wrap.className='param-item';hdr.className='field-head';lab.textContent=key;out.textContent=Number(state.parameters[key]).toFixed(1);
    r.type='range';r.min='-5';r.max='5';r.step='0.1';r.value=state.parameters[key];r.setAttribute('aria-label',`Parámetro ${key}`);
    r.addEventListener('input',()=>{state.parameters[key]=Number(r.value);out.textContent=Number(r.value).toFixed(1);try{regenerate();setFeedback('Parámetros actualizados.');}catch(e){setFeedback(e.message,true);}});
    hdr.append(lab,out);wrap.append(hdr,r);parent.append(wrap);
  }
}
function submitParametric(){try{
  const x=parseSurfaceEquation($('param-x').value,['u','v']),y=parseSurfaceEquation($('param-y').value,['u','v']),z=parseSurfaceEquation($('param-z').value,['u','v']);
  const parameters=[...new Set([...x.parameters,...y.parameters,...z.parameters])];if(parameters.length>4)throw new Error('La superficie admite hasta cuatro parámetros libres.');
  const next={x,y,z,parameters,expression:'x='+x.expression+'; y='+y.expression+'; z='+z.expression};
  const previous={compiled:state.compiled,parameters:state.parameters,surfaceType:state.surfaceType};state.compiled=next;state.parameters={};state.surfaceType='parametric';
  for(const key of parameters)state.parameters[key]=previous.parameters[key]??paramDefault(key);
  try{regenerate();}catch(error){state.compiled=previous.compiled;state.parameters=previous.parameters;state.surfaceType=previous.surfaceType;throw error;}
  makeParams(parameters);setFeedback('Superficie paramétrica generada correctamente.');$('scene-name').textContent='SUPERFICIE PARAMÉTRICA · '+next.expression.slice(0,40);
}catch(error){setFeedback(error.message,true);}}
function selectInputMode(mode){
  inputMode=mode;const explicit=mode==='explicit';$('explicit-fields').classList.toggle('hidden',!explicit);$('parametric-fields').classList.toggle('hidden',explicit);
  $('explicit-presets').classList.toggle('hidden',!explicit);$('parametric-presets').classList.toggle('hidden',explicit);
  $('tab-explicit').classList.toggle('active',explicit);$('tab-parametric').classList.toggle('active',!explicit);
  $('tab-explicit').setAttribute('aria-selected',String(explicit));$('tab-parametric').setAttribute('aria-selected',String(!explicit));
}
$('tab-explicit').addEventListener('click',()=>selectInputMode('explicit'));$('tab-parametric').addEventListener('click',()=>selectInputMode('parametric'));
function submitExpression(){try{
  const next=parseSurfaceEquation(equation.value),prev=state.compiled,oldParams=state.parameters,oldType=state.surfaceType;
  state.compiled=next;state.parameters={};state.surfaceType='explicit';for(const key of next.parameters)state.parameters[key]=oldParams[key]??paramDefault(key);
  try{regenerate();}catch(error){state.compiled=prev;state.parameters=oldParams;state.surfaceType=oldType;throw error;}
  makeParams(next.parameters);setFeedback('Superficie generada correctamente.');$('scene-name').textContent='SUPERFICIE · z = '+next.expression.slice(0,44);
}catch(error){setFeedback(error.message,true);}}
$('equation-form').addEventListener('submit',e=>{e.preventDefault();if(inputMode==='explicit')submitExpression();else submitParametric();});
$('explicit-presets').addEventListener('click',e=>{const btn=e.target.closest('[data-expression]');if(btn){equation.value=btn.dataset.expression;selectInputMode('explicit');submitExpression();}});
$('parametric-presets').addEventListener('click',e=>{const btn=e.target.closest('[data-x][data-y][data-z]');if(!btn)return;$('param-x').value=btn.dataset.x;$('param-y').value=btn.dataset.y;$('param-z').value=btn.dataset.z;$('u-min').value=btn.dataset.umin;$('u-max').value=btn.dataset.umax;$('v-min').value=btn.dataset.vmin;$('v-max').value=btn.dataset.vmax;selectInputMode('parametric');submitParametric();});
for(const [id,prop,transform] of [['domain','domain',Number],['height','height',Number],['resolution','resolution',Number]]){
  $(id).addEventListener('input',()=>{state[prop]=transform($(id).value);$('domain-label').textContent='±'+state.domain;$('height-label').textContent=state.height.toFixed(1)+'×';$('resolution-label').textContent=state.resolution+' × '+state.resolution;try{regenerate();setFeedback('Vista actualizada.');}catch(e){setFeedback(e.message,true);}});
}
$('style').addEventListener('change',e=>state.style=e.target.value);
$('palette').addEventListener('change',e=>state.palette=Number(e.target.value));
$('axes').addEventListener('change',e=>state.axes=e.target.checked);
$('grid').addEventListener('change',e=>state.grid=e.target.checked);
function resetView(){state.yaw=.7;state.pitch=.48;state.distance=5.8;state.target=[0,0,0];}
$('reset-view').addEventListener('click',resetView);
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(state.xrSession)return;state.pointer={id:e.pointerId,x:e.clientX,y:e.clientY,button:e.button};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{const p=state.pointer;if(!p||p.id!==e.pointerId)return;
  const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
  if(p.button===2 || e.shiftKey){const scale=state.distance*.0016;state.target[0]-=dx*scale;state.target[1]+=dy*scale;}
  else{state.yaw-=dx*.008;state.pitch=Math.max(-1.2,Math.min(1.45,state.pitch+dy*.008));}
});
for(const t of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(t,()=>state.pointer=null);
canvas.addEventListener('wheel',e=>{e.preventDefault();state.distance=Math.max(2.0,Math.min(19,state.distance*Math.exp(e.deltaY*.001)));},{passive:false});

async function stopCamera(){if(state.cameraStream){state.cameraStream.getTracks().forEach(track=>track.stop());state.cameraStream=null;}video.srcObject=null;stage.classList.remove('camera-on');$('camera-badge').hidden=true;}
function setMode(mode){state.mode=mode;$('view-3d').classList.toggle('active',mode==='3d');$('view-camera').classList.toggle('active',mode==='camera');}
$('view-3d').addEventListener('click',async()=>{await stopCamera();setMode('3d');$('stage-help').textContent='Arrastra para girar · Rueda para acercar · Botón derecho para desplazar';});
$('view-camera').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getUserMedia){showNotice('La webcam requiere Chrome/Edge en https:// o http://localhost.');return;}
  try{await stopCamera();const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},audio:false});
    state.cameraStream=s;video.srcObject=s;await video.play();stage.classList.add('camera-on');$('camera-badge').hidden=false;setMode('camera');
    $('stage-help').textContent='Vista de webcam superpuesta · puedes mover la superficie con ratón · no hay seguimiento espacial';
    s.getVideoTracks()[0]?.addEventListener('ended',()=>{stopCamera();setMode('3d');});
  }catch(e){showNotice('No se pudo activar la cámara. Comprueba sus permisos y que ninguna otra app la esté utilizando.');setMode('3d');}
});

// Export an actual composite PNG, including webcam pixels if webcam access was granted.
$('save-image').addEventListener('click',()=>{
  const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;
  const cx=c.getContext('2d');cx.fillStyle='#0c1926';cx.fillRect(0,0,c.width,c.height);
  if(state.mode==='camera'&&video.readyState>=2){const vw=video.videoWidth,vh=video.videoHeight;
    const scale=Math.max(c.width/vw,c.height/vh),w=vw*scale,h=vh*scale;
    cx.save();cx.translate(c.width,0);cx.scale(-1,1);cx.drawImage(video,(c.width-w)/2,(c.height-h)/2,w,h);cx.restore();}
  cx.drawImage(canvas,0,0);const a=document.createElement('a');a.href=c.toDataURL('image/png');a.download='surface-lab.png';a.click();
});

// The 2D HTML sidebar is not rendered by immersive WebXR.
// Quest gets a real, textured, in-world panel that controllers can aim at.
let xrPanel=null, xrGrab=null, xrRotate=null, xrMenuDrag=null, xrMenuPlacing=false,
  xrMenuPlacementSource=null, xrMenuResetButtons=new Map(), xrTransform=null,
  xrLaser=null, xrLastTime=0, xrPose=null;
let xrSpatial=null, xrShadow=null, xrReticle=null, xrFrameHits=new Map();
function placeXRModel(pose){
  const m=pose.transform.matrix;
  const forward=[-m[8],-m[9],-m[10]];
  xrTransform={
    position:[m[12]+forward[0]*1.55,m[13]+forward[1]*1.55-.35,m[14]+forward[2]*1.55],
    yaw:0,pitch:0,rotation:[0,0,0,1],scale:.48
  };
  state.xrModel=modelXRMatrix(xrTransform);
}
function xrRay(frame,src){
  if(!src.targetRaySpace)return null;
  const p=frame.getPose(src.targetRaySpace,state.xrSpace);
  return p?rayFromMatrix(p.transform.matrix):null;
}
function isNearModel(ray){
  if(!ray||!xrTransform)return false;
  const to=xrTransform.position.map((v,i)=>v-ray.origin[i]);
  const along=to.reduce((v,x,i)=>v+x*ray.dir[i],0);
  if(along<.10||along>6)return false;
  const sq=to.reduce((v,x)=>v+x*x,0)-along*along;
  return sq<Math.pow(1.78*xrTransform.scale,2);
}
function startGrab(event,requireHit){
  if(xrGrab||!xrTransform)return;
  const src=event.inputSource;
  const ray=xrRay(event.frame,src);
  if(requireHit&&!isNearModel(ray))return;
  const space=src.gripSpace||src.targetRaySpace;
  if(!space)return;
  const p=event.frame.getPose(space,state.xrSpace);
  if(!p)return;
  xrGrab={src,space,origin:[p.transform.position.x,p.transform.position.y,p.transform.position.z],
    position:[...xrTransform.position]};
}
// Runtime detection: an immersive session is still usable when hit-test is denied.
async function initXRSpatial(session){
  const enabled=typeof session.requestHitTestSource==='function' &&
    (!session.enabledFeatures||session.enabledFeatures.includes('hit-test'));
  xrSpatial={supported:enabled,scanning:false,preview:null,plane:null,shadow:true,
    autoFit:true,measuring:false,measurePoints:[],fitStatus:'',
    lightAngle:35,opacity:0.31,viewerSource:null,controllerSources:new Map(),error:''};
  xrShadow=new XRPlanarShadow(gl);
  if(!enabled){xrSpatial.error='Hit-test no disponible en Quest Browser.';return;}
  try{
    const viewerSpace=await session.requestReferenceSpace('viewer');
    const source=await session.requestHitTestSource({space:viewerSpace});
    if(session!==state.xrSession){source.cancel();return;}
    xrSpatial.viewerSource=source;
  }catch(e){
    // Controller target-ray hit testing can still work if viewer hit testing fails.
    xrSpatial.error='Detección por mirada no disponible; prueba apuntar con el mando.';
  }
}
function getSpatialHit(frame,source){
  if(!source)return null;
  try{
    for(const result of frame.getHitTestResults(source)){
      const pose=result.getPose(state.xrSpace);
      const plane=pose&&planeFromHitMatrix(pose.transform.matrix);
      if(plane)return plane;
    }
  }catch{/* Optional capability may be revoked; keep the 3D viewer functional. */}
  return null;
}
function updateXRSpatial(frame){
  const sp=xrSpatial;
  if(!sp?.supported||!sp.scanning)return;
  // Create a persistent hit-test source per controller. Controllers may connect later.
  const inputs=Array.from(frame.session.inputSources);
  for(const source of inputs){
    if(!source.targetRaySpace||sp.controllerSources.has(source))continue;
    sp.controllerSources.set(source,{pending:true});
    frame.session.requestHitTestSource({space:source.targetRaySpace})
      .then(hitSource=>{
        if(xrSpatial!==sp||!state.xrSession){hitSource.cancel();return;}
        sp.controllerSources.set(source,{hitSource});
      }).catch(()=>sp.controllerSources.set(source,{failed:true}));
  }
  for(const [input,entry] of sp.controllerSources){
    if(!inputs.includes(input)){
      entry.hitSource?.cancel();sp.controllerSources.delete(input);
    }
  }
  xrFrameHits.clear();
  let preview=null;
  for(const input of inputs){
    const found=getSpatialHit(frame,sp.controllerSources.get(input)?.hitSource);
    if(found){xrFrameHits.set(input,found);preview??=found;}
  }
  // Fallback to viewer ray when targetRaySpace is not supported.
  preview??=getSpatialHit(frame,sp.viewerSource);
  const before=Boolean(sp.preview);
  sp.preview=preview;
  if(before!==Boolean(preview)&&xrPanel)xrPanel.dirty=true;
  updateXRReticle(preview);
}
function updateXRReticle(hit){
  if(!hit){if(xrReticle)xrReticle.count=0;return;}
  const n=hit.normal,p=hit.point,r=.105;
  let u=[1-n[0]*n[0],-n[0]*n[1],-n[0]*n[2]];
  const len=Math.hypot(...u)||1;u=u.map(v=>v/len);
  const v=[n[1]*u[2]-n[2]*u[1],n[2]*u[0]-n[0]*u[2],n[0]*u[1]-n[1]*u[0]];
  const xy=t=>p.map((x,i)=>x+n[i]*.012+r*(Math.cos(t)*u[i]+Math.sin(t)*v[i]));
  const lines=[];
  for(let i=0;i<32;i++)pushLine(lines,xy(i*Math.PI/16),xy((i+1)*Math.PI/16),[.28,1,.68]);
  pushLine(lines,xy(0),xy(Math.PI),[.28,1,.68]);
  pushLine(lines,xy(Math.PI/2),xy(Math.PI*1.5),[.28,1,.68]);
  if(!xrReticle)xrReticle={buffer:gl.createBuffer(),count:0};
  gl.bindBuffer(gl.ARRAY_BUFFER,xrReticle.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lines),gl.DYNAMIC_DRAW);
  xrReticle.count=lines.length/6;
}
function placeOnRealSurface(hit,frame){
  if(!hit||!xrTransform||!xrSpatial)return;
  // A hit test returns only a point/normal. Automatic sizing requires the
  // independent, optional WebXR plane-detection surface polygon.
  const fit=xrSpatial.autoFit&&frame?findTableFit(frame,state.xrSpace,hit.point):null;
  if(fit)xrTransform.scale=fit.scale;
  const center=fit?.center||hit.point;
  const clearance=modelClearance(state.data,xrTransform.scale,state.height);
  xrTransform.position=center.map((x,i)=>x+hit.normal[i]*clearance);
  xrTransform.yaw=0;xrTransform.pitch=0;xrTransform.rotation=[0,0,0,1];
  state.xrModel=modelXRMatrix(xrTransform);
  xrSpatial.plane={point:[...center],normal:[...hit.normal]};
  xrSpatial.scanning=false;xrSpatial.preview=null;
  xrSpatial.measuring=false;xrSpatial.measurePoints=[];
  xrSpatial.fitStatus=fit?
    'Mesa aprox. '+fit.width.toFixed(2)+' × '+fit.depth.toFixed(2)+' m; escala ajustada.':
    xrSpatial.autoFit?'Contorno no disponible: mide el lado corto con 2 puntos.':
    'Superficie colocada, tamaño manual.';
  if(xrReticle)xrReticle.count=0;
  if(xrPanel)xrPanel.dirty=true;
}
function recordTableWidth(hit){
  const sp=xrSpatial;
  if(!hit||!sp?.measuring||!xrTransform)return;
  if(sp.measurePoints.length===0){
    sp.measurePoints=[hit];
    sp.fitStatus='Primer extremo marcado. Marca el segundo sobre el borde corto.';
    xrPanel.dirty=true;return;
  }
  const distance=measureShortEdge(sp.measurePoints[0],hit);
  if(!distance){
    sp.fitStatus='Puntos no válidos: deben estar en el mismo borde horizontal.';
    sp.measurePoints=[];
    xrPanel.dirty=true;return;
  }
  const fitted=fitScaleFromWidth(distance);
  if(fitted===null){
    sp.fitStatus='Superficie demasiado estrecha para ajustar el modelo.';
    sp.measurePoints=[];xrPanel.dirty=true;return;
  }
  xrTransform.scale=fitted;
  // Keep the original support location. Measuring two points must NOT
  // silently move the model to the edge or midpoint between them.
  const anchor=sp.plane?.point||hit.point;
  const normal=sp.plane?.normal||hit.normal;
  const clearance=modelClearance(state.data,fitted,state.height);
  xrTransform.position=anchor.map((v,i)=>v+normal[i]*clearance);
  state.xrModel=modelXRMatrix(xrTransform);
  if(!sp.plane)sp.plane={point:[...anchor],normal:[...normal]};
  sp.fitStatus='Ancho medido: '+distance.toFixed(2)+' m · función ajustada.';
  sp.measuring=false;sp.measurePoints=[];sp.scanning=false;sp.preview=null;
  if(xrReticle)xrReticle.count=0;
  xrPanel.dirty=true;
}
function menuCommand(cmd,arg){
  if(cmd==='menu-place'){
    xrMenuPlacing=!xrMenuPlacing;
    if(!xrMenuPlacing)xrMenuPlacementSource=null;
    if(xrPanel)xrPanel.dirty=true;
    return;
  }
  if(cmd==='menu-reset'){resetXRMenu();return;}
  if(cmd==='equation'){
    const old=equation.value;equation.value=arg;
    submitExpression();
    if(feedback.classList.contains('error')){const error=feedback.textContent;equation.value=old;return error;}
    return '';
  }
  if(cmd==='recenter'){
    if(xrPose)placeXRModel(xrPose);
    if(xrSpatial){xrSpatial.plane=null;xrSpatial.preview=null;xrSpatial.scanning=false;
      xrSpatial.measuring=false;xrSpatial.measurePoints=[];xrSpatial.fitStatus='';}
    return;
  }
  if(cmd==='fit-toggle'){
    if(xrSpatial){xrSpatial.autoFit=!xrSpatial.autoFit;xrSpatial.fitStatus='';}
    return;
  }
  if(cmd==='measure-width'){
    if(!xrSpatial?.supported)return;
    xrSpatial.measuring=!xrSpatial.measuring;
    xrSpatial.scanning=xrSpatial.measuring;
    xrSpatial.measurePoints=[];
    xrSpatial.fitStatus=xrSpatial.measuring?
      'Marca dos extremos del lado más corto de la mesa.':'Medición cancelada.';
    if(xrReticle)xrReticle.count=0;
    xrPanel.dirty=true;
    return;
  }
  if(cmd==='place-mode'){
    if(!xrSpatial?.supported)return;
    xrSpatial.scanning=!xrSpatial.scanning;
    xrSpatial.measuring=false;xrSpatial.measurePoints=[];
    xrSpatial.preview=null;
    if(xrReticle)xrReticle.count=0;
    xrPanel.dirty=true;
    return;
  }
  if(cmd==='reset-plane'){
    if(xrSpatial){xrSpatial.plane=null;xrSpatial.scanning=false;xrSpatial.preview=null;
      xrSpatial.measuring=false;xrSpatial.measurePoints=[];xrSpatial.fitStatus='';}
    if(xrReticle)xrReticle.count=0;
    return;
  }
  if(cmd==='shadow'){
    if(xrSpatial)xrSpatial.shadow=!xrSpatial.shadow;
    return;
  }
  if(cmd.startsWith('light:')&&xrSpatial){
    xrSpatial.lightAngle=((xrSpatial.lightAngle+(cmd.endsWith('+')?15:-15))%360+360)%360;
    return;
  }
  if(cmd.startsWith('opacity:')&&xrSpatial){
    xrSpatial.opacity=Math.round(clamp(xrSpatial.opacity+(cmd.endsWith('+')?.05:-.05),.05,.55)*100)/100;
    return;
  }
  if(cmd==='exit'){state.xrSession?.end();return;}
  if(cmd==='style'){
    const names=['both','solid','wire'];state.style=names[(names.indexOf(state.style)+1)%names.length];
    $('style').value=state.style;return;
  }
  if(cmd==='palette'){state.palette=(state.palette+1)%4;$('palette').value=String(state.palette);return;}
  if(cmd==='axes'){state.axes=!state.axes;$('axes').checked=state.axes;return;}
  if(cmd==='grid'){state.grid=!state.grid;$('grid').checked=state.grid;return;}
  if(cmd.startsWith('param:')){
    const [,name,sign]=cmd.split(':');
    if(!Object.hasOwn(state.parameters,name))return;
    state.parameters[name]=Math.round(clamp(state.parameters[name]+(sign==='+'?.1:-.1),-5,5)*100)/100;
    try{regenerate();makeParams(state.compiled.parameters);}catch(e){setFeedback(e.message,true);}
    return;
  }
  const [field,sign]=cmd.split(':');
  if(field==='resolution'){
    const next=nextMeshResolution(state.resolution,sign==='+'?5:-5);
    if(next!==state.resolution){
      $('resolution').value=String(next);
      $('resolution').dispatchEvent(new Event('input'));
    }
    return;
  }
  if(field==='domain'||field==='height'){
    const id=field,inc=field==='domain'?.5:.1;
    const min=field==='domain'?1:.2,max=field==='domain'?10:2.5;
    $(id).value=String(Math.round(clamp(state[field]+(sign==='+'?inc:-inc),min,max)*10)/10);
    $(id).dispatchEvent(new Event('input'));
  } else if(field==='scale'&&xrTransform){
    xrTransform.scale=clamp(Math.round((xrTransform.scale+(sign==='+'?.08:-.08))*100)/100,.08,1.35);
    state.xrModel=modelXRMatrix(xrTransform);
  }
}
// Trigger: grab menu header for repositioning, or rotate the surface in 3D.
function startMenuDrag(e){
  const src=e.inputSource,space=src.gripSpace||src.targetRaySpace;
  if(!xrPanel?.pose||!space)return;
  const pose=e.frame.getPose(space,state.xrSpace);if(!pose)return;
  const p=pose.transform.position;
  xrMenuDrag={src,space,origin:[p.x,p.y,p.z],center:[...xrPanel.pose.center]};
}
function startRotation(e){
  if(!xrTransform||xrGrab||xrRotate)return;
  const src=e.inputSource,space=src.gripSpace||src.targetRaySpace;
  const ray=xrRay(e.frame,src);
  if(!isNearModel(ray)||!space)return;
  const pose=e.frame.getPose(space,state.xrSpace);
  const q=quaternionFromPose(pose);
  if(!q)return;
  xrRotate={src,space,startOrientation:q,startModel:[...(xrTransform.rotation||[0,0,0,1])]};
}
function updateMenuDrag(frame){
  if(!xrMenuDrag||!xrPanel?.pose)return;
  const p=frame.getPose(xrMenuDrag.space,state.xrSpace)?.transform?.position;
  if(!p){xrMenuDrag=null;return;}
  xrPanel.pose.center=translatedMenuCenter(xrMenuDrag.center,xrMenuDrag.origin,[p.x,p.y,p.z]);
}
function updateXRRotation(frame){
  if(!xrRotate||!xrTransform)return;
  const pose=frame.getPose(xrRotate.space,state.xrSpace);
  const now=quaternionFromPose(pose);
  if(!now){xrRotate=null;return;}
  xrTransform.rotation=relativeControllerRotation(xrRotate.startOrientation,now,xrRotate.startModel);
}
function placeMenuAtRay(ray,viewerMatrix){
  if(!ray||!xrPanel||!viewerMatrix)return;
  const point=menuPositionFromRay(ray,1.20);
  xrPanel.placeAt(point,viewerMatrix);
}
function resetXRMenu(){
  if(xrPanel&&xrPose){
    xrMenuPlacing=false;xrMenuDrag=null;
    xrPanel.setPose(xrPose.transform.matrix,true);
    xrPanel.dirty=true;
  }
}
function updateMenuPlacement(frame){
  if(!xrMenuPlacing||!xrPose||!xrPanel)return;
  const active=xrMenuPlacementSource&&frame.session.inputSources.includes(xrMenuPlacementSource)
    ?xrMenuPlacementSource:frame.session.inputSources.find(s=>s.targetRaySpace);
  const ray=active&&xrRay(frame,active);
  if(ray)placeMenuAtRay(ray,xrPose.transform.matrix);
}

function xrSelectStart(e){
  if(!state.xrSession)return;
  const ray=xrRay(e.frame,e.inputSource);
  if(xrMenuPlacing){
    if(ray&&xrPose)placeMenuAtRay(ray,xrPose.transform.matrix);
    xrMenuPlacing=false;xrMenuPlacementSource=null;
    if(xrPanel)xrPanel.dirty=true;
    return;
  }
  const hit=ray&&xrPanel?.hit(ray);
  if(hit){
    if(hit.id==='menu-handle'){startMenuDrag(e);return;}
    if(hit.id){
      if(hit.id==='menu-place')xrMenuPlacementSource=e.inputSource;
      xrPanel.activate(hit.id);
    }
    return; // no surface manipulation while aiming at the menu
  }
  if(xrSpatial?.scanning){
    const detected=xrFrameHits.get(e.inputSource)??xrSpatial.preview;
    if(detected){
      if(xrSpatial.measuring)recordTableWidth(detected);
      else placeOnRealSurface(detected,e.frame);
    }
    return; // never grab the virtual surface while placing on a real plane
  }
  startRotation(e);
}
function xrGrabUpdate(frame){
  if(!xrGrab)return;
  const p=frame.getPose(xrGrab.space,state.xrSpace);
  if(!p){xrGrab=null;return;}
  const now=p.transform.position;
  xrTransform.position=xrGrab.position.map((v,i)=>v+[now.x,now.y,now.z][i]-xrGrab.origin[i]);
}
function xrControllerInputs(frame,t){
  if(!xrTransform||!xrPanel)return;
  xrGrabUpdate(frame);
  updateXRRotation(frame);
  updateMenuDrag(frame);
  updateMenuPlacement(frame);
  const dt=clamp((t-(xrLastTime||t))/1000,0,.05);xrLastTime=t;
  const rays=[];let hovered=null;
  for(const src of frame.session.inputSources){
    const ray=xrRay(frame,src);
    if(ray){
      const hit=xrPanel.hit(ray);
      if(hit?.id&&!hovered)hovered=hit.id;
      const distance=hit?.distance??2.5;
      const tip=ray.origin.map((v,i)=>v+ray.dir[i]*distance);
      pushLine(rays,ray.origin,tip,hit?.id?[.37,1,.75]:[.30,.73,1]);
    }
    // Quest Touch axes normally use indices 2 and 3; some controllers expose 0 and 1.
    const axes=src.gamepad?.axes;
    if(!axes||axes.length<2)continue;
    const ax=axes.length>=4?axes[2]:axes[0],ay=axes.length>=4?axes[3]:axes[1];
    const x=Math.abs(ax)>.15?ax:0,y=Math.abs(ay)>.15?ay:0;
    if(src.handedness==='left'&&!xrRotate){
      if(x)xrTransform.rotation=quatMultiply(quatAxisAngle([0,1,0],-x*dt*1.65),xrTransform.rotation);
      if(y)xrTransform.rotation=quatMultiply(xrTransform.rotation,quatAxisAngle([1,0,0],y*dt*1.5));
    }else if(src.handedness==='right'){
      xrTransform.scale=clamp(xrTransform.scale*(1-y*dt*1.4),.08,1.35);
    }
    // Quest A/X face button recentres the menu if it has been moved out of sight.
    const pressed=!!src.gamepad?.buttons?.[4]?.pressed;
    if(pressed&&!xrMenuResetButtons.get(src))resetXRMenu();
    xrMenuResetButtons.set(src,pressed);
  }
  xrPanel.hover(hovered);
  if(!xrLaser){const b=gl.createBuffer();xrLaser={buffer:b,count:0};}
  gl.bindBuffer(gl.ARRAY_BUFFER,xrLaser.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(rays),gl.DYNAMIC_DRAW);
  xrLaser.count=rays.length/6;
  state.xrModel=modelXRMatrix(xrTransform);
}
async function enterXR(){
  if(!navigator.xr){showNotice('Abre la app en Meta Quest Browser mediante HTTPS para usar WebXR.');return;}
  let session;
  try{
    session=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['local'],optionalFeatures:['hit-test','plane-detection']});
    await stopCamera();setMode('3d');
    if(gl.makeXRCompatible)await gl.makeXRCompatible();
    const layer=new XRWebGLLayer(session,gl,{alpha:true,antialias:true,depth:true});
    // Use a closer near clip plane so the user can inspect the mathematical
    // surface from a few centimetres away. A moderate far plane helps depth precision.
    session.updateRenderState({baseLayer:layer,depthNear:0.025,depthFar:30});
    const space=await session.requestReferenceSpace('local');
    state.xrSession=session;state.xrSpace=space;state.xrModel=null;
    xrPose=null;xrGrab=null;xrRotate=null;xrMenuDrag=null;xrMenuPlacing=false;
    xrMenuPlacementSource=null;xrMenuResetButtons.clear();xrTransform=null;xrLastTime=0;
    xrFrameHits.clear();await initXRSpatial(session);
    xrPanel=new XRPanel(gl,()=>({
      expression:state.surfaceType==='explicit'?(state.compiled?.expression||equation.value):equation.value,
      params:state.parameters,domain:state.domain,height:state.height,
      scale:xrTransform?.scale??.48,style:state.style,palette:state.palette,
      resolution:state.resolution,axes:state.axes,grid:state.grid,
      hitAvailable:!!xrSpatial?.supported,scanning:!!xrSpatial?.scanning,
      hitReady:!!xrSpatial?.preview,placed:!!xrSpatial?.plane,
      shadowOn:!!xrSpatial?.shadow,lightAngle:xrSpatial?.lightAngle??35,
      opacity:xrSpatial?.opacity??.31,autoFit:!!xrSpatial?.autoFit,
      measuring:!!xrSpatial?.measuring,measureProgress:xrSpatial?.measurePoints?.length??0,
      fitStatus:xrSpatial?.fitStatus??''
    }),menuCommand);
    session.addEventListener('selectstart',xrSelectStart);
    session.addEventListener('selectend',e=>{
      if(xrRotate?.src===e.inputSource)xrRotate=null;
      if(xrMenuDrag?.src===e.inputSource)xrMenuDrag=null;
      if(xrGrab?.src===e.inputSource)xrGrab=null;
    });
    session.addEventListener('squeezestart',e=>startGrab(e,false));
    session.addEventListener('squeezeend',e=>{if(xrGrab?.src===e.inputSource)xrGrab=null;});
    session.addEventListener('end',()=>{
      state.xrSession=null;state.xrSpace=null;state.xrModel=null;
      xrPose=null;xrGrab=null;xrRotate=null;xrMenuDrag=null;xrMenuPlacing=false;
      xrMenuPlacementSource=null;xrMenuResetButtons.clear();xrTransform=null;xrLastTime=0;
      xrPanel?.dispose();xrPanel=null;
      xrShadow?.dispose();xrShadow=null;
      if(xrSpatial){
        xrSpatial.viewerSource?.cancel();
        for(const entry of xrSpatial.controllerSources.values())entry.hitSource?.cancel();
      }
      xrSpatial=null;xrFrameHits.clear();
      if(xrReticle){gl.deleteBuffer(xrReticle.buffer);xrReticle=null;}
      if(xrLaser){gl.deleteBuffer(xrLaser.buffer);xrLaser=null;}
      $('view-xr').classList.remove('active');
      $('stage-help').textContent='Arrastra para girar · Rueda para acercar · Botón derecho para desplazar';
      requestAnimationFrame(frame);
    });
    $('view-xr').classList.add('active');
    $('stage-help').textContent='Quest: gatillo sobre objeto rota · cabecera mueve menú · agarre desplaza.';
    session.requestAnimationFrame(xrFrame);
  }catch(e){
    if(session&&!state.xrSession)await session.end().catch(()=>{});
    showNotice('No se pudo iniciar realidad mixta: '+e.message);
  }
}
function xrFrame(t,frame){
  const session=frame.session;if(!state.xrSession)return;
  session.requestAnimationFrame(xrFrame);
  const pose=frame.getViewerPose(state.xrSpace);if(!pose)return;
  xrPose=pose;
  if(!xrTransform)placeXRModel(pose);
  xrPanel?.setPose(pose.transform.matrix);
  updateXRSpatial(frame);
  xrControllerInputs(frame,t);
  const layer=session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);
  gl.enable(gl.SCISSOR_TEST);
  for(const view of pose.views){
    const viewport=layer.getViewport(view);
    gl.viewport(viewport.x,viewport.y,viewport.width,viewport.height);
    gl.scissor(viewport.x,viewport.y,viewport.width,viewport.height);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const viewProjection=mul(view.projectionMatrix,view.transform.inverse.matrix);
    if(xrSpatial?.plane&&xrSpatial.shadow&&xrShadow){
      xrShadow.draw(state.surface,viewProjection,state.xrModel,xrSpatial.plane,
        xrSpatial.lightAngle,xrSpatial.opacity);
    }
    drawScene(mul(viewProjection,state.xrModel));
    gl.disable(gl.DEPTH_TEST);
    if(xrLaser?.count)drawLines(xrLaser,viewProjection,.85);
    if(xrSpatial?.scanning&&xrReticle?.count)drawLines(xrReticle,viewProjection,1);
    gl.enable(gl.DEPTH_TEST);
    xrPanel?.draw(viewProjection,mul);
  }
  gl.disable(gl.SCISSOR_TEST);
}
$('view-xr').addEventListener('click',()=>{if(state.xrSession)state.xrSession.end();else enterXR();});
async function checkXR(){const text=$('device-status'),btn=$('view-xr');
  if(!navigator.xr){text.textContent='PC: vista 3D y webcam disponibles · WebXR no detectado';btn.title='Abre esta página en Quest Browser con HTTPS';return;}
  try{const ok=await navigator.xr.isSessionSupported('immersive-ar');text.textContent=ok?'WebXR immersive-ar disponible':'WebXR presente · immersive-ar no disponible en este navegador';
    if(!ok)btn.title='Este navegador no admite immersive-ar (prueba con Quest Browser)';}
  catch{text.textContent='No se pudo comprobar WebXR';}
}
submitExpression();requestAnimationFrame(frame);checkXR();
