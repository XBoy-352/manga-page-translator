import { loadSettings, saveSettings } from '../../shared/settings';
import { LOCAL_LLM, MODEL_REGISTRY, type ModelEntry } from '../../lib/modelRegistry';
import { cachedIds, clearModels, fetchToOpfs } from '../../lib/modelCache';
import type { BackendKind, InpaintMode, Settings, SrcLang } from '../../shared/types';
// Task note cites backend.ts, but nanoAvailable() is exported from nano.ts
// (backend.ts only mentions it in a comment) — import from the real path.
import { nanoAvailable } from '../../core/translate/nano';

// ---- settings editor (fixB) ----

// Drift flag: shared/types.ts Settings has no remoteApiKey yet (SPEC §7.1
// names it; remote.ts does not read it yet — s1/s8 owner). It is persisted
// here as an extra property of the same 'settings' object through the
// existing helpers, so it round-trips and starts flowing to the remote
// backend as soon as the type gains the field.
type StoredSettings = Settings & { remoteApiKey?: string };

const backendSelect = document.querySelector<HTMLSelectElement>('#setting-backend');
const srcLangSelect = document.querySelector<HTMLSelectElement>('#setting-src-lang');
const tgtLangInput = document.querySelector<HTMLInputElement>('#setting-tgt-lang');
const teleaRadio = document.querySelector<HTMLInputElement>('input[name="inpaint"][value="telea"]');
const lamaRadio = document.querySelector<HTMLInputElement>('input[name="inpaint"][value="lama"]');
const liteCheckbox = document.querySelector<HTMLInputElement>('#setting-lite');
const sfxInput = document.querySelector<HTMLInputElement>('#setting-sfx-threshold');
const remoteUrlInput = document.querySelector<HTMLInputElement>('#setting-remote-url');
const remoteUrlError = document.querySelector<HTMLElement>('#remote-url-error');
const remoteApiKeyInput = document.querySelector<HTMLInputElement>('#setting-remote-api-key');
const glossaryRows = document.querySelector<HTMLElement>('#glossary-rows');
const glossaryAdd = document.querySelector<HTMLButtonElement>('#glossary-add');

let current: StoredSettings | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const SAVE_DEBOUNCE_MS = 300;

function urlIsValid(url: string): boolean {
  return url === '' || /^https?:\/\//.test(url);
}

function showUrlError(): void {
  if (remoteUrlError) remoteUrlError.hidden = false;
}

function hideUrlError(): void {
  if (remoteUrlError) remoteUrlError.hidden = true;
}

/** A glossary row is skippable when a field is empty or holds a misplaced
 * '=' (the only valid '=' is the src=dst separator itself). */
function glossaryRowIsValid(src: string, dst: string): boolean {
  return src !== '' && dst !== '' && !src.includes('=') && !dst.includes('=');
}

