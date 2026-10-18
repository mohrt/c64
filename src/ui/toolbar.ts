import type { SaveStateInfo } from '../storage/save-states';

export interface ToolbarCallbacks {
  onSaveState(): Promise<void>;
  onLoadState(id: string): Promise<void>;
  onDeleteState(id: string): Promise<void>;
  onExportState(): Promise<void>;
  onImportState(file: File): Promise<void>;
  /** Gives keyboard focus back to the emulator screen. */
  focusScreen(): void;
}

export interface Toolbar {
  setStates(states: SaveStateInfo[]): void;
  showMessage(text: string, isError?: boolean): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Toolbar is missing ${selector}`);
  return element;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** The row of emulator actions above the disk panel. */
export function attachToolbar(root: HTMLElement, callbacks: ToolbarCallbacks): Toolbar {
  const slots = requireChild<HTMLSelectElement>(root, 'select[name="state-slot"]');
  const fileInput = requireChild<HTMLInputElement>(root, 'input[name="state-file"]');
  const message = requireChild<HTMLElement>(root, '.toolbar-message');
  const stateButtons = ['load-state', 'delete-state'].map((action) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`),
  );
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  const showMessage = (text: string, isError = false) => {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    if (!isError) messageTimer = setTimeout(() => (message.textContent = ''), 4000);
  };

  const run = (action: () => Promise<void>) => {
    action()
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error), true))
      .finally(() => callbacks.focusScreen());
  };
  const onClick = (action: string, handler: () => Promise<void>) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', () => run(handler));

  onClick('save-state', () => callbacks.onSaveState());
  onClick('load-state', async () => {
    if (slots.value) await callbacks.onLoadState(slots.value);
  });
  onClick('delete-state', async () => {
    const option = slots.selectedOptions[0];
    if (option && confirm(`Delete the save state "${option.textContent}"?`)) await callbacks.onDeleteState(option.value);
  });
  onClick('export-state', () => callbacks.onExportState());
  onClick('import-state', async () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) run(() => callbacks.onImportState(file));
  });

  return {
    setStates: (states) => {
      slots.replaceChildren(
        ...states.map((state) => {
          const option = document.createElement('option');
          option.value = state.id;
          option.textContent = `${state.name}, ${timeFormat.format(state.created)}`;
          return option;
        }),
      );
      const empty = states.length === 0;
      slots.disabled = empty;
      stateButtons.forEach((button) => (button.disabled = empty));
      if (empty) {
        const option = document.createElement('option');
        option.textContent = 'No save states yet';
        slots.append(option);
      }
    },
    showMessage,
  };
}
