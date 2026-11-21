export class Mixer {
  constructor(rate, emit = () => {}) {
    this.rate = rate; this.emit = emit; this.bank = null; this.running = false;
    this.frame = 0; this.phrase = -1; this.local = 0; this.voices = [];
    this.controls = {energy: .65, variation: .5, flavor: .3, drums: .8, bass: .8, other: .8, fx: .8, hold: false};
    this.levels = [0, 0, 0]; this.targets = [0, 0, 0]; this.choices = [0, 0, 0];
    this.prng = 1; this.seed = 1; this.force = false; this.fade = 0; this.master = .7;
    this.lastReport = 0; this.event = 0; this.fadeSamples = [Math.round(rate * .008), Math.round(rate * .025), Math.round(rate * .48)];
    this.roleNames = ['drums','bass','other']; this.levelSlew = 1-Math.exp(-1/(rate*.04)); this.fadeSlew = 1-Math.exp(-1/(rate*.035));
    this.autoSlew=1-Math.exp(-1/(rate*2.2));this.detailSlew=1-Math.exp(-1/(rate*.18));
  }
  random() { let x = this.prng | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.prng = x >>> 0; return this.prng / 4294967296; }
  setBank(bank, seed) {
    this.bank = bank; this.seed = Number(seed) >>> 0 || 1; this.prng = this.seed;
    this.frame = 0; this.phrase = -1; this.local = 0; this.voices = []; this.levels = [0,0,0]; this.targets = [0,0,0]; this.choices = [0,0,0];
    this.phraseLength = this.rate * 60 / bank.bpm * bank.beats; this.beatLength = this.phraseLength / bank.beats;
    this.variants=bank.variants||'ABCD'.split('');
    this.loops = this.roleNames.map(role => this.variants.map(v => bank.assets.find(a => a.kind === 'loop' && a.role === role && a.variant === v)));
    this.details=bank.assets.filter(a=>a.kind==='detail');this.detailChoice=-1;this.detailPrevious=-1;this.detailOn=false;this.detailOldOn=false;this.detailLevel=0;
    this.autoLevels=[0,0,0];this.bags=[[],[],[]];this.lastLane=-1;this.lastChange=-10;this.lastFlavor=-10;
    this.event = 0; this.fade = 0; this.beginPhrase();
  }
  nextVariant(role){
    if(!this.bags[role].length){
      this.bags[role]=this.variants.map((_,i)=>i).filter(i=>i!==this.choices[role]);
      for(let i=this.bags[role].length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[this.bags[role][i],this.bags[role][j]]=[this.bags[role][j],this.bags[role][i]];}
    }
    let next=this.bags[role].pop();if(next===this.choices[role])next=(next+1)%this.variants.length;return next;
  }
  beginPhrase() {
    this.phrase++;
    const p = this.phrase, c = this.controls, previous = [...this.choices];
    const previousTargets = [...this.targets];
    const change = this.force || (!c.hold && p > 0 && p-this.lastChange>=(c.variation>.8?1:2) && this.random() < .3 + c.variation * .6);
    if (change) {
      const shared=this.bank.tonalMode==='shared-progression';
      const available=(shared?[0,1,2]:[0,1]).filter(lane=>lane!==this.lastLane);
      const lane=available[Math.floor(this.random()*available.length)];
      if(!shared&&lane===1){this.choices[1]=this.nextVariant(1);this.choices[2]=this.choices[1];}
      else this.choices[lane]=this.nextVariant(lane);
      this.lastLane=lane;this.lastChange=p;
    }
    this.force = false;
    let density = .67 + .15*Math.sin(p*Math.PI/9) + (this.random()-.5)*.12;
    if (c.hold && p > 0) density = this.density;
    this.density = density;
    this.targets = [.62+density*.34,.65+density*.32,.54+density*.4];
    if(p===0){this.targets=[.68,.72,.7];this.autoLevels=[...this.targets];}
    this.oldChoices = previous; this.changed = previous.map((n, i) => n !== this.choices[i]);
    this.oldTargets = previousTargets;
    this.pending = [];
    const variant = this.variants[this.choices[2]];
    if (p > 0 && c.flavor > 0 && p-this.lastFlavor>=2 && this.random() < c.flavor * .8) {
      const choices = this.bank.assets.filter(a => a.kind === 'flavor' && a.variant === variant);
      if (choices.length){this.pending.push({at: this.beatLength * [5,7.5,10,12][Math.floor(this.random()*4)], asset: choices[Math.floor(this.random() * choices.length)], gain: .3 + .7 * c.flavor});this.lastFlavor=p;}
    }
    if (p > 0 && (this.changed[1]||this.changed[2]) && c.flavor > 0) {
      const covers = this.bank.assets.filter(a => a.kind === 'cover' && a.variant === variant);
      const cover=covers[Math.floor(this.random()*covers.length)];
      if (cover) this.pending.push({at: 0, asset: cover, gain: .35 + c.flavor * .55});
    }
    this.detailPrevious=this.detailChoice;this.detailOldOn=this.detailOn;
    if(!c.hold&&p%2===0&&this.details.length){this.detailChoice=(Math.max(0,this.detailChoice)+1+Math.floor(this.random()*Math.max(1,this.details.length-1)))%this.details.length;this.detailOn=c.flavor>0&&this.random()<.3+c.flavor*.5;}
    this.emit({type:'phrase', phrase:p, frame:Math.round(p * this.phraseLength), choices:[...this.choices], variants:this.choices.map(n=>this.variants[n]), targets:[...this.targets], detail:this.detailOn?this.detailChoice:null, seed:this.seed, event:++this.event});
  }
  sample(asset, position, channel, wrap = true) {
    const data = asset?.channels?.[channel]; if (!data?.length) return 0;
    let i = position; if (wrap) i = i % data.length;
    if (i < 0 || i >= data.length) return 0;
    const left = Math.floor(i), frac = i - left;
    return data[left] * (1-frac) + (data[left+1 < data.length ? left+1 : wrap ? 0 : left] || 0) * frac;
  }
  render(left, right) {
    for (let i = 0; i < left.length; i++) {
      if (!this.bank || (!this.running && this.fade < .0001)) { left[i] = 0; right[i] = 0; continue; }
      const phrase = Math.floor(this.frame / this.phraseLength);
      while (phrase > this.phrase) this.beginPhrase();
      const local = this.frame - this.phrase * this.phraseLength;
      for (let p = this.pending.length-1; p >= 0; p--) if (local >= this.pending[p].at) { const next=this.pending.splice(p,1)[0]; this.voices.push({asset:next.asset,position:0,gain:next.gain}); }
      let l = 0, r = 0;
      for (let role = 0; role < 3; role++) {
        const key = this.roleNames[role];
        this.autoLevels[role]+=(this.targets[role]-this.autoLevels[role])*this.autoSlew;
        this.levels[role] += (this.autoLevels[role] * this.controls[key] * (.28 + this.controls.energy * .72) - this.levels[role]) * this.levelSlew;
        const asset = this.loops[role][this.choices[role]], pos = local / this.phraseLength * asset.channels[0].length;
        let a = this.sample(asset,pos,0), b = this.sample(asset,pos,1);
        if (this.changed[role] && local < this.fadeSamples[role]) {
          const x = local / this.fadeSamples[role];
          if (role === 2) {
            const old = this.loops[role][this.oldChoices[role]], oldPos = local / this.phraseLength * old.channels[0].length;
            a = a * Math.sin(x*Math.PI/2) + this.sample(old,oldPos,0) * Math.cos(x*Math.PI/2);
            b = b * Math.sin(x*Math.PI/2) + this.sample(old,oldPos,1) * Math.cos(x*Math.PI/2);
          } else { a *= x; b *= x; }
        }
        const until = this.phraseLength - local;
        if (role !== 2 && until < this.fadeSamples[role]) { const g=until/this.fadeSamples[role]; a*=g; b*=g; }
        l += a*this.levels[role]; r += b*this.levels[role];
      }
      const detailTarget=this.detailOn&&this.controls.flavor>0?this.controls.fx*(.35+this.controls.flavor*.65):0;
      this.detailLevel+=(detailTarget-this.detailLevel)*this.detailSlew;
      if(this.detailChoice>=0&&this.detailLevel>.0001){
        const asset=this.details[this.detailChoice],pos=local/this.phraseLength*asset.channels[0].length;
        let a=this.sample(asset,pos,0),b=this.sample(asset,pos,1);
        if(this.detailOldOn&&this.detailPrevious>=0&&this.detailPrevious!==this.detailChoice&&local<this.rate*.18){
          const old=this.details[this.detailPrevious],x=local/(this.rate*.18),op=local/this.phraseLength*old.channels[0].length;
          a=a*Math.sin(x*Math.PI/2)+this.sample(old,op,0)*Math.cos(x*Math.PI/2);b=b*Math.sin(x*Math.PI/2)+this.sample(old,op,1)*Math.cos(x*Math.PI/2);
        }
        l+=a*this.detailLevel;r+=b*this.detailLevel;
      }
      for (let v = this.voices.length-1; v >= 0; v--) {
        const voice = this.voices[v];
        if (voice.position >= voice.asset.channels[0].length) { this.voices.splice(v,1); continue; }
        const gain = voice.gain * this.controls.fx;
        l += this.sample(voice.asset,voice.position,0,false) * gain;
        r += this.sample(voice.asset,voice.position,1,false) * gain;
        voice.position++;
      }
      this.fade += ((this.running ? 1 : 0) - this.fade) * this.fadeSlew;
      const gain = this.fade * this.master;
      left[i] = Math.tanh(l * gain); right[i] = Math.tanh(r * gain);
      this.frame++;
    }
  }
}
