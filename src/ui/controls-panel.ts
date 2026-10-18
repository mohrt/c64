import type { KeySetName } from '../io/joystick-input';

export type PortNumber = 1 | 2;
const PORTS: PortNumber[] = [1, 2];

export interface ControlsPanelCallbacks {
  /** Which keys act as the joystick in a port; null for none. */
  onPortKeys(port: PortNumber, keys: KeySetName | null): void;
  /** Which gamepad (by browser index) acts as the joystick in a port; null for none. */
  onPortGamepad(port: PortNumber, pad: number | null): void;
  /** `null` unplugs the mouse. */
  onMousePort(port: PortNumber | null): void;
  onSound(enabled: boolean): void;
  /** Volume from 0 to 1. */
  onVolume(volume: number): void;
  /** Gives keyboard focus back to the emulator screen. */
  focusScreen(): void;
}

export interface ControlsPanel {
  /** Shows or hides the "click to start sound" hint. */
  showSoundHint(visible: boolean): void;
  /** Disables the sound controls when the browser has no audio support. */
  disableSound(reason: string): void;
}

function requireField<T extends HTMLElement>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Controls panel is missing ${selector}`);
  return element;
}

const toPort = (value: string): PortNumber | null => (value === '1' ? 1 : value === '2' ? 2 : null);
const toKeySet = (value: string): KeySetName | null =>
  value === 'numpad' || value === 'arrows' || value === 'wasd' ? value : null;
const toPad = (value: string): number | null => (value === 'off' ? null : Number(value));
const otherPort = (port: PortNumber): PortNumber => (port === 1 ? 2 : 1);

/** Settings for the joysticks, mouse and sound, shown under the disk panel. */
export function attachControlsPanel(root: HTMLElement, callbacks: ControlsPanelCallbacks): ControlsPanel {
  const keysFor = (port: PortNumber) => requireField<HTMLSelectElement>(root, `[name="port${port}-keys"]`);
  const padFor = (port: PortNumber) => requireField<HTMLSelectElement>(root, `[name="port${port}-pad"]`);
  const mousePort = requireField<HTMLSelectElement>(root, '[name="mouse-port"]');
  const sound = requireField<HTMLInputElement>(root, '[name="sound"]');
  const volume = requireField<HTMLInputElement>(root, '[name="volume"]');
  const soundHint = requireField<HTMLElement>(root, '.sound-hint');

  /** Sets a field as if the user had changed it, so its handlers (and remembered settings) follow. */
  const change = (field: HTMLSelectElement, value: string) => {
    if (field.value === value) return;
    field.value = value;
    field.dispatchEvent(new Event('change'));
  };

  for (const port of PORTS) {
    const keys = keysFor(port);
    const pad = padFor(port);
    // The same keys or gamepad can only be in one port, so taking them moves them.
    keys.addEventListener('change', () => {
      if (keys.value !== 'off' && keysFor(otherPort(port)).value === keys.value) change(keysFor(otherPort(port)), 'off');
      callbacks.onPortKeys(port, toKeySet(keys.value));
      callbacks.focusScreen();
    });
    pad.addEventListener('change', () => {
      if (pad.value !== 'off' && padFor(otherPort(port)).value === pad.value) change(padFor(otherPort(port)), 'off');
      callbacks.onPortGamepad(port, toPad(pad.value));
      callbacks.focusScreen();
    });
  }
  requireField<HTMLButtonElement>(root, '[data-action="swap-ports"]').addEventListener('click', () => {
    const [keys1, pad1] = [keysFor(1).value, padFor(1).value];
    const [keys2, pad2] = [keysFor(2).value, padFor(2).value];
    // Clear port 1 first so moving port 2's choices there doesn't count as taking them.
    change(keysFor(1), 'off');
    change(padFor(1), 'off');
    change(keysFor(1), keys2);
    change(padFor(1), pad2);
    change(keysFor(2), keys1);
    change(padFor(2), pad1);
    callbacks.focusScreen();
  });

  const thenRefocus = (handler: () => void) => () => {
    handler();
    callbacks.focusScreen();
  };
  mousePort.addEventListener('change', thenRefocus(() => callbacks.onMousePort(toPort(mousePort.value))));
  sound.addEventListener('change', thenRefocus(() => callbacks.onSound(sound.checked)));
  // The slider keeps focus while dragged and hands it back when released.
  volume.addEventListener('input', () => callbacks.onVolume(Number(volume.value)));
  volume.addEventListener('change', () => callbacks.focusScreen());

  // Apply the initial selections (which may have been restored from an earlier visit).
  for (const port of PORTS) {
    callbacks.onPortKeys(port, toKeySet(keysFor(port).value));
    callbacks.onPortGamepad(port, toPad(padFor(port).value));
  }
  callbacks.onMousePort(toPort(mousePort.value));
  callbacks.onSound(sound.checked);
  callbacks.onVolume(Number(volume.value));

  return {
    showSoundHint: (visible) => (soundHint.hidden = !visible),
    disableSound: (reason) => {
      sound.disabled = volume.disabled = true;
      sound.checked = false;
      soundHint.hidden = false;
      soundHint.textContent = reason;
    },
  };
}
