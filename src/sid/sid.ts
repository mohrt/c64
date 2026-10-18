import type { ControlPort } from '../io/control-port';
import type { IoDevice } from '../memory/bus';

const PAL_CLOCK_HZ = 985_248;
/** The chip is simulated in steps of this many cycles (about 246 kHz). */
const STEP_CYCLES = 4;
const DEFAULT_SAMPLE_RATE = 44_100;
/** About 2.7 s at 48 kHz; the browser normally drains it every frame. */
const OUTPUT_BUFFER_SAMPLES = 1 << 17;

const VOICE_REGISTERS = 7;
const REG_FREQ_LO = 0;
const REG_FREQ_HI = 1;
const REG_PW_LO = 2;
const REG_PW_HI = 3;
const REG_CONTROL = 4;
const REG_ATTACK_DECAY = 5;
const REG_SUSTAIN_RELEASE = 6;
const REG_CUTOFF_LO = 0x15;
const REG_CUTOFF_HI = 0x16;
const REG_RESONANCE_ROUTING = 0x17;
const REG_MODE_VOLUME = 0x18;
const REG_POT_X = 0x19;
const REG_POT_Y = 0x1a;
const REG_OSC3 = 0x1b;
const REG_ENV3 = 0x1c;
const POT_RELEASED = 0xff;

const CONTROL_GATE = 0x01;
const CONTROL_SYNC = 0x02;
const CONTROL_RING = 0x04;
const CONTROL_TEST = 0x08;
const CONTROL_TRIANGLE = 0x10;
const CONTROL_SAWTOOTH = 0x20;
const CONTROL_PULSE = 0x40;
const CONTROL_NOISE = 0x80;

const MODE_LOWPASS = 0x10;
const MODE_BANDPASS = 0x20;
const MODE_HIGHPASS = 0x40;
const MODE_VOICE3_OFF = 0x80;

const ACCUMULATOR_MASK = 0xffffff;
const ACCUMULATOR_MSB = 0x800000;
const NOISE_CLOCK_BIT = 1 << 19;
const NOISE_SEED = 0x7ffff8;

/** Cycles between envelope steps for each 4-bit rate value. */
const ENVELOPE_PERIODS = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

/**
 * The 6581 has a DC offset in its mixer, so writing the volume register moves
 * the output level. Many games play sampled speech and drums this way.
 */
const MIXER_DC_OFFSET = 0.35;
const OUTPUT_GAIN = 0.5;
/** One-pole DC blocker on the output (the C64's output capacitor). */
const DC_BLOCK_POLE = 0.999;

enum EnvelopeState {
  Attack,
  DecaySustain,
  Release,
}

/** Decay and release slow down as the level falls, approximating an exponential curve. */
function exponentialDivider(level: number): number {
  if (level >= 0x5d) return 1;
  if (level >= 0x36) return 2;
  if (level >= 0x1a) return 4;
  if (level >= 0x0e) return 8;
  if (level >= 0x06) return 16;
  return 30;
}

class Voice {
  frequency = 0;
  pulseWidth = 0;
  control = 0;
  attackDecay = 0;
  sustainRelease = 0;

  accumulator = 0;
  /** Set during a step in which the accumulator's top bit rose (drives hard sync). */
  msbRose = false;
  noise = NOISE_SEED;

  envelope = 0;
  private state = EnvelopeState.Release;
  private rateCounter = 0;
  private exponentialCounter = 0;

  reset(): void {
    this.frequency = this.pulseWidth = this.control = 0;
    this.attackDecay = this.sustainRelease = 0;
    this.accumulator = 0;
    this.msbRose = false;
    this.noise = NOISE_SEED;
    this.envelope = 0;
    this.state = EnvelopeState.Release;
    this.rateCounter = this.exponentialCounter = 0;
  }

