import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { DiskMechanics } from '../src/drive/disk-mechanics';
import { GcrDisk, decodeGcr } from '../src/drive/gcr';
import { buildD64 } from './helpers/d64-builder';

const MOTOR_ON = 0x04;
const DENSITY_ZONE_2 = 0x40; // track 18 is in zone 2

function makeDrive() {
  const mechanics = new DiskMechanics();
  mechanics.insert(GcrDisk.fromD64(new D64Image(buildD64('MECH', 'ME 2A', []))));
  const bytes: number[] = [];
  mechanics.onByteReady = () => bytes.push(mechanics.dataByte);
  return { mechanics, bytes };
}

describe('DiskMechanics', () => {
  it('delivers bytes at the zone rate only while the motor runs', () => {
    const { mechanics, bytes } = makeDrive();
    mechanics.tick(10_000);
    expect(bytes.length).toBe(0);
    mechanics.setControl(MOTOR_ON | DENSITY_ZONE_2);
    mechanics.tick(28 * 100);
    // 100 bytes passed the head; the sync bytes among them raise no byte-ready.
    expect(bytes.length).toBeGreaterThan(80);
    expect(bytes.length).toBeLessThanOrEqual(100);
  });

  it('reports SYNC, then the header block bytes of the current track', () => {
    const { mechanics, bytes } = makeDrive();
    mechanics.setControl(MOTOR_ON | DENSITY_ZONE_2);
    let sawSync = false;
    for (let i = 0; i < 8000 && !sawSync; i++) {
      mechanics.tick(28);
      sawSync = (mechanics.portBPins & 0x80) === 0;
    }
    expect(sawSync).toBe(true);
    bytes.length = 0; // no byte-ready pulses happen during the sync mark
    while (bytes.length < 10) mechanics.tick(28);
    const block = decodeGcr(bytes.slice(0, 10))!;
    if (block[0] === 0x08) expect(block[3]).toBe(18);
    else expect(decodeGcr(bytes.slice(0, 5))?.[0]).toBe(0x07);
  });

  it('steps the head with the stepper phases', () => {
    const { mechanics } = makeDrive();
    expect(mechanics.halfTrack).toBe(36);
    mechanics.setControl(1);
    mechanics.setControl(2);
    expect(mechanics.halfTrack).toBe(38);
    mechanics.setControl(1);
    mechanics.setControl(0);
    mechanics.setControl(3);
    expect(mechanics.halfTrack).toBe(35);
  });

  it('reports motor and LED state', () => {
    const { mechanics } = makeDrive();
    mechanics.setControl(MOTOR_ON | 0x08);
    expect(mechanics.motorOn).toBe(true);
    expect(mechanics.ledOn).toBe(true);
  });
});
