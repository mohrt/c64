import { trackGameLoaded } from './analytics';
import { AudioOutput } from './audio/audio-output';
import { Autostart, atReadyPrompt } from './autostart';
import { C64 } from './c64';
import type { Cartridge } from './cartridge/cartridge';
import { createCartridge } from './cartridge/cartridge-types';
import { isCrt, parseCrt } from './cartridge/crt';
import { D64Image } from './disk/d64';
import { mediaToD64 } from './disk/d64-builder';
import { isT64, t64ToD64 } from './disk/t64';
import { isZip, usableFilesInZip } from './disk/zip';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from './storage/disk-saves';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import {
  SaveStates,
  decodeSession,
  encodeSession,
  looksLikeSaveState,
  type SaveStateRecord,
  type Session,
} from './storage/save-states';
import { downloadFile } from './ui/download';
import { attachToolbar } from './ui/toolbar';
import { petsciiToText, type DiskMedia } from './disk/media';
import { PrgMedia } from './disk/prg-media';
import {
  GamepadJoystick,
  KEY_SETS,
  KeyboardJoystick,
  combineInterceptors,
  describeGamepads,
} from './io/joystick-input';
import { BrowserKeyboard } from './io/keyboard';
import { Mouse1351 } from './io/mouse';
import { Screen } from './render/screen';
import { SystemRomStore, hasRequiredRoms, machineRoms, type StoredRom, type SystemRoms } from './roms/system-roms';
import { askForRoms } from './ui/rom-setup';
import { attachControlsPanel, type PortNumber } from './ui/controls-panel';
import { DiskPanel, type InsertedMedia } from './ui/disk-panel';
import { Settings } from './ui/settings';
import { FRAME_WIDTH } from './vic/vic2';
import { videoModel, type VideoModel } from './vic/video-model';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = [
  'video-model',
  'drive-mode',
  'warp',
  'autostart',
  'port1-keys',
  'port1-pad',
  'port2-keys',
  'port2-pad',
  'mouse-port',
  'show-gamepad-input',
  'sound',
  'volume',
];

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;

/** While the drive motor runs in warp mode, each animation frame emulates this long. */
const WARP_BUDGET_MS = 12;
const WARP_SLICE_CYCLES = 20_000;

function describeRoms(roms: SystemRoms): string {
  return roms.drive
    ? 'System ROMs: BASIC, KERNAL, characters and 1541 drive.'
    : 'System ROMs: BASIC, KERNAL and characters (no 1541 drive ROM).';
}

type Media =
  | { kind: 'disk'; disk: DiskMedia }
  | { kind: 'cartridge'; cartridge: Cartridge }
  | { kind: 'state'; session: Session };