function addGlossaryRow(src = '', dst = ''): void {
  if (!glossaryRows) return;
  const row = document.createElement('div');
  row.className = 'glossary-row';

  const srcInput = document.createElement('input');
  srcInput.type = 'text';
  srcInput.className = 'glossary-src';
  srcInput.placeholder = 'src';
  srcInput.value = src;
  row.appendChild(srcInput);

  const dstInput = document.createElement('input');
  dstInput.type = 'text';
  dstInput.className = 'glossary-dst';
  dstInput.placeholder = 'dst';
  dstInput.value = dst;
  row.appendChild(dstInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'glossary-remove';
  removeBtn.textContent = 'Remove';
  row.appendChild(removeBtn);

  const hint = document.createElement('p');
  hint.className = 'glossary-hint';
  hint.textContent = 'Use src=dst';
  hint.hidden = true;
  row.appendChild(hint);

  const updateHint = (): void => {
    hint.hidden = glossaryRowIsValid(srcInput.value.trim(), dstInput.value.trim());
  };
  srcInput.addEventListener('input', () => {
    updateHint();
    scheduleSave();
  });
  dstInput.addEventListener('input', () => {
    updateHint();
    scheduleSave();
  });
  // 'change' fires when a text field is committed (blur) — flush immediately.
  srcInput.addEventListener('change', flushSave);
  dstInput.addEventListener('change', flushSave);
  removeBtn.addEventListener('click', () => {
    row.remove();
    flushSave();
  });

  glossaryRows.appendChild(row);
  updateHint();
}

function collectGlossary(): { src: string; dst: string }[] {
  const entries: { src: string; dst: string }[] = [];
  if (!glossaryRows) return entries;
  for (const row of glossaryRows.querySelectorAll('.glossary-row')) {
    const src = row.querySelector<HTMLInputElement>('.glossary-src')?.value.trim() ?? '';
    const dst = row.querySelector<HTMLInputElement>('.glossary-dst')?.value.trim() ?? '';
    if (!glossaryRowIsValid(src, dst)) continue; // invalid rows are skipped on save
    entries.push({ src, dst });
  }
  return entries;
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function flushSave(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  void persist();
}

async function persist(): Promise<void> {
  if (
    !current ||
    !backendSelect ||
    !srcLangSelect ||
    !tgtLangInput ||
    !teleaRadio ||
    !lamaRadio ||
    !liteCheckbox ||
    !sfxInput ||
    !remoteUrlInput ||
    !remoteApiKeyInput
  ) {
    return;
  }
  const next: StoredSettings = { ...current };
  next.backend = backendSelect.value as BackendKind;
  next.srcLang = srcLangSelect.value as SrcLang;
  next.tgtLang = 'en'; // fixed in v1 (A2); the input is disabled
  next.inpaint = (lamaRadio.checked ? 'lama' : 'telea') as InpaintMode;
  next.lite = liteCheckbox.checked;
  const parsed = Number(sfxInput.value);
  if (Number.isFinite(parsed)) next.sfxThreshold = Math.min(1, Math.max(0, parsed));
  const url = remoteUrlInput.value;
  if (urlIsValid(url)) {
    next.remoteUrl = url;
    hideUrlError();
  } else {
    // Inline error only: the invalid text stays in the input, the last valid
    // URL stays in storage — an unusable URL is never persisted.
    showUrlError();
  }
  next.remoteApiKey = remoteApiKeyInput.value;
  next.glossary = collectGlossary();
  current = next;
  try {
    await saveSettings(next);
  } catch (e) {
    console.error('Saving settings failed', e);
  }
}

async function initSettings(): Promise<void> {
  if (
    !backendSelect ||
    !srcLangSelect ||
    !tgtLangInput ||
    !teleaRadio ||
    !lamaRadio ||
    !liteCheckbox ||
    !sfxInput ||
    !remoteUrlInput ||
    !remoteApiKeyInput ||
    !glossaryRows ||
    !glossaryAdd
  ) {
    return; // markup missing — nothing to bind
  }
  const saved = (await loadSettings()) as StoredSettings;

  // AC9: offer 'nano' only when the Prompt API is present and fully
  // available; the option is absent (not disabled) otherwise.
  const available: BackendKind[] = (await nanoAvailable())
    ? ['local', 'remote', 'nano']
    : ['local', 'remote'];
  for (const kind of available) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    backendSelect.appendChild(option);
  }
  let backend = saved.backend;
  if (!available.includes(backend)) {
    // §10: storage says 'nano' but nano is unavailable (or the stored value
    // is unknown) → fall back to 'local' and persist the correction.
    backend = 'local';
    current = { ...saved, backend };
    void saveSettings(current).catch((e) => console.error('Saving settings failed', e));
  }
  backendSelect.value = backend;
  if (!current) current = saved;

  srcLangSelect.value = saved.srcLang;
  tgtLangInput.value = saved.tgtLang;
  (saved.inpaint === 'lama' ? lamaRadio : teleaRadio).checked = true;
  liteCheckbox.checked = saved.lite;
  sfxInput.value = String(saved.sfxThreshold);
  remoteUrlInput.value = saved.remoteUrl;
  if (!urlIsValid(saved.remoteUrl)) showUrlError();
  remoteApiKeyInput.value = saved.remoteApiKey ?? '';
  for (const entry of saved.glossary) addGlossaryRow(entry.src, entry.dst);

  backendSelect.addEventListener('change', flushSave);
  srcLangSelect.addEventListener('change', flushSave);
  teleaRadio.addEventListener('change', flushSave);
  lamaRadio.addEventListener('change', flushSave);
  liteCheckbox.addEventListener('change', flushSave);
  sfxInput.addEventListener('input', scheduleSave);
  sfxInput.addEventListener('change', flushSave);
  remoteUrlInput.addEventListener('input', scheduleSave);
  remoteUrlInput.addEventListener('change', flushSave);
  remoteApiKeyInput.addEventListener('input', scheduleSave);
  remoteApiKeyInput.addEventListener('change', flushSave);
  glossaryAdd.addEventListener('click', () => {
    addGlossaryRow();
    flushSave(); // empty rows are skipped on save, so this is a no-op write
  });
  window.addEventListener('pagehide', flushSave); // best effort flush on close
}

initSettings().catch((e) => console.error('Settings editor failed to initialize', e));

// ---- Models section (s2) ----

const BYTES_PER_MB = 1024 * 1024; // assumption taken -- MB means MiB, matching the registry's MiB-aligned byte values.

interface Row {
  statusEl: HTMLElement;
  button: HTMLButtonElement;
  controller: AbortController | null;
  cached: boolean;
}

const rows = new Map<string, Row>();

function formatSize(bytes: number): string {
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatExact(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes (${formatSize(bytes)})`;
}

function fileNameOf(entry: ModelEntry): string {
  return entry.url.slice(entry.url.lastIndexOf('/') + 1);
}

function setStatus(row: Row, text: string, isError = false): void {
  row.statusEl.textContent = text;
  row.statusEl.classList.toggle('error', isError);
}

function setIdle(row: Row): void {
  row.controller = null;
  row.button.textContent = 'Download';
  row.button.disabled = row.cached;
  setStatus(row, row.cached ? 'Cached.' : '');
}

function buildRow(parent: Element, id: string, fileName: string, exactSize: string, note: string | null): Row {
  const rowEl = document.createElement('div');
  rowEl.className = 'model-row';

  const meta = document.createElement('div');
  meta.className = 'model-meta';
  const name = document.createElement('strong');
  name.textContent = id;
  meta.appendChild(name);
  const file = document.createElement('span');
  file.className = 'model-file';
  file.textContent = fileName;
  meta.appendChild(file);
  const size = document.createElement('span');
  size.className = 'model-size';
  size.textContent = exactSize;
  meta.appendChild(size);
  rowEl.appendChild(meta);

  const state = document.createElement('div');
  state.className = 'model-state';
  const status = document.createElement('span');
  status.className = 'model-status';
  state.appendChild(status);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'download';
  if (note !== null) {
    button.hidden = true;
    status.textContent = note;
  } else {
    button.textContent = 'Download';
  }
  state.appendChild(button);
  rowEl.appendChild(state);
  parent.appendChild(rowEl);

  const row: Row = { statusEl: status, button, controller: null, cached: false };
  if (note === null) {
    button.addEventListener('click', () => {
      if (row.controller) {
        row.controller.abort();
      } else {
        void startDownload(id, row);
      }
    });
  }
  return row;
}

async function refreshCached(): Promise<void> {
  let ids: Set<string>;
  try {
    ids = await cachedIds();
  } catch {
    return; // leave rows as-is on storage errors
  }
  for (const [id, row] of rows) {
    if (row.controller) continue; // download in flight
    row.cached = ids.has(id);
    setIdle(row);
  }
}

async function startDownload(id: string, row: Row): Promise<void> {
  const entry = MODEL_REGISTRY.find((e) => e.id === id);
  if (!entry) return;
  const confirmed = await confirmDownload([entry]);
  if (!confirmed) {
    setStatus(row, 'Cancelled — nothing downloaded.');
    return;
  }
  row.controller = new AbortController();
  row.button.textContent = 'Cancel';
  row.button.disabled = false;
  try {
    await fetchToOpfs(
      entry,
      (mb, totalMb) => setStatus(row, `${mb.toFixed(1)} / ${totalMb.toFixed(1)} MB`),
      row.controller.signal,
    );
    row.cached = true;
    setIdle(row);
  } catch (e) {
    row.controller = null;
    row.button.textContent = 'Download';
    row.button.disabled = false;
    if (e instanceof DOMException && e.name === 'AbortError') {
      // fetchToOpfs already deleted the .tmp file; nothing was cached.
      setStatus(row, 'Cancelled — nothing cached.');
    } else {
      setStatus(row, e instanceof Error ? e.message : String(e), true);
    }
  }
  await refreshCached();
}

function confirmDownload(entries: ModelEntry[]): Promise<boolean> {
  return new Promise((resolve) => {
    const list = document.querySelector('#consent-files');
    if (list) {
      list.textContent = '';
      for (const entry of entries) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = fileNameOf(entry);
        li.appendChild(code);
        li.appendChild(document.createTextNode(` — ${formatExact(entry.bytes)}`));
        list.appendChild(li);
      }
    }
    const dialog = document.querySelector<HTMLDialogElement>('#consent-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      resolve(false);
      return;
    }
    dialog.showModal();
    const done = (result: boolean) => {
      dialog.removeEventListener('cancel', onCancelEvent);
      confirmBtn?.removeEventListener('click', onConfirm);
      cancelBtn?.removeEventListener('click', onCancel);
      dialog.close();
      resolve(result);
    };
    const onConfirm = () => done(true);
    const onCancel = () => done(false);
    const onCancelEvent = (e: Event) => {
      e.preventDefault();
      done(false);
    };
    const confirmBtn = dialog.querySelector<HTMLButtonElement>('#consent-confirm');
    const cancelBtn = dialog.querySelector<HTMLButtonElement>('#consent-cancel');
    dialog.addEventListener('cancel', onCancelEvent);
    confirmBtn?.addEventListener('click', onConfirm);
    cancelBtn?.addEventListener('click', onCancel);
  });
}

async function buildModelsSection(): Promise<void> {
  const container = document.querySelector('#model-rows');
  if (!container) return;

  for (const entry of MODEL_REGISTRY) {
    const row = buildRow(container, entry.id, fileNameOf(entry), formatExact(entry.bytes), null);
    rows.set(entry.id, row);
  }

  // assumption taken -- the LOCAL_LLM weights are fetched by Transformers.js
  // from its repo (§7.9: never rehosted) and cached in its default browser
  // cache on first use of the local backend (A4), so this row shows the repo
  // and size but has no Download button of its own.
  const llm = buildRow(
    container,
    LOCAL_LLM.repo,
    'Transformers.js (default browser cache)',
    formatExact(LOCAL_LLM.bytes),
    'Downloads automatically on first use of the local backend.',
  );
  rows.set(LOCAL_LLM.repo, llm);

  const clearBtn = document.querySelector<HTMLButtonElement>('#clear-models');
  const modelsStatus = document.querySelector<HTMLElement>('#models-status');
  clearBtn?.addEventListener('click', () => {
    void (async () => {
      if (!window.confirm('Delete all cached model files?')) return;
      try {
        await clearModels();
        if (modelsStatus) modelsStatus.textContent = 'Cleared.';
      } catch (e) {
        if (modelsStatus) modelsStatus.textContent = e instanceof Error ? e.message : String(e);
      }
      await refreshCached();
    })();
  });

  await refreshCached();
}

buildModelsSection().catch((e) => console.error('Models section failed to initialize', e));
