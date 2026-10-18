import { describe, expect, it } from 'vitest';
import { Sid } from '../src/sid/sid';

const CLOCK = 985_248;
const SAMPLE_RATE = 48_000;

/** A SID driven by a fake CPU clock that the test advances. */
function makeSid() {
  let now = 0;
  const sid = new Sid(() => null, () => now);
  sid.setSampleRate(SAMPLE_RATE);
  const run = (cycles: number) => {
    now += cycles;
    sid.catchUp(now);
    return sid.takeSamples();
  };
  const freqFor = (hz: number) => Math.round((hz * 16_777_216) / CLOCK);
  const playVoice1 = (hz: number, control: number) => {
    const f = freqFor(hz);
    sid.write(0x00, f & 0xff);
    sid.write(0x01, f >> 8);
    sid.write(0x05, 0x00); // fastest attack, no decay
    sid.write(0x06, 0xf0); // full sustain
    sid.write(0x18, 0x0f); // volume 15
    sid.write(0x04, control | 0x01); // waveform + gate
  };
  return { sid, run, playVoice1, freqFor };
}

/** Pitch estimate from rising zero crossings. */
function estimatePitch(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return (crossings * SAMPLE_RATE) / samples.length;
}

const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);

describe('Sid', () => {
  it('produces samples at the output rate', () => {
    const { run } = makeSid();
    const samples = run(CLOCK);
    expect(Math.abs(samples.length - SAMPLE_RATE)).toBeLessThan(5);
  });

  it('is silent until a voice plays', () => {
    const { run } = makeSid();
    expect(rms(run(CLOCK / 10))).toBe(0);
  });

  it.each([
    ['sawtooth', 0x20],
    ['triangle', 0x10],
    ['pulse', 0x40],
  ])('plays a %s at the programmed pitch', (_name, waveform) => {
    const { sid, run, playVoice1 } = makeSid();
    if (waveform === 0x40) {
      sid.write(0x02, 0x00);
      sid.write(0x03, 0x08); // 50% duty cycle
    }
    playVoice1(440, waveform);
    run(CLOCK / 10); // let the envelope and DC blocker settle
    const samples = run(CLOCK);
    expect(rms(samples)).toBeGreaterThan(0.02);
    expect(estimatePitch(samples)).toBeGreaterThan(430);
    expect(estimatePitch(samples)).toBeLessThan(450);
  });

  it('runs the ADSR envelope: fast attack, then release back to silence', () => {
    const { sid, run } = makeSid();
    sid.write(0x13, 0x00); // voice 3: attack 2 ms
    sid.write(0x14, 0xf0);
    sid.write(0x12, 0x21);
    run(CLOCK / 100); // 10 ms
    expect(sid.read(0x1c)).toBe(0xff);
    sid.write(0x14, 0xf0); // release rate 0 (6 ms nominal, slower at low levels)
    sid.write(0x12, 0x20);
    run(CLOCK / 2);
    expect(sid.read(0x1c)).toBe(0);
  });

  it('decays to the sustain level', () => {
    const { sid, run } = makeSid();
    sid.write(0x13, 0x00);
    sid.write(0x14, 0x80); // sustain 8 -> $88
    sid.write(0x12, 0x21);
    run(CLOCK / 2);
    expect(sid.read(0x1c)).toBe(0x88);
  });

  it('reads voice 3 through OSC3, which programs use for random numbers', () => {
    const { sid, run, freqFor } = makeSid();
    const f = freqFor(5000);
    sid.write(0x0e, f & 0xff);
    sid.write(0x0f, f >> 8);
    sid.write(0x12, 0x80); // noise, no gate needed for OSC3
    const values = new Set<number>();
    for (let i = 0; i < 50; i++) {
      run(97);
      values.add(sid.read(0x1b));
    }
    expect(values.size).toBeGreaterThan(20);

    sid.write(0x12, 0x20); // sawtooth: OSC3 climbs
    const a = sid.read(0x1b);
    run(50);
    expect(sid.read(0x1b)).not.toBe(a);
  });

  it('plays "digis" written to the volume register', () => {
    const { sid, run } = makeSid();
    const samples: number[] = [];
    for (let i = 0; i < 400; i++) {
      sid.write(0x18, i % 2 ? 0x0f : 0x00); // a 4-bit sample stream at ~4 kHz
      samples.push(...run(CLOCK / 8000));
    }
    expect(rms(Float32Array.from(samples))).toBeGreaterThan(0.02);
  });

  it('applies register writes at the cycle they happen', () => {
    const { sid, run, playVoice1 } = makeSid();
    playVoice1(1000, 0x20);
    run(CLOCK / 100);
    sid.write(0x18, 0x00); // silence mid-stream
    const quiet = run(CLOCK / 10);
    expect(rms(quiet.subarray(quiet.length / 2))).toBeLessThan(0.01);
  });

  it('lowpass filter removes a high tone', () => {
    const { sid, run, playVoice1 } = makeSid();
    playVoice1(6000, 0x20);
    run(CLOCK / 10);
    const unfiltered = rms(run(CLOCK / 10));
    sid.write(0x15, 0);
    sid.write(0x16, 0x08); // low cutoff
    sid.write(0x17, 0x01); // route voice 1 through the filter
    sid.write(0x18, 0x1f); // lowpass, volume 15
    run(CLOCK / 10);
    expect(rms(run(CLOCK / 10))).toBeLessThan(unfiltered / 4);
  });
});
