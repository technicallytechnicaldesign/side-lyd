const $=id=>document.getElementById(id);
const names=['drums','bass','other','fx','energy','variation','flavor'];
const time=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
let catalog,bank,context,node,analyser,request=0,abort,loading=false,playing=false,recording=false,chunks=[],recordMeta=null,wav=null;
let progress={frame:0,phrase:0,beat:0,peak:0},events=[],controls={drums:.8,bass:.8,other:.8,fx:.8,energy:.65,variation:.5,flavor:.3,hold:false};
let master=.7,seed=7431,animation=0,recordFrames=0;
try{const saved=JSON.parse(localStorage.getItem('side-lyd-mixer-v1'));if(saved){seed=Number(saved.seed)>>>0||7431;for(const key of names)if(Number.isFinite(saved.controls?.[key]))controls[key]=Math.max(0,Math.min(1,saved.controls[key]));if(Number.isFinite(saved.master))master=Math.max(0,Math.min(1,saved.master));}}catch{}
function status(message){$('status').textContent=message;}
function persist(){try{localStorage.setItem('side-lyd-mixer-v1',JSON.stringify({kit:$('bank').value,seed,controls,master}));}catch{}}
function send(data){node?.port.postMessage(data);}
function updateControls(){send({type:'controls',value:controls,master});persist();}
function syncPlay(){ $('play').textContent=playing?'Pause':loading?'Loading…':'Play';$('record').disabled=!playing&&!recording;$('change').disabled=!bank;$('position').textContent=playing?'MIXING LOOPS':'PAUSED'; }
function state(){return {engine:'side-lyd-loop-mixer/1',processor:node?.constructor.name||null,sampleRate:context?.sampleRate,kit:bank?.id,seed,controls:{...controls},master,progress:{...progress},loadedAssets:bank?.assets.length||0,playing,recording,events:[...events]};}
function blobDownload(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function recipe(){return {schema:'side-lyd-loop-recipe/v1',savedAt:new Date().toISOString(),bankVersion:catalog.version,...state(),assets:bank?.assets.map(a=>({id:a.id,sha256:a.sha256})),reproduction:'Seed and controls define the initial run; manual control changes and saved phrase events are included as context, not an exact resume of effect tails.'};}
function historyEntry(event){events.push(event);if(events.length>256)events.shift();const li=document.createElement('li');li.textContent=event.type==='phrase'?`Phrase ${event.phrase+1} · drums ${'ABCD'[event.choices[0]]} · bass/music ${'ABCD'[event.choices[1]]}`:event.type;$('history').prepend(li);while($('history').children.length>24)$('history').lastChild.remove();}
function finishWav(data){
 recording=false;recordFrames=data.frames;
 recordMeta.endFrame=data.frame;recordMeta.recordedFrames=data.frames;
 const count=chunks.reduce((n,c)=>n+c.byteLength,0),header=new ArrayBuffer(44),v=new DataView(header);
 const str=(offset,value)=>{for(let i=0;i<value.length;i++)v.setUint8(offset+i,value.charCodeAt(i));};
 str(0,'RIFF');v.setUint32(4,36+count,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,recordMeta.sampleRate,true);v.setUint32(28,recordMeta.sampleRate*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,count,true);
 wav=new Blob([header,...chunks],{type:'audio/wav'});chunks=[];
 $('record').innerHTML='<span class="record-dot"></span> Record WAV';$('record').setAttribute('aria-pressed','false');$('save-wav').disabled=count===0;$('record-time').textContent=`${time(data.frames/recordMeta.sampleRate)} / 5:00`;syncPlay();status('Recording ready.');
}
async function setup(){
 if(context&&node){await context.resume();return;}
 if(!context)context=new AudioContext({latencyHint:'playback'});await context.resume();
 if(!context.audioWorklet)throw new Error('This browser needs AudioWorklet support and HTTPS.');
 await context.audioWorklet.addModule('mixer-worklet.js?v=2');
 node=new AudioWorkletNode(context,'side-lyd-mixer',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
 analyser=context.createAnalyser();analyser.fftSize=1024;node.connect(analyser);analyser.connect(context.destination);
 node.onprocessorerror=()=>{playing=false;syncPlay();status('Audio engine stopped. Reload to restart.');};
 context.onstatechange=()=>{if(context.state!=='running'&&playing){playing=false;send({type:'run',value:false});syncPlay();status('Browser paused audio. Press Play to resume.');}};
 node.port.onmessage=({data})=>{
  if(data.type==='phrase'){historyEntry(data);['drums','bass','other'].forEach((r,i)=>$(r+'-variant').textContent='ABCD'[data.choices[i]]);$('change').textContent='Change phrase';}
  if(data.type==='position'){
   progress=data;$('elapsed').textContent=time(data.frame/context.sampleRate);$('phrase').textContent=data.phrase+1;$('bar').textContent=Math.floor(data.beat/4)%4+1;
   document.querySelectorAll('.beat-row i').forEach((dot,i)=>dot.classList.toggle('active',playing&&i===Math.floor(data.beat)%4));
  }
  if(data.type==='record-start'){recordMeta.startFrame=data.frame;recordMeta.sampleRate=data.rate;}
  if(data.type==='pcm'){chunks.push(data.data.buffer);recordFrames+=data.data.length/2;$('record-time').textContent=`${time(recordFrames/context.sampleRate)} / 5:00`;}
  if(data.type==='record-end')finishWav(data);
 };
 updateControls();
 if('mediaSession'in navigator){try{navigator.mediaSession.metadata=new MediaMetadata({title:'SIDE LYD',artist:'Loop mixer'});navigator.mediaSession.setActionHandler('play',()=>{if(!playing)$('play').click();});navigator.mediaSession.setActionHandler('pause',()=>{if(playing)$('play').click();});}catch{}}
}
function draw(){
 const canvas=$('scope'),rect=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
 if(canvas.width!==Math.round(rect.width*ratio)||canvas.height!==Math.round(rect.height*ratio)){canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);}
 const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;c.clearRect(0,0,w,h);c.strokeStyle='#6a795e';c.lineWidth=ratio;c.beginPath();
 const data=new Float32Array(1024);if(analyser)analyser.getFloatTimeDomainData(data);
 for(let i=0;i<data.length;i++){const x=i/(data.length-1)*w,y=h/2+data[i]*h*.85;if(!i)c.moveTo(x,y);else c.lineTo(x,y);}
 c.strokeStyle=playing?'#d9ed92':'#607154';c.stroke();animation=requestAnimationFrame(draw);
}
async function loadBank(id){
 const token=++request;abort?.abort();abort=new AbortController();const selected=catalog.banks.find(b=>b.id===id);if(!selected)return;
 loading=true;syncPlay();status('Loading loops…');
 try{
  await setup();const assets=new Array(selected.assets.length);let cursor=0,finished=0;
  async function worker(){while(cursor<selected.assets.length){const i=cursor++,asset=selected.assets[i];const response=await fetch(asset.src+'?v='+asset.sha256.slice(0,12),{signal:abort.signal});if(!response.ok)throw new Error(`Could not load ${asset.id}`);const bytes=await response.arrayBuffer();const decoded=await context.decodeAudioData(bytes);if(token!==request)return;assets[i]={...asset,channels:[decoded.getChannelData(0).slice(),decoded.getChannelData(Math.min(1,decoded.numberOfChannels-1)).slice()]};status(`Loading loops ${++finished}/${selected.assets.length}`);}}
  await Promise.all([worker(),worker(),worker()]);if(token!==request)return;
  if(recording)send({type:'record',value:false});
  const resume=playing;send({type:'run',value:false});if(bank&&resume)await new Promise(r=>setTimeout(r,240));if(token!==request)return;
  bank=selected;events=[];$('history').replaceChildren();
  node.port.postMessage({type:'bank',bank:{...selected,assets},seed},assets.flatMap(a=>a.channels.map(c=>c.buffer)));
  for(const a of assets)a.channels=null;
  updateControls();send({type:'run',value:resume});
  $('tempo').textContent=`${Number(selected.bpm.toFixed(2))} BPM`;
  $('assets').textContent=`12 loops + ${selected.assets.length-12} FX`;
  loading=false;syncPlay();persist();status(resume?'Mixing.':'Ready.');
 }catch(error){if(token!==request)return;loading=false;if(error.name!=='AbortError'){if(bank)$('bank').value=bank.id;status(`${error.message}. Press Play to retry.`);}syncPlay();throw error;}
}
async function start(){
 try{await setup();if(!bank||bank.id!==$('bank').value)await loadBank($('bank').value);await context.resume();playing=true;send({type:'run',value:true});syncPlay();status('Mixing.');if('mediaSession'in navigator)navigator.mediaSession.playbackState='playing';}
 catch(error){playing=false;syncPlay();status(error.message);}
}
$('play').onclick=()=>{if(playing){playing=false;send({type:'run',value:false});if(recording)send({type:'record',value:false});syncPlay();status('Paused.');if('mediaSession'in navigator)navigator.mediaSession.playbackState='paused';}else if(!loading)start();};
$('bank').onchange=()=>{const b=catalog.banks.find(b=>b.id===$('bank').value);$('tempo').textContent=`${Number(b.bpm.toFixed(2))} BPM`;$('assets').textContent=`12 loops + ${b.assets.length-12} FX`;if(context)loadBank(b.id).catch(()=>{});persist();};
for(const key of names){$(key).value=controls[key];$(key+'-value').value=Math.round(controls[key]*100);$(key).oninput=()=>{controls[key]=Number($(key).value);$(key+'-value').value=Math.round(controls[key]*100);updateControls();historyEntry({type:`${key} ${Math.round(controls[key]*100)}`,frame:progress.frame});};}
$('volume').value=master;$('volume-value').value=Math.round(master*100);$('volume').oninput=()=>{master=Number($('volume').value);$('volume-value').value=Math.round(master*100);updateControls();};
$('hold').onclick=()=>{controls.hold=!controls.hold;$('hold').setAttribute('aria-pressed',String(controls.hold));updateControls();};
$('change').onclick=()=>{send({type:'change'});$('change').textContent='Change queued';};
async function reseed(){seed=Number($('seed').value)>>>0||1;$('seed').value=seed;if(bank){const resume=playing;if(recording)send({type:'record',value:false});send({type:'run',value:false});await new Promise(r=>setTimeout(r,240));send({type:'reseed',seed});events=[];send({type:'run',value:resume});}persist();}
$('seed').value=seed;$('seed').onchange=()=>reseed();$('reseed').onclick=()=>{$('seed').value=crypto.getRandomValues(new Uint32Array(1))[0]||1;reseed();};
$('save-recipe').onclick=()=>blobDownload(new Blob([JSON.stringify(recipe(),null,2)],{type:'application/json'}),'SIDE-LYD-recipe.json');
$('record').onclick=()=>{if(recording){send({type:'record',value:false});return;}if(!playing)return;recording=true;chunks=[];recordFrames=0;wav=null;recordMeta={...recipe(),sampleRate:context.sampleRate};$('save-wav').disabled=true;$('record').textContent='Stop recording';$('record').setAttribute('aria-pressed','true');send({type:'record',value:true});status('Recording the loop mix. Maximum 5 minutes.');};
$('save-wav').onclick=()=>{if(wav){blobDownload(wav,`SIDE-LYD-${recordMeta.kit}-${recordMeta.seed}.wav`);blobDownload(new Blob([JSON.stringify(recordMeta,null,2)],{type:'application/json'}),`SIDE-LYD-${recordMeta.kit}-${recordMeta.seed}.json`);}};
window.sideLyd={getState:state,recipe};
fetch('banks.json?v=2').then(r=>{if(!r.ok)throw new Error('Could not load loop banks.');return r.json();}).then(data=>{
 catalog=data;for(const b of data.banks){const option=document.createElement('option');option.value=b.id;option.textContent=b.title;$('bank').append(option);}
 let remembered;try{remembered=JSON.parse(localStorage.getItem('side-lyd-mixer-v1'))?.kit;}catch{}
 const query=new URLSearchParams(location.search),requested=query.get('kit')||(query.get('channel')==='house'?'velvet-drive':remembered);
 if(catalog.banks.some(b=>b.id===requested))$('bank').value=requested;
 const b=catalog.banks.find(b=>b.id===$('bank').value);$('tempo').textContent=`${Number(b.bpm.toFixed(2))} BPM`;$('assets').textContent=`12 loops + ${b.assets.length-12} FX`;$('play').disabled=false;status('Ready.');draw();
}).catch(error=>status(error.message));
