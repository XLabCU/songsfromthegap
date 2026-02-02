
import { Gap } from '../types';

export class MultiVoicePlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private sourceNodes: AudioBufferSourceNode[] = [];
  private isPlaying: boolean = false;
  private sequenceInterval?: number;
  private samples: Record<string, AudioBuffer> = {};
  public isLoaded: boolean = false;

  private sampleUrls = {
    bass: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/cello-mp3/C2.mp3',
    harmony: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/string_ensemble_1-mp3/A4.mp3',
    melody: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/celesta-mp3/C5.mp3'
  };

  async loadSamples() {
    if (this.isLoaded) return;
    this.initContext();
    if (!this.ctx) return;

    const load = async (url: string) => {
      const resp = await fetch(url);
      const arrayBuffer = await resp.arrayBuffer();
      return await this.ctx!.decodeAudioData(arrayBuffer);
    };

    try {
      const [bass, harmony, melody] = await Promise.all([
        load(this.sampleUrls.bass),
        load(this.sampleUrls.harmony),
        load(this.sampleUrls.melody)
      ]);
      this.samples = { bass, harmony, melody };
      this.isLoaded = true;
    } catch (e) {
      console.error("Failed to load instrument samples", e);
    }
  }

  private initContext() {
    if (this.ctx && this.ctx.state !== 'closed') return;
    
    // @ts-ignore
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.reverb = this.ctx.createConvolver();
    
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * 3.0;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    for (let i = 0; i < 2; i++) {
      const channel = impulse.getChannelData(i);
      for (let j = 0; j < length; j++) {
        channel[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, 4);
      }
    }
    this.reverb.buffer = impulse;

    this.masterGain.connect(this.reverb);
    this.reverb.connect(this.ctx.destination);
    
    const dryGain = this.ctx.createGain();
    dryGain.gain.value = 0.5;
    this.masterGain.connect(dryGain);
    dryGain.connect(this.ctx.destination);
    
    this.masterGain.gain.value = 0.7;
  }

  private getPlaybackRate(targetFreq: number, baseFreq: number): number {
    return isFinite(targetFreq / baseFreq) ? targetFreq / baseFreq : 1;
  }

  private getNoteFreq(index: number): number {
    const scale = [220.00, 246.94, 261.63, 293.66, 329.63, 392.00, 440.00, 493.88]; 
    const len = scale.length;
    const normalizedIndex = ((Math.floor(index) % len) + len) % len;
    const octaves = Math.floor(index / len);
    return scale[normalizedIndex] * Math.pow(2, octaves);
  }

  async playSync(gap: Gap, onEnded: () => void) {
    this.stop();
    if (!this.isLoaded) await this.loadSamples();
    if (!this.ctx || !this.masterGain) return;

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.gain.linearRampToValueAtTime(0.7, now + 0.1);

    this.isPlaying = true;
    
    const similarity = isFinite(gap.semanticSimilarity) ? gap.semanticSimilarity : 0.1;
    const distance = isFinite(gap.distance) ? gap.distance : 1.0;
    const centerX = gap.center[0];
    const centerY = gap.center[1];

    const baseTempo = 80 + similarity * 100;
    const stepTime = 60 / baseTempo;
    const rhythmicElasticity = Math.min(0.4, distance / 20);

    // VOICE 1: CELLO BASS
    const bassSource = this.ctx.createBufferSource();
    const bassGain = this.ctx.createGain();
    bassSource.buffer = this.samples.bass;
    bassSource.loop = true;
    const targetBassFreq = this.getNoteFreq(centerX) / 2;
    bassSource.playbackRate.value = this.getPlaybackRate(targetBassFreq, 65.41); // C2
    bassGain.gain.setValueAtTime(0, now);
    bassGain.gain.linearRampToValueAtTime(0.5, now + 1.5);
    bassSource.connect(bassGain).connect(this.masterGain);
    bassSource.start();
    this.sourceNodes.push(bassSource);

    // VOICE 2: STRING ENSEMBLE PAD
    const harmSource = this.ctx.createBufferSource();
    const harmGain = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    
    harmSource.buffer = this.samples.harmony;
    harmSource.loop = true;
    const targetHarmFreq = this.getNoteFreq(centerY + 4);
    harmSource.playbackRate.value = this.getPlaybackRate(targetHarmFreq, 440); // A4
    
    lfo.frequency.value = 0.2 + Math.abs(centerY) * 0.5;
    lfoGain.gain.value = 0.1;
    lfo.connect(lfoGain).connect(harmGain.gain);
    
    harmGain.gain.setValueAtTime(0.2, now);
    harmSource.connect(harmGain).connect(this.masterGain);
    harmSource.start();
    lfo.start();
    this.sourceNodes.push(harmSource);

    // VOICE 3: CELESTA MELODY
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000 + similarity * 5000;
    filter.Q.value = 2;
    filter.connect(this.masterGain);

    const seedString = gap.sharedLinks.join('') || gap.id;
    let step = 0;

    const playStep = () => {
      if (!this.ctx || !this.isPlaying) return;
      const time = this.ctx.currentTime;
      const charCode = seedString.charCodeAt(step % seedString.length) || 0;
      const targetFreq = this.getNoteFreq(((charCode + step) % 16) + 16);
      
      const melSource = this.ctx.createBufferSource();
      const melGain = this.ctx.createGain();
      melSource.buffer = this.samples.melody;
      melSource.playbackRate.value = this.getPlaybackRate(targetFreq, 523.25); // C5
      
      melGain.gain.setValueAtTime(0, time);
      melGain.gain.linearRampToValueAtTime(0.4, time + 0.005);
      melGain.gain.exponentialRampToValueAtTime(0.001, time + (stepTime / 2));
      
      melSource.connect(melGain).connect(filter);
      melSource.start(time);
      
      step++;
      if (step >= 32) {
        this.stop();
        onEnded();
        return;
      }
      const jitter = (Math.random() - 0.5) * rhythmicElasticity * stepTime;
      const nextDelay = (stepTime / 2) + jitter;
      this.sequenceInterval = window.setTimeout(playStep, nextDelay * 1000);
    };

    playStep();
  }

  stop() {
    this.isPlaying = false;
    if (this.sequenceInterval) clearTimeout(this.sequenceInterval);
    this.sourceNodes.forEach(node => { try { node.stop(); } catch(e) {} });
    this.sourceNodes = [];
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  async exportWav(gap: Gap) {
    if (!this.isLoaded) await this.loadSamples();
    
    const similarity = isFinite(gap.semanticSimilarity) ? gap.semanticSimilarity : 0.1;
    const distance = isFinite(gap.distance) ? gap.distance : 1.0;
    const centerX = gap.center[0];
    const centerY = gap.center[1];
    const baseTempo = 80 + similarity * 100;
    const stepTime = 60 / baseTempo;
    const totalDuration = stepTime * 18;

    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, sampleRate * totalDuration, sampleRate);
    
    const masterGain = offlineCtx.createGain();
    const reverb = offlineCtx.createConvolver();
    const length = sampleRate * 3.0;
    const impulse = offlineCtx.createBuffer(2, length, sampleRate);
    for (let i = 0; i < 2; i++) {
      const channel = impulse.getChannelData(i);
      for (let j = 0; j < length; j++) {
        channel[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, 4);
      }
    }
    reverb.buffer = impulse;
    masterGain.connect(reverb).connect(offlineCtx.destination);
    const dryGain = offlineCtx.createGain();
    dryGain.gain.value = 0.5;
    masterGain.connect(dryGain).connect(offlineCtx.destination);
    masterGain.gain.setValueAtTime(0, 0);
    masterGain.gain.linearRampToValueAtTime(0.7, 0.1);

    // Bass Source
    const bSrc = offlineCtx.createBufferSource();
    bSrc.buffer = this.samples.bass;
    bSrc.playbackRate.value = this.getPlaybackRate(this.getNoteFreq(centerX) / 2, 65.41);
    const bGain = offlineCtx.createGain();
    bGain.gain.setValueAtTime(0, 0);
    bGain.gain.linearRampToValueAtTime(0.5, 1.5);
    bSrc.connect(bGain).connect(masterGain);
    bSrc.start(0);

    // Harmony Source
    const hSrc = offlineCtx.createBufferSource();
    hSrc.buffer = this.samples.harmony;
    hSrc.playbackRate.value = this.getPlaybackRate(this.getNoteFreq(centerY + 4), 440);
    const hGain = offlineCtx.createGain();
    hGain.gain.setValueAtTime(0.2, 0);
    hSrc.connect(hGain).connect(masterGain);
    hSrc.start(0);

    // Melody Steps
    const filter = offlineCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000 + similarity * 5000;
    filter.connect(masterGain);

    const seedString = gap.sharedLinks.join('') || gap.id;
    const rhythmicElasticity = Math.min(0.4, distance / 20);
    let currentTime = 0;
    for(let step=0; step<32; step++) {
      const charCode = seedString.charCodeAt(step % seedString.length) || 0;
      const freq = this.getNoteFreq(((charCode + step) % 16) + 16);
      const mSrc = offlineCtx.createBufferSource();
      const mGain = offlineCtx.createGain();
      mSrc.buffer = this.samples.melody;
      mSrc.playbackRate.value = this.getPlaybackRate(freq, 523.25);
      mGain.gain.setValueAtTime(0, currentTime);
      mGain.gain.linearRampToValueAtTime(0.4, currentTime + 0.005);
      mGain.gain.exponentialRampToValueAtTime(0.001, currentTime + (stepTime / 2));
      mSrc.connect(mGain).connect(filter);
      mSrc.start(currentTime);
      currentTime += (stepTime / 2) + (Math.random() - 0.5) * rhythmicElasticity * stepTime;
    }

    masterGain.gain.setTargetAtTime(0, currentTime, 0.5);

    const buffer = await offlineCtx.startRendering();
    const blob = this.bufferToWav(buffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SongFromGap_${gap.from.title}_to_${gap.to.title}.wav`;
    a.click();
  }

  private bufferToWav(buffer: AudioBuffer): Blob {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const outBuffer = new ArrayBuffer(length);
    const view = new DataView(outBuffer);
    let pos = 0;

    const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
    const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };

    setUint32(0x46464952); // RIFF
    setUint32(length - 8);
    setUint32(0x45564157); // WAVE
    setUint32(0x20746d66); // fmt
    setUint32(16);
    setUint16(1);          // PCM
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);
    setUint32(0x61746164); // data
    setUint32(length - pos - 4);

    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    
    let offset = 0;
    while (pos < length) {
      for (let i = 0; i < numOfChan; i++) {
        let sample = Math.max(-1, Math.min(1, channels[i][offset]));
        sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
        view.setInt16(pos, sample, true);
        pos += 2;
      }
      offset++;
    }
    return new Blob([outBuffer], { type: 'audio/wav' });
  }
}
