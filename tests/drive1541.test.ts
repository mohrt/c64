import { describe, expect, it } from 'vitest';
import { Drive1541 } from '../src/drive/drive1541';
import { IecBus, PULL_ATN, PULL_CLK } from '../src/iec/iec-bus';
import { hasDriveRom, loadDriveRom } from './helpers/machine';

const ONE_SECOND = 985_248;

describe.skipIf(!hasDriveRom)('Drive1541', () => {
  it('boots the DOS into its idle loop with the motor and LED off', () => {
    const bus = new IecBus();
    bus.driveConnected = true;
    const drive = new Drive1541(loadDriveRom(), bus);
    drive.runUntil(2 * ONE_SECOND);

    const pcs = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      pcs.add(drive.cpu.pc);
      drive.runUntil(drive.time + 1);
    }
    const sorted = [...pcs].sort((a, b) => a - b);
    expect(sorted[0]).toBeGreaterThanOrEqual(0xc000);
    expect(drive.cpu.jammedAt).toBe(-1);
    expect(drive.motorOn).toBe(false);
    expect(drive.ledOn).toBe(false);
  });

  it('releases the bus lines when idle (no ATN from the C64)', () => {
    const bus = new IecBus();
    bus.driveConnected = true;
    const drive = new Drive1541(loadDriveRom(), bus);
    drive.runUntil(2 * ONE_SECOND);
    const lines = bus.linesForC64(drive.time);
    expect(lines).toEqual({ atnLow: false, clkLow: false, dataLow: false });
  });

  it('answers ATN by pulling DATA (hardware acknowledge)', () => {
    const bus = new IecBus();
    bus.driveConnected = true;
    const drive = new Drive1541(loadDriveRom(), bus);
    drive.runUntil(2 * ONE_SECOND);
    bus.setC64Pulls(drive.time, PULL_ATN | PULL_CLK); // how the KERNAL starts a command
    drive.runUntil(drive.time + 2000);
    expect(bus.linesForC64(drive.time).dataLow).toBe(true);
  });
});
