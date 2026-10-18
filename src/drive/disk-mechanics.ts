import { CYCLES_PER_BYTE, MAX_HALF_TRACK, type GcrDisk } from './gcr';

// VIA2 port B lines
const PB_STEPPER = 0x03;
const PB_MOTOR = 0x04;
const PB_LED = 0x08;
/** Write-protect sensor: 0 when the disk's notch is covered. */
const PB_WRITE_PROTECT = 0x10;
const PB_DENSITY_SHIFT = 5;
const PB_SYNC = 0x80;

const MIN_HALF_TRACK = 2;
/** Where the head rests at power-on (track 18, the directory). */
const START_HALF_TRACK = 36;
const SYNC_BYTE = 0xff;
/** How long the write-protect sensor flickers while a disk is swapped. */
const SWAP_SENSOR_CYCLES = 300_000;

/** What the drive electronics tell the head: whether it is writing, and the byte to write. */
export interface WriteControl {
  writing(): boolean;
  byteToWrite(): number;
}

/**
 * The spinning disk and the read/write head, one GCR byte at a time. Two or
 * more $FF bytes in a row form a sync mark: SYNC is reported and no byte-ready
 * pulses occur until the next data byte arrives aligned behind it. In write
 * mode each byte time stores the drive's output byte instead.
 */
export class DiskMechanics {
  halfTrack = START_HALF_TRACK;
  motorOn = false;
  ledOn = false;
  /** Called for each byte that passes the head outside a sync mark. */
  onByteReady: () => void = () => {};
  writeControl: WriteControl = { writing: () => false, byteToWrite: () => 0 };

  private disk: GcrDisk | null = null;
  private position = 0;
  private cycleBudget = 0;
  private density = 3;
  private stepperPhase = 0;
  private currentByte = 0;
  private inSync = false;
  private swapCycles = 0;

  insert(disk: GcrDisk | null): void {
    this.disk = disk;
    this.swapCycles = SWAP_SENSOR_CYCLES;
    this.inSync = false;
  }

  get hasDisk(): boolean {
    return this.disk !== null;
  }

  /** The GCR byte last read by the head (VIA2 port A pins). */
  get dataByte(): number {
    return this.currentByte;
  }

  /** VIA2 port B input pins: SYNC (active low) and the write-protect sensor. */
  get portBPins(): number {
    let pins = 0xff & ~(PB_SYNC | PB_WRITE_PROTECT);
    if (!this.inSync) pins |= PB_SYNC;
    let writable = this.disk !== null && !this.disk.writeProtected;
    // The sensor flickers while a disk slides in or out, which is how the DOS notices a swap.
    if (this.swapCycles > 0 && ((this.swapCycles >> 16) & 1) === 0) writable = !writable;
    if (writable) pins |= PB_WRITE_PROTECT;
    return pins;
  }

  /** Applies VIA2 port B outputs: stepper phase, motor, LED and bit-rate density. */
  setControl(portB: number): void {
    const phase = portB & PB_STEPPER;
    const step = (phase - this.stepperPhase) & 0x03;
    if (step === 1) this.halfTrack = Math.min(MAX_HALF_TRACK, this.halfTrack + 1);
    else if (step === 3) this.halfTrack = Math.max(MIN_HALF_TRACK, this.halfTrack - 1);
    this.stepperPhase = phase;
    this.motorOn = (portB & PB_MOTOR) !== 0;
    this.ledOn = (portB & PB_LED) !== 0;
    this.density = (portB >> PB_DENSITY_SHIFT) & 0x03;
  }

  tick(cycles: number): void {
    if (this.swapCycles > 0) this.swapCycles = Math.max(0, this.swapCycles - cycles);
    if (!this.motorOn) return;
    this.cycleBudget += cycles;
    const cyclesPerByte = CYCLES_PER_BYTE[this.density];
    while (this.cycleBudget >= cyclesPerByte) {
      this.cycleBudget -= cyclesPerByte;
      this.nextByte();
    }
  }

  private nextByte(): void {
    const disk = this.disk;
    const track = disk?.halfTracks[this.halfTrack];
    if (!disk || !track) {
      this.inSync = false;
      this.currentByte = 0;
      return;
    }
    this.position = (this.position + 1) % track.length;

    if (this.writeControl.writing() && !disk.writeProtected) {
      track[this.position] = this.writeControl.byteToWrite();
      disk.markWritten(this.halfTrack);
      this.inSync = false;
      this.onByteReady();
      return;
    }

    const byte = track[this.position];
    const previous = track[(this.position + track.length - 1) % track.length];
    const next = track[(this.position + 1) % track.length];
    this.inSync = byte === SYNC_BYTE && (previous === SYNC_BYTE || next === SYNC_BYTE);
    this.currentByte = byte;
    if (!this.inSync) this.onByteReady();
  }
}
