import { DEFAULT_SETTINGS } from '../../shared/settings';
import { LOCAL_LLM, MODEL_REGISTRY, type ModelEntry } from '../../lib/modelRegistry';
import { cachedIds, clearModels, fetchToOpfs } from '../../lib/modelCache';

// ---- settings stub (kept working; full editor lands in later slices) ----

const listEl = document.querySelector('#setting-keys');
if (listEl) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const li = document.createElement('li');
    li.textContent = key;
    listEl.appendChild(li);
  }
}

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
