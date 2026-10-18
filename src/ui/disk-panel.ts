export type DriveModeChoice = 'accurate' | 'fast';

/** What a dropped or chosen file turned out to be, and the name to show for it. */
export interface InsertedMedia {
  kind: 'disk' | 'cartridge';
  name: string;
}

export interface DiskPanelCallbacks {
  /** Inserts the file (disk, tape image or cartridge); throws if it isn't usable. */
  onFile(file: File): Promise<InsertedMedia>;
  onEject(): void;
  onRemoveCartridge(): void;
  /** Resets the computer, keeping the disk in the drive. */
  onReset(): void;
  onDriveMode(mode: DriveModeChoice): void;
  onWarp(enabled: boolean): void;
  onAutostart(enabled: boolean): void;
  /** Gives keyboard focus back to the emulator screen. */
  focusScreen(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Disk panel is missing ${selector}`);
  return element;
}

/**
 * The box under the screen for inserting disks, tape images and cartridges:
 * drag-and-drop (anywhere on the page) or a file picker, plus what is inserted
 * and buttons to eject or remove it.
 */
export class DiskPanel {
  private readonly input: HTMLInputElement;
  private readonly diskName: HTMLElement;
  private readonly diskFile: HTMLElement;
  private readonly message: HTMLElement;
  private readonly note: HTMLElement;
  private readonly led: HTMLElement;
  private readonly driveMode: HTMLSelectElement;
  private readonly warp: HTMLInputElement;
  private readonly autostart: HTMLInputElement;
  private readonly cartSlot: HTMLElement;
  private readonly cartName: HTMLElement;
  /** dragenter/dragleave fire for every child element, so count them. */
  private dragDepth = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DiskPanelCallbacks,
  ) {
    this.input = requireChild(root, 'input[type="file"]');
    this.diskName = requireChild(root, '.disk-name');
    this.diskFile = requireChild(root, '.disk-file');
    this.message = requireChild(root, '.disk-message');
    this.note = requireChild(root, '.disk-note');
    this.led = requireChild(root, '.drive-led');
    this.driveMode = requireChild(root, 'select[name="drive-mode"]');
    this.warp = requireChild(root, 'input[name="warp"]');
    this.autostart = requireChild(root, 'input[name="autostart"]');
    this.cartSlot = requireChild(root, '.cart-slot');
    this.cartName = requireChild(root, '.cart-name');

    this.autostart.addEventListener('change', () => {
      this.callbacks.onAutostart(this.autostart.checked);
      this.callbacks.focusScreen();
    });
    requireChild<HTMLButtonElement>(root, '[data-action="remove-cart"]').addEventListener('click', () => {
      this.callbacks.onRemoveCartridge();
      this.cartSlot.hidden = true;
      this.message.textContent = '';
      this.callbacks.focusScreen();
    });

    this.driveMode.addEventListener('change', () => {
      const mode = this.driveMode.value === 'fast' ? 'fast' : 'accurate';
      this.root.dataset.driveMode = mode;
      this.callbacks.onDriveMode(mode);
      this.callbacks.focusScreen();
    });
    this.warp.addEventListener('change', () => {
      this.callbacks.onWarp(this.warp.checked);
      this.callbacks.focusScreen();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-action="choose"]').forEach((button) =>
      button.addEventListener('click', () => this.input.click()),
    );
    requireChild<HTMLButtonElement>(root, '[data-action="eject"]').addEventListener('click', () => this.eject());
    requireChild<HTMLButtonElement>(root, '[data-action="reset"]').addEventListener('click', () => this.reset());

    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      this.input.value = '';
      if (file) void this.insert(file);
    });
    this.input.addEventListener('cancel', () => this.callbacks.focusScreen());

    this.attachDragAndDrop(window);
  }

  /** Shows a standing notice, e.g. that the current ROMs can't use the drive. */
  setNote(text: string): void {
    this.note.textContent = text;
  }

  /** Sets the selected drive mode; without the 1541 ROM only the virtual drive is offered. */
  configureDrive(mode: DriveModeChoice, accurateAvailable: boolean): void {
    const accurateOption = this.driveMode.querySelector<HTMLOptionElement>('option[value="accurate"]');
    if (accurateOption) accurateOption.disabled = !accurateAvailable;
    this.driveMode.disabled = !accurateAvailable;
    this.driveMode.value = mode;
    this.root.dataset.driveMode = mode;
    this.callbacks.onWarp(this.warp.checked);
    this.callbacks.onAutostart(this.autostart.checked);
  }

  setLed(on: boolean): void {
    this.led.classList.toggle('on', on);
  }

  /** Shows a problem with the inserted disk until the next action. */
  showMessage(text: string): void {
    this.message.textContent = text;
  }

  private async insert(file: File): Promise<void> {
    try {
      const media = await this.callbacks.onFile(file);
      if (media.kind === 'cartridge') {
        this.cartName.textContent = `${media.name} (${file.name})`;
        this.cartSlot.hidden = false;
      } else {
        this.diskName.textContent = media.name;
        this.diskFile.textContent = `(${file.name})`;
        this.root.dataset.state = 'loaded';
      }
      this.message.textContent = '';
      this.callbacks.focusScreen();
    } catch (error) {
      this.message.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private eject(): void {
    this.callbacks.onEject();
    this.message.textContent = '';
    this.root.dataset.state = 'empty';
    this.callbacks.focusScreen();
  }

  private reset(): void {
    this.callbacks.onReset();
    this.message.textContent = '';
    this.callbacks.focusScreen();
  }

  private attachDragAndDrop(target: Window): void {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

    target.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth++;
      this.root.classList.add('drag-over');
    });
    target.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.root.classList.remove('drag-over');
    });
    target.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      // Handle drops anywhere so a near-miss doesn't make the browser open the file.
      event.preventDefault();
      this.dragDepth = 0;
      this.root.classList.remove('drag-over');
      const file = event.dataTransfer?.files[0];
      if (file) void this.insert(file);
    });
  }
}
