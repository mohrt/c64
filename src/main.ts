import { AudioOutput } from './audio/audio-output';
import { Autostart, atReadyPrompt } from './autostart';
import { C64, PAL_CLOCK_HZ } from './c64';
import type { Cartridge } from './cartridge/cartridge';
import { createCartridge } from './cartridge/cartridge-types';
import { isCrt, parseCrt } from './cartridge/crt';
import { D64Image } from './disk/d64';
import { mediaToD64 } from './disk/d64-builder';
import { isT64, t64ToD64 } from './disk/t64';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from './storage/disk-saves';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { downloadFile } from './ui/download';
import { petsciiToText, type DiskMedia } from './disk/media';
import { PrgMedia } from './disk/prg-media';
import {
  ARROW_KEYS,
  GamepadJoystick,
  KeyboardJoystick,
  NUMPAD_KEYS,
  WASD_KEYS,
  combineInterceptors,
} from './io/joystick-input';
import { BrowserKeyboard } from './io/keyboard';
import { Mouse1351 } from './io/mouse';
import type { Roms } from './memory/bus';
import { Screen } from './render/screen';
import { attachControlsPanel, type PortNumber } from './ui/controls-panel';
import { DiskPanel } from './ui/disk-panel';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;

interface RomSet {
  label: string;
  roms: Roms;
  /** Whether the virtual (fast) drive works with this KERNAL; it relies on standard KERNAL routines. */
  virtualDriveWorks: boolean;
  /** The 1541 DOS ROM, needed for accurate drive emulation; null if not supplied. */
  driveRom: Uint8Array | null;
}

/** While the drive motor runs in warp mode, each animation frame emulates this long. */
const WARP_BUDGET_MS = 12;
const WARP_SLICE_CYCLES = 20_000;

const DRIVE_ROM_SIZE = 0x4000;

/** System ROMs are used when the site provides them; otherwise the Open ROMs. */
const SYSTEM_ROM_DIR = 'roms/system/';
const OPEN_ROM_DIR = 'roms/';

async function loadRom(path: string, expectedSize: number): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!response.ok) throw new Error(`Could not load ROM ${path} (HTTP ${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  // The size check also rejects the dev server's index.html fallback for missing files.
  if (data.length !== expectedSize) {
    throw new Error(`ROM ${path} is ${data.length} bytes, expected ${expectedSize}`);
  }
  return data;
}

async function loadRomsFrom(dir: string): Promise<Roms> {
  const [basic, kernal, chargen] = await Promise.all([
    loadRom(`${dir}basic.rom`, 0x2000),
    loadRom(`${dir}kernal.rom`, 0x2000),
    loadRom(`${dir}chargen.rom`, 0x1000),
  ]);
  return { basic, kernal, chargen };
}

/** BASIC and KERNAL must come from the same set, so it's all three system ROMs or none. */
async function loadRomSet(): Promise<RomSet> {
  const driveRom = await loadRom(`${SYSTEM_ROM_DIR}dos1541.rom`, DRIVE_ROM_SIZE).catch(() => null);
  try {
    return { label: 'System ROMs', roms: await loadRomsFrom(SYSTEM_ROM_DIR), virtualDriveWorks: true, driveRom };
  } catch {
    return { label: 'MEGA65 Open ROMs', roms: await loadRomsFrom(OPEN_ROM_DIR), virtualDriveWorks: false, driveRom };
  }
}

type Media = { kind: 'disk'; disk: DiskMedia } | { kind: 'cartridge'; cartridge: Cartridge };

/** Works out what a file is from its contents (falling back to the extension). */
async function readMedia(file: File): Promise<Media> {
  const data = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (isCrt(data)) return { kind: 'cartridge', cartridge: createCartridge(parseCrt(data)) };
  if (name.endsWith('.t64') || isT64(data)) return { kind: 'disk', disk: t64ToD64(data) };
  if (name.endsWith('.prg')) return { kind: 'disk', disk: new PrgMedia(file.name, data) };
  if (name.endsWith('.d64') || D64Image.isD64Size(data.length)) {
    if (!D64Image.isD64Size(data.length)) {
      throw new Error(`${file.name} is ${data.length} bytes, which is not a valid .d64 size`);
    }
    return { kind: 'disk', disk: new D64Image(data) };
  }
  if (name.endsWith('.crt')) throw new Error(`${file.name} is not a valid .crt cartridge image`);
  throw new Error(`${file.name} isn't something the C64 can use. Try a .d64, .prg, .t64 or .crt file.`);
}

