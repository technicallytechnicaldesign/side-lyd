import {Mixer} from './mixer-core.js?v=3';

class LoopProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.mixer = new Mixer(sampleRate, event => this.port.postMessage(event)); this.capture = false; this.captureFrames = 0; this.captureBuffer = new Int16Array(8192); this.captureIndex=0; this.report=0;
    this.port.onmessage = ({data}) => {
      if(data.type==='bank') { this.mixer.setBank(data.bank,data.seed); this.port.postMessage({type:'loaded',id:data.bank.id}); }
      if(data.type==='controls') { Object.assign(this.mixer.controls,data.value); if(data.master!==undefined)this.mixer.master=data.master; }
      if(data.type==='run') this.mixer.running=data.value;
      if(data.type==='reseed'&&this.mixer.bank) this.mixer.setBank(this.mixer.bank,data.seed);
      if(data.type==='change') this.mixer.force=true;
      if(data.type==='record') {
        if(data.value){this.capture=true;this.captureFrames=0;this.captureIndex=0;this.port.postMessage({type:'record-start',frame:this.mixer.frame,rate:sampleRate});}
        else this.finishCapture();
      }
    };
  }
  flush() {
    if(!this.captureIndex)return;
    const chunk=this.captureBuffer.slice(0,this.captureIndex);
    this.port.postMessage({type:'pcm',data:chunk},[chunk.buffer]); this.captureIndex=0;
  }
  finishCapture() { if(!this.capture)return;this.flush();this.capture=false;this.port.postMessage({type:'record-end',frames:this.captureFrames,frame:this.mixer.frame}); }
  process(inputs,outputs) {
    const [left,right]=outputs[0];this.mixer.render(left,right);
    let peak=0;
    for(let i=0;i<left.length;i++) {
      peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));
      if(this.capture){this.captureBuffer[this.captureIndex++]=Math.round(Math.max(-1,Math.min(1,left[i]))*32767);this.captureBuffer[this.captureIndex++]=Math.round(Math.max(-1,Math.min(1,right[i]))*32767);this.captureFrames++;if(this.captureIndex===this.captureBuffer.length)this.flush();if(this.captureFrames>=sampleRate*300)this.finishCapture();}
    }
    this.report+=left.length;
    if(this.report>=sampleRate/10){this.report=0;this.port.postMessage({type:'position',frame:this.mixer.frame,phrase:this.mixer.phrase,beat:this.mixer.bank?this.mixer.frame/this.mixer.beatLength:0,peak,active:this.mixer.running,voices:this.mixer.voices.length});}
    return true;
  }
}
registerProcessor('side-lyd-mixer',LoopProcessor);
