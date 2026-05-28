import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateApiKey,
  type Settings,
} from '../lib/settings';
import { chromeStorageAdapter } from '../lib/enrich';
import type { PopupMessage, StartSyncAck, StatusMessage, SWMessage } from '../lib/messages';
import type { FullSyncResult, SyncProgress } from '../lib/sync';

// Current release hardcodes Greek. Future multi-language support will pick
// this up from the actual current course returned by the status check.
const LANGUAGE = 'el';

type View =
  | { kind: 'loading' }
  | { kind: 'not-logged-in' }
  | { kind: 'wrong-course'; actual: string }
  | { kind: 'needs-api-key'; userId: string }
  | { kind: 'ready'; userId: string }
  | { kind: 'syncing'; progress: SyncProgress | null }
  | { kind: 'done'; result: FullSyncResult }
  | { kind: 'error'; message: string };

interface State {
  view: View;
  settings: Settings;
  showSettings: boolean;
  status: StatusMessage | null;
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStats(result: FullSyncResult): string {
  const r = result.anki;
  return `
    <table class="stats" style="width:100%;">
      <tr><td>Words fetched</td><td>${String(result.lexemeCount)}</td></tr>
      <tr><td>Enriched</td><td>${String(result.enrichmentCount)}</td></tr>
      <tr><td>Added to Anki</td><td>${String(r.added)}</td></tr>
      <tr><td>Updated (rebuild)</td><td>${String(r.updated)}</td></tr>
      <tr><td>Skipped (already current)</td><td>${String(r.skipped)}</td></tr>
      <tr><td>Audio stored</td><td>${String(r.audioStored)}</td></tr>
      <tr><td>Audio failed</td><td>${String(r.audioFailed)}</td></tr>
      <tr><td>Failed</td><td>${String(r.failed.length)}</td></tr>
    </table>
  `;
}

function renderProgress(progress: SyncProgress | null): string {
  if (progress === null) return '<div class="muted">Starting…</div>';
  const counter =
    progress.current !== undefined && progress.total !== undefined
      ? ` (${String(progress.current)} / ${String(progress.total)})`
      : progress.current !== undefined
        ? ` (${String(progress.current)})`
        : '';
  return `<div class="row">${escapeHTML(progress.message)}${escapeHTML(counter)}</div>`;
}

function renderSettingsPanel(state: State): string {
  if (!state.showSettings) {
    return `<div class="row"><button class="link" id="open-settings">Settings</button></div>`;
  }
  const validation = validateApiKey(state.settings.apiKey);
  const warn =
    validation.ok && validation.warning !== undefined
      ? `<div class="warn">${escapeHTML(validation.warning)}</div>`
      : '';
  const skipChecked = state.settings.skipAudio ? 'checked' : '';
  return `
    <div class="settings-panel">
      <label for="api-key">Anthropic API key</label>
      <input id="api-key" type="password" value="${escapeHTML(state.settings.apiKey)}" placeholder="sk-ant-…" autocomplete="off" />
      ${warn}
      <label for="deck-name">Anki deck name</label>
      <input id="deck-name" type="text" value="${escapeHTML(state.settings.deckName)}" />
      <label style="display:flex; align-items:center; gap:6px; margin-top:8px;">
        <input id="skip-audio" type="checkbox" ${skipChecked} />
        <span>Skip audio</span>
      </label>
      <div class="row" style="margin-top:12px;">
        <button class="primary" id="save-settings">Save</button>
        <button class="link" id="close-settings" style="margin-left:8px;">Close</button>
      </div>
    </div>
  `;
}

function renderView(state: State): string {
  const view = state.view;
  switch (view.kind) {
    case 'loading':
      return `<div class="muted">Loading…</div>`;
    case 'not-logged-in':
      return `
        <div class="row">Please log in at
          <a href="https://www.duolingo.com" target="_blank" rel="noopener">duolingo.com</a>
          first, then reopen this popup.
        </div>`;
    case 'wrong-course':
      return `
        <div class="row">Your active Duolingo course is <strong>${escapeHTML(view.actual)}</strong>, not <strong>${escapeHTML(LANGUAGE)}</strong>.</div>
        <div class="muted">Switch to the Greek course on duolingo.com and reopen this popup.</div>`;
    case 'needs-api-key':
      return `
        <div class="row">Logged in as user <strong>${escapeHTML(view.userId)}</strong>.</div>
        <div class="row">Set your Anthropic API key in Settings below to enable syncing.</div>`;
    case 'ready':
      return `
        <div class="row">Logged in as user <strong>${escapeHTML(view.userId)}</strong>, course <strong>${escapeHTML(LANGUAGE)}</strong>.</div>
        <div class="row"><button class="primary" id="sync">Sync to Anki</button></div>`;
    case 'syncing':
      return `
        <div class="row"><strong>Syncing…</strong></div>
        ${renderProgress(view.progress)}`;
    case 'done': {
      return `
        <div class="row"><strong>Done.</strong></div>
        ${renderStats(view.result)}
        <div class="row" style="margin-top:8px;"><button class="primary" id="sync-again">Sync again</button></div>`;
    }
    case 'error':
      return `
        <div class="error">${escapeHTML(view.message)}</div>
        <div class="row" style="margin-top:8px;"><button class="primary" id="try-again">Try again</button></div>`;
  }
}

function render(root: HTMLElement, state: State): void {
  root.innerHTML = `${renderView(state)}${renderSettingsPanel(state)}`;
}

function deriveViewFromStatus(status: StatusMessage, settings: Settings): View {
  if (!status.loggedIn) return { kind: 'not-logged-in' };
  if (status.error !== null) return { kind: 'error', message: status.error };
  const userId = status.userId ?? '?';
  if (status.courseLanguage !== null && status.courseLanguage !== LANGUAGE) {
    return { kind: 'wrong-course', actual: status.courseLanguage };
  }
  if (settings.apiKey.length === 0) return { kind: 'needs-api-key', userId };
  return { kind: 'ready', userId };
}

export async function renderPopup(target: HTMLElement | null): Promise<void> {
  if (target === null) return;

  const storage = chromeStorageAdapter();
  const state: State = {
    view: { kind: 'loading' },
    settings: { ...DEFAULT_SETTINGS },
    showSettings: false,
    status: null,
  };

  const rerender = (): void => {
    render(target, state);
    wireEvents();
  };

  function wireEvents(): void {
    const sync = target?.querySelector<HTMLButtonElement>('#sync');
    if (sync) sync.addEventListener('click', () => void startSync());
    const syncAgain = target?.querySelector<HTMLButtonElement>('#sync-again');
    if (syncAgain) syncAgain.addEventListener('click', () => void startSync());
    const tryAgain = target?.querySelector<HTMLButtonElement>('#try-again');
    if (tryAgain) tryAgain.addEventListener('click', () => void refreshStatus());
    const openSettings = target?.querySelector<HTMLButtonElement>('#open-settings');
    if (openSettings)
      openSettings.addEventListener('click', () => {
        state.showSettings = true;
        rerender();
      });
    const closeSettings = target?.querySelector<HTMLButtonElement>('#close-settings');
    if (closeSettings)
      closeSettings.addEventListener('click', () => {
        state.showSettings = false;
        rerender();
      });
    const saveBtn = target?.querySelector<HTMLButtonElement>('#save-settings');
    if (saveBtn) saveBtn.addEventListener('click', () => void onSaveSettings());

    // Live-sync settings inputs into in-memory state on every keystroke so
    // that an inbound message-driven rerender (e.g. a stale progress event)
    // never wipes the user's in-progress edits.
    const apiKeyInput = target?.querySelector<HTMLInputElement>('#api-key');
    if (apiKeyInput)
      apiKeyInput.addEventListener('input', () => {
        state.settings.apiKey = apiKeyInput.value;
      });
    const deckInput = target?.querySelector<HTMLInputElement>('#deck-name');
    if (deckInput)
      deckInput.addEventListener('input', () => {
        state.settings.deckName = deckInput.value;
      });
    const skipInput = target?.querySelector<HTMLInputElement>('#skip-audio');
    if (skipInput)
      skipInput.addEventListener('change', () => {
        state.settings.skipAudio = skipInput.checked;
      });
  }

  async function refreshStatus(): Promise<void> {
    state.view = { kind: 'loading' };
    rerender();
    try {
      const status = await chrome.runtime.sendMessage<PopupMessage, StatusMessage | undefined>({
        type: 'getStatus',
      });
      if (status === undefined || status === null) {
        state.view = {
          kind: 'error',
          message: 'No response from the extension. Try reopening the popup.',
        };
        rerender();
        return;
      }
      state.status = status;
      state.view = deriveViewFromStatus(status, state.settings);
      rerender();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.view = {
        kind: 'error',
        message: `Could not contact the extension service worker: ${message}`,
      };
      rerender();
    }
  }

  async function onSaveSettings(): Promise<void> {
    // Inputs have been streaming into state.settings via the input handlers
    // wired in wireEvents(); just persist whatever's there.
    await saveSettings(storage, state.settings);
    state.showSettings = false;
    if (state.status !== null) {
      state.view = deriveViewFromStatus(state.status, state.settings);
    }
    rerender();
  }

  async function startSync(): Promise<void> {
    const validation = validateApiKey(state.settings.apiKey);
    if (!validation.ok) {
      state.view = {
        kind: 'error',
        message: validation.reason ?? 'API key is invalid.',
      };
      rerender();
      return;
    }
    state.view = { kind: 'syncing', progress: null };
    rerender();
    let ack: StartSyncAck | undefined;
    try {
      ack = await chrome.runtime.sendMessage<PopupMessage, StartSyncAck | undefined>({
        type: 'startSync',
        settings: state.settings,
        language: LANGUAGE,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.view = {
        kind: 'error',
        message: `Could not start sync: ${message}`,
      };
      rerender();
      return;
    }
    if (ack === undefined || !ack.accepted) {
      state.view = {
        kind: 'error',
        message: 'A sync is already in progress. Wait for it to finish or reopen the popup.',
      };
      rerender();
    }
  }

  chrome.runtime.onMessage.addListener((msg: SWMessage): void => {
    // Gate all sync-related events on the 'syncing' view. A popup reopened
    // after closing mid-sync starts in 'loading' → 'ready', and an inbound
    // late result/error should not yank it elsewhere.
    if (state.view.kind !== 'syncing') return;
    if (msg.type === 'progress') {
      state.view = { kind: 'syncing', progress: msg.progress };
      rerender();
    } else if (msg.type === 'syncResult') {
      state.view = { kind: 'done', result: msg.result };
      rerender();
    } else if (msg.type === 'syncError') {
      state.view = { kind: 'error', message: msg.error };
      rerender();
    }
  });

  state.settings = await loadSettings(storage);
  await refreshStatus();
}