/** Works out what a file is from its contents (falling back to the extension). */
async function readMedia(file: File): Promise<Media> {
  const data = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith('.c64state') || looksLikeSaveState(data)) return { kind: 'state', session: await decodeSession(data) };
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
  paused: () => boolean;
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
    if (options.paused()) {
      cycleDebt = 0;
      requestAnimationFrame(frame);
      return;
    }
    options.gamepads.forEach((gamepad) => gamepad.poll());
    const warpNow = options.warp() && c64.driveBusy;
    if (warpNow) {
      const stopAt = performance.now() + WARP_BUDGET_MS;
      while (performance.now() < stopAt && c64.driveBusy) c64.runCycles(WARP_SLICE_CYCLES);
      cycleDebt = 0;
    } else {
      cycleDebt += (elapsed * c64.model.clockHz) / 1000;
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

/** Sizes the screen for the picture of a PAL or NTSC TV. */
function showScreenAspect(model: VideoModel): void {
  const aspect = (FRAME_WIDTH * model.pixelAspect) / model.visibleLines;
  document.documentElement.style.setProperty('--screen-aspect', aspect.toFixed(4));
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
  const toolbarRoot = requireElement<HTMLElement>('#toolbar');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  const romSetup = requireElement<HTMLElement>('#rom-setup');
  const romLine = requireElement<HTMLElement>('.rom-line');

  try {
    // Games' saves and the user's ROMs live in browser storage; the user's disk images are never modified.
    let storageWorks = true;
    const stores = await openBrowserStores(() => {
      status.textContent =
        "Waiting for the browser's storage: if this C64 is open in another tab, close or reload that tab.";
    }).catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      storageWorks = false;
      return memoryStores();
    });
    const romStore = new SystemRomStore(stores.systemRoms as KeyValueStore<StoredRom>);
    if (!storageWorks) {
      requireElement<HTMLElement>('.rom-storage-note').textContent =
        "This browser isn't letting the page store files, so the ROMs will be forgotten when you close it.";
    }
    let systemRoms = await romStore.load();
    if (!hasRequiredRoms(systemRoms)) {
      status.textContent = 'Load the system ROMs above to switch the C64 on.';
      systemRoms = (await askForRoms(romSetup, romStore, systemRoms)) ?? systemRoms;
    }
    const driveRom = systemRoms.drive?.data ?? null;
    const c64 = new C64(machineRoms(systemRoms), driveRom ?? undefined);
    let warp = true;
    let paused = false;
    /** While the ROM setup is open over the running C64. */
    let changingRoms = false;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) c64.sid.setSampleRate(audio.sampleRate);

    const settings = new Settings();
    settings.bind(document, REMEMBERED_SETTINGS);
    if (settings.get('video-model') === 'ntsc') c64.setModel(videoModel('ntsc'));
    showScreenAspect(c64.model);

    const screen = new Screen(canvas, c64.model.visibleLines);
    c64.vic.onFrameComplete = (framebuffer) => screen.capture(framebuffer);

    // Each control port has its own keyboard keys and gamepad, as chosen in the controls panel.
    const portFor = (port: PortNumber) => (port === 1 ? c64.port1 : c64.port2);
    const portKeys = { 1: new KeyboardJoystick(c64.port1), 2: new KeyboardJoystick(c64.port2) };
    const portGamepads = { 1: new GamepadJoystick(c64.port1), 2: new GamepadJoystick(c64.port2) };
    const gamepads = Object.values(portGamepads);
    const mouse = new Mouse1351(canvas);
    new BrowserKeyboard(
      c64.keyboard,
      () => c64.pressRestore(),
      combineInterceptors(portKeys[1], portKeys[2]),
    ).attach(window);
    const controls = attachControlsPanel(controlsRoot, {
      onPortKeys: (port, keys) => portKeys[port].setKeys(keys ? KEY_SETS[keys] : {}),
      onPortGamepad: (port, pad) => portGamepads[port].setPad(pad),
      onMousePort: (port) => mouse.setPort(port ? portFor(port) : null),
      onSound: (enabled) => audio?.setEnabled(enabled),
      onVolume: (volume) => audio?.setVolume(volume),
      focusScreen: () => canvas.focus(),
    });
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');
    const showGamepadInput = requireElement<HTMLInputElement>('[name="show-gamepad-input"]');
    let gamepadStatusTimer: ReturnType<typeof setInterval> | undefined;
    const updateGamepadStatus = () => {
      const text = describeGamepads() || 'No gamepad found yet: plug one in and press one of its buttons.';
      if (gamepadStatus.textContent !== text) gamepadStatus.textContent = text;
    };
    const applyShowGamepadInput = () => {
      clearInterval(gamepadStatusTimer);
      gamepadStatus.hidden = !showGamepadInput.checked;
      if (showGamepadInput.checked) {
        updateGamepadStatus();
        gamepadStatusTimer = setInterval(updateGamepadStatus, 100);
      }
    };
    showGamepadInput.addEventListener('change', () => {
      applyShowGamepadInput();
      canvas.focus();
    });
    applyShowGamepadInput();
    if (!audio) {
      controls.disableSound('Sound is not supported in this browser');
    } else if (!audio.running) {
      controls.showSoundHint(true);
      audio.resumeOnGesture(window, () => controls.showSoundHint(false));
    }

    const autostart = new Autostart(c64);
    let autostartEnabled = true;

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
    /** The name shown for the inserted disk (also used to label save states). */
    let diskLabel: string | null = null;

    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const sessionName = () => c64.bus.cartridgeName ?? diskLabel ?? 'BASIC';
    const currentSession = (): Session => ({ machine: c64.saveState(), diskOrigin: diskSaves.originRef, diskLabel });
    const restoreSession = async (session: Session) => {
      autostart.cancel();
      await persistDisk();
      c64.loadState(session.machine);
      showScreenAspect(c64.model);
      toolbar.showVideoModel(c64.model.name);
      await diskSaves.adopt(session.diskOrigin);
      diskLabel = session.diskLabel;
      if (session.machine.disk) diskPanel.showDisk(diskLabel ?? 'Disk', 'from save state');
      else diskPanel.showEmpty();
      audio?.flush();
      await refreshSaveDisks();
    };

    /** Inserts a disk, tape, program or cartridge file, or loads a save state file. */
    const insertFile = async (file: File): Promise<InsertedMedia> => {
      const media = await readMedia(file);
      if (media.kind === 'state') {
        await restoreSession(media.session);
        toolbar.showMessage('Save state loaded');
        return { kind: 'state', name: file.name };
      }
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
      diskLabel = petsciiToText(image.name).trim() || file.name;
      return { kind: 'disk', name: diskLabel, hasSavedChanges };
    };

    /** Inserts a chosen file, or the first usable file in a zip. */
    const openFile = async (file: File) => {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (!isZip(head) && !file.name.toLowerCase().endsWith('.zip')) return insertFile(file);
      const files = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
      if (files.length === 0) throw new Error(`${file.name} has no disk, tape, program or cartridge files in it.`);
      diskPanel.setZipFiles(files, files[0].name);
      const media = await insertFile(files[0]);
      return { ...media, fileLabel: `${files[0].name} from ${file.name}` };
    };

    let bundledGames: BundledGame[] = [];
    const diskPanel = new DiskPanel(diskPanelRoot, {
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onFile: async (file) => {
        const media = await openFile(file);
        if (media.kind !== 'state') {
          trackGameLoaded('c64', bundledGames.find((entry) => entry.file.split('/').pop() === file.name)?.title);
        }
        return media;
      },
      onEject: () => {
        void persistDisk().then(() => {
          diskSaves.eject();
          c64.insertDisk(null);
          diskLabel = null;
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
        diskLabel = name;
        return name;
      },
      onInsertSaveDisk: async (id) => {
        await persistDisk();
        const disk = await diskSaves.openSaveDisk(id);
        if (!disk) throw new Error('That save disk no longer exists.');
        insertWritable(disk.image);
        await refreshSaveDisks();
        diskLabel = disk.name;
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
      onDriveMode: (mode) => c64.setDriveMode(mode),
      onWarp: (enabled) => (warp = enabled),
      onAutostart: (enabled) => (autostartEnabled = enabled),
      focusScreen: () => canvas.focus(),
    });
    if (settings.get('drive-mode') === 'fast') c64.setDriveMode('fast');
    diskPanel.configureDrive(c64.driveMode, c64.drive1541 !== null);
    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      diskPanel.setGames(
        games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })),
      );
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'c64';
    const toolbar = attachToolbar(toolbarRoot, {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        audio?.flush();
      },
      onReset: () => {
        autostart.cancel();
        c64.reset();
        diskPanel.showMessage('');
      },
      onVideoModel: (name) => {
        autostart.cancel();
        c64.setModel(videoModel(name));
        showScreenAspect(c64.model);
        diskPanel.showMessage('');
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void screenFrame.requestFullscreen().then(() => canvas.focus());
      },
      onSaveState: async () => {
        await persistDisk();
        await saveStates.add(sessionName(), currentSession());
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        await persistDisk();
        downloadFile(await encodeSession(currentSession()), `${slug(sessionName())}.c64state`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen: () => canvas.focus(),
    });
    await refreshStates();
    c64.drive.onUnsupported = (message) => {
      console.warn(`[drive 8] ${message}`);
      diskPanel.showMessage(
        `${message} The program will probably hang. Switch the drive to Accurate (needs the 1541 ROM), ` +
          'press Reset C64 and try again. For Infocom games, answering N to the 1541 question also works.',
      );
    };
    if (!driveRom) {
      diskPanel.setNote('Games with fast loaders need the 1541 drive ROM.');
      requireElement<HTMLElement>('.drive-rom-prompt').hidden = false;
    }
    requireElement<HTMLElement>('.rom-summary').textContent = describeRoms(systemRoms);
    romLine.hidden = false;
    /** Shows the ROM setup over the paused C64; new ROMs take effect by reloading the page. */
    const changeRoms = async () => {
      if (changingRoms) return;
      changingRoms = true;
      audio?.flush();
      const updated = await askForRoms(romSetup, romStore, await romStore.load(), { whileRunning: true });
      changingRoms = false;
      if (!updated) {
        canvas.focus();
        return;
      }
      await persistDisk();
      location.reload();
    };
    document
      .querySelectorAll<HTMLButtonElement>('[data-action="change-roms"], [data-action="add-drive-rom"]')
      .forEach((button) => button.addEventListener('click', () => void changeRoms()));

    canvas.focus();
    status.textContent = 'Esc = RUN/STOP, Tab = CTRL, Alt = C=, PgUp = RESTORE';
    startLoop(c64, screen, {
      paused: () => paused || changingRoms,
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
