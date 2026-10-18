// Lines a device is pulling low (open-collector: any device can pull a line low).
export const PULL_ATN = 0x01;
export const PULL_CLK = 0x02;
export const PULL_DATA = 0x04;
/** The drive's ATN-acknowledge output (VIA1 PB4); not a bus line by itself. */
export const DRIVE_ATNA = 0x08;

/**
 * Port inputs are sampled mid-cycle, about half a cycle before a write in the
 * same cycle takes effect. Fast loaders rely on this margin, because the drive's
 * 1 MHz clock slowly drifts against the C64's.
 */
export const READ_SAMPLE_OFFSET = 0.5;

export interface BusLines {
  atnLow: boolean;
  clkLow: boolean;
  dataLow: boolean;
}

/**
 * A value that changes over time, readable "as of" an earlier moment. Each side
 * of the bus writes with its own (monotonic) clock and is read by the other side
 * with that side's clock, so neither sees changes from its own future.
 */
class Timeline {
  private times: number[] = [Number.NEGATIVE_INFINITY];
  private values: number[] = [0];

  get latest(): number {
    return this.values[this.values.length - 1];
  }

  set(time: number, value: number): void {
    if (value === this.latest) return;
    const last = this.times.length - 1;
    if (time <= this.times[last]) {
      this.values[last] = value;
    } else {
      this.times.push(time);
      this.values.push(value);
    }
  }

  /** The value at `time`. Readers are monotonic, so older entries are dropped. */
  at(time: number): number {
    let index = 0;
    while (index + 1 < this.times.length && this.times[index + 1] <= time) index++;
    if (index > 0) {
      this.times.splice(0, index);
      this.values.splice(0, index);
    }
    return this.values[0];
  }

  reset(value: number): void {
    this.times = [Number.NEGATIVE_INFINITY];
    this.values = [value];
  }
}

/**
 * The IEC serial bus between the C64 and the 1541: ATN, CLK and DATA as
 * wired-AND lines. Times are in C64 cycles. Includes the 1541's hardware ATN
 * acknowledge, which pulls DATA whenever ATN and the drive's ATNA output disagree.
 */
export class IecBus {
  private readonly c64Side = new Timeline();
  private readonly driveSide = new Timeline();
  /** Whether a drive is connected; without one, only the C64 drives the lines. */
  driveConnected = false;

  reset(): void {
    this.c64Side.reset(this.c64Side.latest);
    this.driveSide.reset(0);
  }

  setC64Pulls(time: number, pulls: number): void {
    this.c64Side.set(time, pulls);
  }

  setDriveOutputs(time: number, outputs: number): void {
    this.driveSide.set(time, outputs);
  }

  /** The lines as the C64 sees them at `time` (the drive must have run up to then). */
  linesForC64(time: number): BusLines {
    return combine(this.c64Side.latest, this.driveConnected ? this.driveSide.at(time) : null);
  }

  /** The lines as the drive sees them at `time` (in C64 cycles). */
  linesForDrive(time: number): BusLines {
    return combine(this.c64Side.at(time), this.driveSide.latest);
  }
}

function combine(c64: number, drive: number | null): BusLines {
  const atnLow = (c64 & PULL_ATN) !== 0;
  let clkLow = (c64 & PULL_CLK) !== 0;
  let dataLow = (c64 & PULL_DATA) !== 0;
  if (drive !== null) {
    clkLow ||= (drive & PULL_CLK) !== 0;
    dataLow ||= (drive & PULL_DATA) !== 0 || atnLow !== ((drive & DRIVE_ATNA) !== 0);
  }
  return { atnLow, clkLow, dataLow };
}