  writeControl(value: number): void {
    const gateWasOn = (this.control & CONTROL_GATE) !== 0;
    const gateIsOn = (value & CONTROL_GATE) !== 0;
    if (!gateWasOn && gateIsOn) this.state = EnvelopeState.Attack;
    else if (gateWasOn && !gateIsOn) this.state = EnvelopeState.Release;
    if (value & CONTROL_TEST) {
      this.accumulator = 0;
      this.noise = NOISE_SEED;
    }
    this.control = value;
  }

  clockOscillator(cycles: number): void {
    this.msbRose = false;
    if (this.control & CONTROL_TEST) return;
    const before = this.accumulator;
    const after = before + this.frequency * cycles;
    this.msbRose = before < ACCUMULATOR_MSB && after >= ACCUMULATOR_MSB;
    // The noise shift register is clocked when accumulator bit 19 goes high. A step
    // adds less than 2^19, so it can rise at most once per step.
    if (!(before & NOISE_CLOCK_BIT) && after & NOISE_CLOCK_BIT) {
      const bit = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | bit) & 0x7fffff;
    }
    this.accumulator = after & ACCUMULATOR_MASK;
  }

  clockEnvelope(cycles: number): void {
    const period =
      this.state === EnvelopeState.Attack
        ? ENVELOPE_PERIODS[this.attackDecay >> 4]
        : this.state === EnvelopeState.DecaySustain
          ? ENVELOPE_PERIODS[this.attackDecay & 0x0f]
          : ENVELOPE_PERIODS[this.sustainRelease & 0x0f];
    this.rateCounter += cycles;
    while (this.rateCounter >= period) {
      this.rateCounter -= period;
      if (this.state !== EnvelopeState.Attack && ++this.exponentialCounter < exponentialDivider(this.envelope)) {
        continue;
      }
      this.exponentialCounter = 0;
      this.stepEnvelope();
    }
  }

  private stepEnvelope(): void {
    switch (this.state) {
      case EnvelopeState.Attack:
        this.envelope++;
        if (this.envelope >= 0xff) {
          this.envelope = 0xff;
          this.state = EnvelopeState.DecaySustain;
        }
        break;
      case EnvelopeState.DecaySustain: {
        const sustainLevel = (this.sustainRelease >> 4) * 0x11;
        if (this.envelope > sustainLevel) this.envelope--;
        break;
      }
      case EnvelopeState.Release:
        if (this.envelope > 0) this.envelope--;
        break;
    }
  }

  /** The 12-bit waveform output. Combined waveforms are approximated by ANDing them. */
  waveform(ringSource: Voice): number {
    const control = this.control;
    if (!(control & 0xf0)) return 0;
    let output = 0xfff;
    if (control & CONTROL_TRIANGLE) {
      let msb = this.accumulator & ACCUMULATOR_MSB;
      if (control & CONTROL_RING) msb ^= ringSource.accumulator & ACCUMULATOR_MSB;
      output &= ((msb ? ~this.accumulator : this.accumulator) >> 11) & 0xfff;
    }
    if (control & CONTROL_SAWTOOTH) output &= this.accumulator >> 12;
    if (control & CONTROL_PULSE) {
      output &= control & CONTROL_TEST || this.accumulator >> 12 >= this.pulseWidth ? 0xfff : 0;
    }
    if (control & CONTROL_NOISE) {
      const n = this.noise;
      output &=
        (((n >> 22) & 1) << 11) |
        (((n >> 20) & 1) << 10) |
        (((n >> 16) & 1) << 9) |
        (((n >> 13) & 1) << 8) |
        (((n >> 11) & 1) << 7) |
        (((n >> 7) & 1) << 6) |
        (((n >> 4) & 1) << 5) |
        (((n >> 2) & 1) << 4);
    }
    return output;
  }
}

/**
 * MOS 6581 SID. Simulates the three voices (oscillators with all waveforms,
 * hard sync, ring modulation, noise, ADSR envelopes), the multimode filter
 * and the mixer, and resamples the result to the audio output rate.
 *
 * The chip lags behind the CPU and catches up whenever it is accessed, so
 * register writes take effect at the cycle they happen.
 */
