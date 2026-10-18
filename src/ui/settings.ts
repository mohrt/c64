const STORAGE_KEY = 'c64-settings';

type SettingValue = string | boolean;
type SettingField = HTMLInputElement | HTMLSelectElement;

function isCheckbox(field: SettingField): field is HTMLInputElement {
  return field instanceof HTMLInputElement && field.type === 'checkbox';
}

/** localStorage, or null where the browser blocks it (e.g. some private modes). */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembers the page's settings fields between visits. */
export class Settings {
  private readonly values: Record<string, SettingValue>;

  constructor(private readonly storage: Storage | null = browserStorage()) {
    let saved: unknown = null;
    try {
      saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      // Unreadable settings are simply forgotten.
    }
    this.values = saved && typeof saved === 'object' ? (saved as Record<string, SettingValue>) : {};
  }

  get(name: string): SettingValue | undefined {
    return this.values[name];
  }

  /**
   * Fills in the named fields with their remembered values and saves later changes.
   * Call this before the panels read the fields' initial values.
   */
  bind(root: ParentNode, names: string[]): void {
    for (const name of names) {
      const field = root.querySelector<SettingField>(`[name="${name}"]`);
      if (!field) throw new Error(`Page is missing the ${name} setting`);
      this.restore(field, this.values[name]);
      field.addEventListener('change', () => {
        this.values[name] = isCheckbox(field) ? field.checked : field.value;
        this.save();
      });
    }
  }

  private restore(field: SettingField, value: SettingValue | undefined): void {
    if (isCheckbox(field)) {
      if (typeof value === 'boolean') field.checked = value;
    } else if (typeof value === 'string') {
      const previous = field.value;
      field.value = value;
      // A select ends up with no value if the saved option no longer exists.
      if (field.value !== value) field.value = previous;
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Out of quota or blocked: the settings just won't be remembered.
    }
  }
}