interface LoopOptions {
  gamepads: GamepadJoystick[];
  /** Whether to run flat out while the disk drive is busy. */
  warp: () => boolean;
  onDriveLed: (on: boolean) => void;
  audio: AudioOutput | null;
  autostart: Autostart;
  /** Called when the drive motor stops, i.e. after the DOS has finished any writing. */
  onDriveStopped: () => void;
}

function startLoop(c64: C64, screen: Screen, options: LoopOptions): void {
  let lastTime = performance.now();
  let cycleDebt = 0;
  let ledShown = false;
  let warping = false;
  let driveWasBusy = false;

  const frame = (now: number) => {
    const elapsed = Math.min(now - lastTime, MAX_CATCH_UP_MS);
    lastTime = now;
    options.gamepads.forEach((gamepad) => gamepad.poll());
    const warpNow = options.warp() && c64.driveBusy;
    if (warpNow) {
      const stopAt = performance.now() + WARP_BUDGET_MS;
      while (performance.now() < stopAt && c64.driveBusy) c64.runCycles(WARP_SLICE_CYCLES);
      cycleDebt = 0;
    } else {
      cycleDebt += (elapsed * PAL_CLOCK_HZ) / 1000;
      cycleDebt -= c64.runCycles(cycleDebt);
    }

    options.autostart.tick();
    if (driveWasBusy && !c64.driveBusy) options.onDriveStopped();
    driveWasBusy = c64.driveBusy;

    // Warped audio would play back many times too fast, so it is dropped.
    const samples = c64.takeAudioSamples();
    if (warpNow !== warping) {
      warping = warpNow;
      options.audio?.flush();
    }
    if (!warpNow) options.audio?.play(samples);

    screen.present();
    if (c64.driveLed !== ledShown) {
      ledShown = c64.driveLed;
      options.onDriveLed(ledShown);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const diskPanelRoot = requireElement<HTMLElement>('#disk-panel');
  const controlsRoot = requireElement<HTMLElement>('#controls');

  try {
    const romSet = await loadRomSet();
    const c64 = new C64(romSet.roms, romSet.driveRom ?? undefined);
    let warp = true;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) c64.sid.setSampleRate(audio.sampleRate);

    const screen = new Screen(canvas);
    c64.vic.onFrameComplete = (framebuffer) => screen.capture(framebuffer);

    // Joystick 1 (numpad, optionally arrows, first gamepad) goes in the chosen port;
    // joystick 2 (optionally W A S D + F, second gamepad) goes in the other one.
    const portFor = (port: PortNumber) => (port === 1 ? c64.port1 : c64.port2);
    const otherPort = (port: PortNumber) => (port === 1 ? c64.port2 : c64.port1);
    const joystick1Keys = new KeyboardJoystick(c64.port2, 'keyboard-1');
    const joystick2Keys = new KeyboardJoystick(c64.port1, 'keyboard-2');
    joystick1Keys.setKeys(NUMPAD_KEYS);
    const gamepads = [new GamepadJoystick(c64.port2, 0), new GamepadJoystick(c64.port1, 1)];
    const mouse = new Mouse1351(canvas);
    new BrowserKeyboard(
      c64.keyboard,
      () => c64.pressRestore(),
      combineInterceptors(joystick1Keys, joystick2Keys),
    ).attach(window);
    const controls = attachControlsPanel(controlsRoot, {
      onJoystickPort: (port) => {
        joystick1Keys.setPort(portFor(port));
        gamepads[0].setPort(portFor(port));
        joystick2Keys.setPort(otherPort(port));
        gamepads[1].setPort(otherPort(port));
      },
      onArrowKeys: (enabled) => joystick1Keys.setKeys(enabled ? { ...NUMPAD_KEYS, ...ARROW_KEYS } : NUMPAD_KEYS),
      onSecondJoystickKeys: (enabled) => joystick2Keys.setKeys(enabled ? WASD_KEYS : {}),
      onMousePort: (port) => mouse.setPort(port ? portFor(port) : null),
      onSound: (enabled) => audio?.setEnabled(enabled),
      onVolume: (volume) => audio?.setVolume(volume),
      focusScreen: () => canvas.focus(),
    });
    if (!audio) {
      controls.disableSound('Sound is not supported in this browser');
    } else if (!audio.running) {
      controls.showSoundHint(true);
      audio.resumeOnGesture(window, () => controls.showSoundHint(false));
    }

    const autostart = new Autostart(c64);
    let autostartEnabled = true;

    // Games' saves live in browser storage; the user's disk images are never modified.
    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      return memoryStores();
    });
    const diskSaves = new DiskSaves(
      stores.diskSaves as KeyValueStore<DiskSaveRecord>,
      stores.saveDisks as KeyValueStore<SaveDiskRecord>,
    );
    const refreshSaveDisks = async () =>
      diskPanel.setSaveDisks(await diskSaves.listSaveDisks(), diskSaves.currentSaveDiskId);
    /** Stores whatever the drive has written to the inserted disk. */
    const persistDisk = async () => {
      if (!c64.syncDisk()) return;
      await diskSaves.persist(c64.diskImage!);
      if (diskSaves.currentSaveDiskId) await refreshSaveDisks();
      else diskPanel.setSavedChanges(true);
    };
    const insertWritable = (image: D64Image) => c64.insertDisk(image, { writable: true });

    const diskPanel = new DiskPanel(diskPanelRoot, {
      onFile: async (file) => {
        const media = await readMedia(file);
        if (media.kind === 'cartridge') {
          autostart.cancel();
          c64.insertCartridge(media.cartridge);
          return { kind: 'cartridge', name: media.cartridge.name || file.name };
        }
        await persistDisk();
        const { image, hasSavedChanges } = await diskSaves.openImage(mediaToD64(media.disk).bytes, file.name);
        // Only autostart from the READY prompt; mid-game this is a disk swap.
        const startIt = autostartEnabled && atReadyPrompt(c64);
        insertWritable(image);
        if (startIt) autostart.start();
        await refreshSaveDisks();
        return { kind: 'disk', name: petsciiToText(image.name).trim() || file.name, hasSavedChanges };
      },
      onEject: () => {
        void persistDisk().then(() => {
          diskSaves.eject();
          c64.insertDisk(null);
          return refreshSaveDisks();
        });
      },
      onRevert: async () => {
        const image = await diskSaves.revert();
        if (image) insertWritable(image);
      },
      onNewSaveDisk: async () => {
        await persistDisk();
        const { image, name } = await diskSaves.createSaveDisk();
        insertWritable(image);
        await refreshSaveDisks();
        return name;
      },
      onInsertSaveDisk: async (id) => {
        await persistDisk();
        const disk = await diskSaves.openSaveDisk(id);
        if (!disk) throw new Error('That save disk no longer exists.');
        insertWritable(disk.image);
        await refreshSaveDisks();
        return disk.name;
      },
      onExportSaveDisk: async (id) => {
        await persistDisk();
        const bytes = await diskSaves.saveDiskBytes(id);
        const name = (await diskSaves.listSaveDisks()).find((disk) => disk.id === id)?.name ?? 'save disk';
        if (bytes) downloadFile(bytes, `${name.toLowerCase().replace(/\s+/g, '-')}.d64`);
      },
      onDeleteSaveDisk: async (id) => {
        const wasInserted = diskSaves.currentSaveDiskId === id;
        await diskSaves.deleteSaveDisk(id);
        if (wasInserted) c64.insertDisk(null);
        await refreshSaveDisks();
      },
      onRemoveCartridge: () => {
        autostart.cancel();
        c64.insertCartridge(null);
      },
      onReset: () => {
        autostart.cancel();
        c64.reset();
      },
      onDriveMode: (mode) => c64.setDriveMode(mode),
      onWarp: (enabled) => (warp = enabled),
      onAutostart: (enabled) => (autostartEnabled = enabled),
      focusScreen: () => canvas.focus(),
    });
    diskPanel.configureDrive(c64.driveMode, c64.drive1541 !== null);
    c64.drive.onUnsupported = (message) => {
      console.warn(`[drive 8] ${message}`);
      diskPanel.showMessage(
        `${message} The program will probably hang. Switch the drive to Accurate (needs the 1541 ROM), ` +
          'press Reset C64 and try again. For Infocom games, answering N to the 1541 question also works.',
      );
    };
    if (!romSet.driveRom) {
      diskPanel.setNote(
        romSet.virtualDriveWorks
          ? 'Games with fast loaders need the 1541 drive ROM (roms/system/dos1541.rom).'
          : 'Disk loading needs the system ROMs in roms/system/.',
      );
    }

    canvas.focus();
    status.textContent = `${romSet.label}. Esc = RUN/STOP, Tab = CTRL, Alt = C=, PgUp = RESTORE`;
    startLoop(c64, screen, {
      gamepads,
      warp: () => warp,
      onDriveLed: (on) => diskPanel.setLed(on),
      audio,
      autostart,
      onDriveStopped: () => void persistDisk(),
    });
    await refreshSaveDisks();
    // Also save when the tab is hidden or closed, in case the drive is still spinning.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void persistDisk();
    });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