export class Sid implements IoDevice {
  private readonly voices = [new Voice(), new Voice(), new Voice()];
  private readonly registers = new Uint8Array(0x20);
  private clock = 0;
  private pendingCycles = 0;

  private cutoff = 0;
  private resonance = 0;
  private routing = 0;
  private modeVolume = 0;
  private filterLow = 0;
  private filterBand = 0;
  private filterCoefficient = 0;
  private filterDamping = 0;

  private sampleRate = DEFAULT_SAMPLE_RATE;
  /** The system clock driving the chip; pitches and envelope times follow it. */
  private clockHz = PAL_CLOCK_HZ;
  private samplePhase = 0;
  private sampleSum = 0;
  private sampleCount = 0;
  private dcInput = 0;
  private dcOutput = 0;
  private readonly output = new Float32Array(OUTPUT_BUFFER_SAMPLES);
  private outputLength = 0;

  /**
   * `potPort` returns the control port currently switched to the paddle inputs;
   * `now` returns the current CPU cycle, so accesses land at the right moment.
   */
  constructor(
    private readonly potPort: () => ControlPort | null = () => null,
    private readonly now: () => number = () => this.clock,
  ) {
    this.updateFilterCoefficients();
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
  }

  setClockRate(hz: number): void {
    this.clockHz = hz;
    this.updateFilterCoefficients();
  }

  reset(): void {
    this.voices.forEach((voice) => voice.reset());
    this.registers.fill(0);
    this.cutoff = this.resonance = this.routing = this.modeVolume = 0;
    this.filterLow = this.filterBand = 0;
    this.updateFilterCoefficients();
  }

  /** Runs the chip up to CPU cycle `time`, producing audio samples. */
  catchUp(time: number): void {
    const cycles = time - this.clock;
    if (cycles <= 0) return;
    this.clock = time;
    this.pendingCycles += cycles;
    while (this.pendingCycles >= STEP_CYCLES) {
      this.pendingCycles -= STEP_CYCLES;
      this.step();
    }
  }

  /** Returns and clears the audio produced so far, as samples in [-1, 1]. */
  takeSamples(): Float32Array {
    const samples = this.output.slice(0, this.outputLength);
    this.outputLength = 0;
    return samples;
  }

  read(register: number): number {
    switch (register) {
      case REG_POT_X:
        return this.potPort()?.potX ?? POT_RELEASED;
      case REG_POT_Y:
        return this.potPort()?.potY ?? POT_RELEASED;
      case REG_OSC3:
        this.catchUp(this.now());
        return this.voices[2].waveform(this.voices[1]) >> 4;
      case REG_ENV3:
        this.catchUp(this.now());
        return this.voices[2].envelope;
      default:
        // The remaining registers are write-only.
        return 0;
    }
  }

  write(register: number, value: number): void {
    this.catchUp(this.now());
    this.registers[register] = value;
    if (register < VOICE_REGISTERS * 3) {
      this.writeVoice(this.voices[Math.floor(register / VOICE_REGISTERS)], register % VOICE_REGISTERS, value);
      return;
    }
    switch (register) {
      case REG_CUTOFF_LO:
        this.cutoff = (this.cutoff & 0x7f8) | (value & 0x07);
        this.updateFilterCoefficients();
        break;
      case REG_CUTOFF_HI:
        this.cutoff = (value << 3) | (this.cutoff & 0x07);
        this.updateFilterCoefficients();
        break;
      case REG_RESONANCE_ROUTING:
        this.resonance = value >> 4;
        this.routing = value & 0x07;
        this.updateFilterCoefficients();
        break;
      case REG_MODE_VOLUME:
        this.modeVolume = value;
        break;
    }
  }

