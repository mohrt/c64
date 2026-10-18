export type DriveModeChoice = 'accurate' | 'fast';

/** What a dropped or chosen file turned out to be, and the name to show for it. */
export interface InsertedMedia {
  kind: 'disk' | 'cartridge' | 'state';
  name: string;
  /** For disks: whether games' saves from earlier sessions were re-applied. */
  hasSavedChanges?: boolean;
  /** The file name to show, when it differs from the dropped file (e.g. inside a zip). */
  fileLabel?: string;
}

export interface SaveDiskOption {
  id: string;
  name: string;
}

export interface DiskPanelCallbacks {
  /** Inserts the file (disk, tape image or cartridge); throws if it isn't usable. */
  onFile(file: File): Promise<InsertedMedia>;
  onEject(): void;
  onRemoveCartridge(): void;
  onDriveMode(mode: DriveModeChoice): void;
  onWarp(enabled: boolean): void;
  onAutostart(enabled: boolean): void;
  /** Forgets the games saved to the inserted disk. */
  onRevert(): Promise<void>;
  /** Creates and inserts a blank save disk; returns its name. */
  onNewSaveDisk(): Promise<string>;
  /** Inserts a save disk; returns its name. */
  onInsertSaveDisk(id: string): Promise<string>;
  onExportSaveDisk(id: string): Promise<void>;
  onDeleteSaveDisk(id: string): Promise<void>;
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
  private readonly savedMarker: HTMLElement;
  private readonly revertButton: HTMLButtonElement;
  private readonly saveDiskList: HTMLElement;
  private readonly saveDiskSelect: HTMLSelectElement;
  private readonly zipFiles: HTMLElement;
  private readonly zipButtons: HTMLElement;
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
    this.savedMarker = requireChild(root, '.disk-saved');
    this.revertButton = requireChild(root, '[data-action="revert"]');
    this.saveDiskList = requireChild(root, '.save-disk-list');
    this.saveDiskSelect = requireChild(root, 'select[name="save-disk"]');
    this.zipFiles = requireChild(root, '.zip-files');
    this.zipButtons = requireChild(root, '.zip-buttons');

    const selectedSaveDisk = () => this.saveDiskSelect.value;
    this.onClick('revert', async () => {
      if (!confirm('Forget the games saved to this disk?')) return;
      await this.callbacks.onRevert();
      this.setSavedChanges(false);
    });
    this.onClick('new-save-disk', async () => this.showDisk(await this.callbacks.onNewSaveDisk(), 'save disk'));
    this.onClick('insert-save-disk', async () => {
      if (selectedSaveDisk()) this.showDisk(await this.callbacks.onInsertSaveDisk(selectedSaveDisk()), 'save disk');
    });
    this.onClick('export-save-disk', async () => {
      if (selectedSaveDisk()) await this.callbacks.onExportSaveDisk(selectedSaveDisk());
    });
    this.onClick('delete-save-disk', async () => {
      const option = this.saveDiskSelect.selectedOptions[0];
      if (!option || !confirm(`Delete ${option.textContent}? Games saved on it will be lost.`)) return;
      await this.callbacks.onDeleteSaveDisk(option.value);
    });

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

  /** Shows the inserted disk, e.g. "GAMES (zork.d64)". */
  showDisk(name: string, detail: string, hasSavedChanges = false): void {
    this.diskName.textContent = name;
    this.diskFile.textContent = `(${detail})`;
    this.root.dataset.state = 'loaded';
    this.setSavedChanges(hasSavedChanges);
  }

  showEmpty(): void {
    this.root.dataset.state = 'empty';
    this.setSavedChanges(false);
  }

  /** Marks whether games have saved to the inserted (dropped) disk image. */
  setSavedChanges(saved: boolean): void {
    this.savedMarker.hidden = !saved;
    this.revertButton.hidden = !saved;
  }

  setSaveDisks(disks: SaveDiskOption[], selectedId: string | null): void {
    this.saveDiskSelect.replaceChildren(
      ...disks.map((disk) => {
        const option = document.createElement('option');
        option.value = disk.id;
        option.textContent = disk.name;
        option.selected = disk.id === selectedId;
        return option;
      }),
    );
    this.saveDiskList.hidden = disks.length === 0;
  }

  /** Offers the other usable files from a dropped zip as buttons (an empty list hides the row). */
  setZipFiles(files: File[], currentName: string | null): void {
    this.zipButtons.replaceChildren(
      ...files.map((file) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = file.name;
        button.classList.toggle('current', file.name === currentName);
        button.addEventListener('click', () => {
          this.zipButtons.querySelectorAll('button').forEach((other) => other.classList.toggle('current', other === button));
          void this.insert(file, true);
        });
        return button;
      }),
    );
    this.zipFiles.hidden = files.length < 2;
  }

  /** Runs a button's async action, showing any error in the panel. */
  private onClick(action: string, run: () => Promise<void>): void {
    requireChild<HTMLButtonElement>(this.root, `[data-action="${action}"]`).addEventListener('click', () => {
      this.message.textContent = '';
      run()
        .catch((error: unknown) => (this.message.textContent = error instanceof Error ? error.message : String(error)))
        .finally(() => this.callbacks.focusScreen());
    });
  }

  private async insert(file: File, fromZip = false): Promise<void> {
    try {
      if (!fromZip) this.setZipFiles([], null);
      const media = await this.callbacks.onFile(file);
      const label = media.fileLabel ?? file.name;
      if (media.kind === 'cartridge') {
        this.cartName.textContent = `${media.name} (${label})`;
        this.cartSlot.hidden = false;
      } else if (media.kind === 'disk') {
        this.showDisk(media.name, label, media.hasSavedChanges);
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
