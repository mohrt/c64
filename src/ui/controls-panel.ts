export type PortNumber = 1 | 2;

export interface ControlsPanelCallbacks {
  onJoystickPort(port: PortNumber): void;
  onArrowKeys(enabled: boolean): void;
  /** W A S D + F as a second joystick, in the other port. */
  onSecondJoystickKeys(enabled: boolean): void;
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

/** Settings for the joystick, mouse and sound, shown under the disk panel. */
export function attachControlsPanel(root: HTMLElement, callbacks: ControlsPanelCallbacks): ControlsPanel {
  const joystickPort = requireField<HTMLSelectElement>(root, '[name="joystick-port"]');
  const arrowKeys = requireField<HTMLInputElement>(root, '[name="arrow-joystick"]');
  const secondJoystick = requireField<HTMLInputElement>(root, '[name="second-joystick"]');
  const mousePort = requireField<HTMLSelectElement>(root, '[name="mouse-port"]');
  const sound = requireField<HTMLInputElement>(root, '[name="sound"]');
  const volume = requireField<HTMLInputElement>(root, '[name="volume"]');
  const soundHint = requireField<HTMLElement>(root, '.sound-hint');

  const thenRefocus = (handler: () => void) => () => {
    handler();
    callbacks.focusScreen();
  };
  joystickPort.addEventListener('change', thenRefocus(() => callbacks.onJoystickPort(toPort(joystickPort.value) ?? 2)));
  arrowKeys.addEventListener('change', thenRefocus(() => callbacks.onArrowKeys(arrowKeys.checked)));
  secondJoystick.addEventListener('change', thenRefocus(() => callbacks.onSecondJoystickKeys(secondJoystick.checked)));
  mousePort.addEventListener('change', thenRefocus(() => callbacks.onMousePort(toPort(mousePort.value))));
  sound.addEventListener('change', thenRefocus(() => callbacks.onSound(sound.checked)));
  // The slider keeps focus while dragged and hands it back when released.
  volume.addEventListener('input', () => callbacks.onVolume(Number(volume.value)));
  volume.addEventListener('change', () => callbacks.focusScreen());

  // Apply the initial selections (browsers may restore form state on reload).
  callbacks.onJoystickPort(toPort(joystickPort.value) ?? 2);
  callbacks.onArrowKeys(arrowKeys.checked);
  callbacks.onSecondJoystickKeys(secondJoystick.checked);
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