  private writeVoice(voice: Voice, register: number, value: number): void {
    switch (register) {
      case REG_FREQ_LO:
        voice.frequency = (voice.frequency & 0xff00) | value;
        break;
      case REG_FREQ_HI:
        voice.frequency = (voice.frequency & 0x00ff) | (value << 8);
        break;
      case REG_PW_LO:
        voice.pulseWidth = (voice.pulseWidth & 0xf00) | value;
        break;
      case REG_PW_HI:
        voice.pulseWidth = (voice.pulseWidth & 0x0ff) | ((value & 0x0f) << 8);
        break;
      case REG_CONTROL:
        voice.writeControl(value);
        break;
      case REG_ATTACK_DECAY:
        voice.attackDecay = value;
        break;
      case REG_SUSTAIN_RELEASE:
        voice.sustainRelease = value;
        break;
    }
  }

  private step(): void {
    const [v1, v2, v3] = this.voices;
    v1.clockOscillator(STEP_CYCLES);
    v2.clockOscillator(STEP_CYCLES);
    v3.clockOscillator(STEP_CYCLES);
    // Hard sync: each voice restarts when the previous one's top bit rises.
    if (v1.control & CONTROL_SYNC && v3.msbRose) v1.accumulator = 0;
    if (v2.control & CONTROL_SYNC && v1.msbRose) v2.accumulator = 0;
    if (v3.control & CONTROL_SYNC && v2.msbRose) v3.accumulator = 0;
    v1.clockEnvelope(STEP_CYCLES);
    v2.clockEnvelope(STEP_CYCLES);
    v3.clockEnvelope(STEP_CYCLES);

    // Each voice: waveform centred on zero, scaled by its envelope, in [-1, 1].
    const out1 = ((v1.waveform(v3) - 0x800) * v1.envelope) / (0x800 * 0xff);
    const out2 = ((v2.waveform(v1) - 0x800) * v2.envelope) / (0x800 * 0xff);
    const out3 = ((v3.waveform(v2) - 0x800) * v3.envelope) / (0x800 * 0xff);

    let filterInput = 0;
    let direct = 0;
    if (this.routing & 0x01) filterInput += out1;
    else direct += out1;
    if (this.routing & 0x02) filterInput += out2;
    else direct += out2;
    if (this.routing & 0x04) filterInput += out3;
    else if (!(this.modeVolume & MODE_VOICE3_OFF)) direct += out3;

    const mixed = direct + this.runFilter(filterInput);
    const volume = (this.modeVolume & 0x0f) / 15;
    this.accumulateSample((mixed / 3 + MIXER_DC_OFFSET) * volume);
  }

  private updateFilterCoefficients(): void {
    const cutoffHz = 30 + (this.cutoff / 0x7ff) * 12_000;
    this.filterCoefficient = 2 * Math.sin((Math.PI * cutoffHz * STEP_CYCLES) / this.clockHz);
    this.filterDamping = 1.4 - this.resonance / 15;
  }

  /** A state-variable filter standing in for the 6581's multimode filter. */
  private runFilter(input: number): number {
    const high = input - this.filterLow - this.filterDamping * this.filterBand;
    this.filterBand += this.filterCoefficient * high;
    this.filterLow += this.filterCoefficient * this.filterBand;

    let output = 0;
    if (this.modeVolume & MODE_LOWPASS) output += this.filterLow;
    if (this.modeVolume & MODE_BANDPASS) output += this.filterBand;
    if (this.modeVolume & MODE_HIGHPASS) output += high;
    return output;
  }

  /** Averages internal steps into output samples (a simple anti-aliasing filter). */
  private accumulateSample(value: number): void {
    this.sampleSum += value;
    this.sampleCount++;
    this.samplePhase += (this.sampleRate * STEP_CYCLES) / this.clockHz;
    if (this.samplePhase < 1) return;
    this.samplePhase -= 1;

    const average = this.sampleSum / this.sampleCount;
    this.sampleSum = this.sampleCount = 0;
    this.dcOutput = average - this.dcInput + DC_BLOCK_POLE * this.dcOutput;
    this.dcInput = average;
    // Drop audio if nobody is listening, rather than growing without bound.
    if (this.outputLength === this.output.length) this.outputLength = 0;
    this.output[this.outputLength++] = this.dcOutput * OUTPUT_GAIN;
  }
}
