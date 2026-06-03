import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateApiKey,
  type Settings,
} from '../lib/settings';
import { chromeStorageAdapter } from '../lib/enrich';
import {
  SUPPORTED_LANGUAGES,
  getLanguageModule,
  isSupportedLanguage,
  resolveDeckName,
} from '../lib/lang/registry';
import type { PopupMessage, StartSyncAck, StatusMessage, SWMessage } from '../lib/messages';
import type { FullSyncResult, SyncProgress, SyncStep } from '../lib/sync';

type View =
  | { kind: 'loading' }
  | { kind: 'not-logged-in' }
  // Known course code we don't support yet — actionable: switch course.
  | { kind: 'unsupported-course'; actual: string }
  // Profile fetched OK but no course code was present in currentCourse.
  // Distinct from `unsupported-course` because the remediation is different
  // (wait/retry rather than switch); the user-visible copy reflects that.
  | { kind: 'no-course-detected' }
  | { kind: 'needs-api-key'; userId: string; language: string }
  | { kind: 'ready'; userId: string; language: string }
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

function supportedDisplayList(): string {
  // e.g. "Greek (el)" or "Greek (el), French (fr)" — used in the
  // unsupported-course message so the user knows what to switch to.
  return SUPPORTED_LANGUAGES.map((code) => {
    const mod = getLanguageModule(code);
    return `${mod.displayName} (${mod.code})`;
  }).join(', ');
}

function activeLanguageFromView(view: View): string | null {
  if (view.kind === 'ready' || view.kind === 'needs-api-key') return view.language;
  return null;
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

// The pipeline runs five ordered steps; map each onto a slice of the overall
// bar so progress always moves forward across step transitions. Widths are
// weighted by how long each step typically takes — enrichment (LLM round-trips)
// dominates, so it owns the largest slice. The slices sum to 1.
const STEP_RANGES: Record<SyncStep, [number, number]> = {
  auth: [0, 0.04],
  profile: [0.04, 0.08],
  'fetch-lexemes': [0.08, 0.3],
  enrich: [0.3, 0.9],
  'sync-anki': [0.9, 1],
};

// Resolve a progress event to an overall completion fraction in [0, 1], or
// null when the current step can't report a determinate ratio (e.g. fetching
// lexemes with an as-yet-unknown total, or a step that only announces its
// start). null renders as an indeterminate (animated) bar so the user still
// sees activity.
export function computeProgressFraction(progress: SyncProgress): number | null {
  const [start, end] = STEP_RANGES[progress.step];
  if (progress.current !== undefined && progress.total !== undefined && progress.total > 0) {
    const within = Math.min(1, Math.max(0, progress.current / progress.total));
    return start + (end - start) * within;
  }
  return null;
}

function renderProgressBar(fraction: number | null): string {
  if (fraction === null) {
    return `<div class="progress indeterminate" role="progressbar" aria-busy="true"><div class="progress-fill"></div></div>`;
  }
  const pct = Math.round(fraction * 100);
  return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(pct)}"><div class="progress-fill" style="width:${String(pct)}%;"></div></div>`;
}

function renderProgress(progress: SyncProgress | null): string {
  if (progress === null) {
    return `${renderProgressBar(null)}<div class="muted">Starting…</div>`;
  }
  const counter =
    progress.current !== undefined && progress.total !== undefined
      ? ` (${String(progress.current)} / ${String(progress.total)})`
      : progress.current !== undefined
        ? ` (${String(progress.current)})`
        : '';
  return `${renderProgressBar(computeProgressFraction(progress))}<div class="row">${escapeHTML(progress.message)}${escapeHTML(counter)}</div>`;
}

function renderDeckNameField(state: State): string {
  // Bind the deck-name input to the active language. If we don't know the
  // active language yet (loading, not-logged-in, unsupported), hide the field
  // entirely — editing a deck for an unknown language is meaningless.
  const language = activeLanguageFromView(state.view);
  if (language === null) return '';
  const value = resolveDeckName(state.settings.deckNames, language);
  const module = getLanguageModule(language);
  return `
    <label for="deck-name">Anki deck name (${escapeHTML(module.displayName)})</label>
    <input id="deck-name" type="text" value="${escapeHTML(value)}" />
  `;
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
      ${renderDeckNameField(state)}
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
    case 'unsupported-course':
      return `
        <div class="row">Your active Duolingo course is <strong>${escapeHTML(view.actual)}</strong>, which this extension does not support yet.</div>
        <div class="muted">Supported courses: ${escapeHTML(supportedDisplayList())}. Switch on duolingo.com and click Try again.</div>
        <div class="row" style="margin-top:8px;"><button class="primary" id="try-again">Try again</button></div>`;
    case 'no-course-detected':
      return `
        <div class="row">We couldn't detect an active Duolingo course on your profile.</div>
        <div class="muted">If you just signed in, give Duolingo a moment to load your course, then click Try again.</div>
        <div class="row" style="margin-top:8px;"><button class="primary" id="try-again">Try again</button></div>`;
    case 'needs-api-key': {
      const module = getLanguageModule(view.language);
      return `
        <div class="row">Logged in as user <strong>${escapeHTML(view.userId)}</strong>, course <strong>${escapeHTML(module.displayName)}</strong>.</div>
        <div class="row">Set your Anthropic API key in Settings below to enable syncing.</div>`;
    }
    case 'ready': {
      const module = getLanguageModule(view.language);
      return `
        <div class="row">Logged in as user <strong>${escapeHTML(view.userId)}</strong>, course <strong>${escapeHTML(module.displayName)}</strong>.</div>
        <div class="row"><button class="primary" id="sync">Sync to Anki</button></div>`;
    }
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

export function deriveViewFromStatus(status: StatusMessage, settings: Settings): View {
  if (!status.loggedIn) return { kind: 'not-logged-in' };
  if (status.error !== null) return { kind: 'error', message: status.error };
  const userId = status.userId ?? '?';
  const courseLanguage = status.courseLanguage;
  // Distinguish "course we don't support yet" from "couldn't read a course
  // at all" — the user-actionable remediation differs and the copy reflects
  // that. See the View union for the rationale.
  if (courseLanguage === null) return { kind: 'no-course-detected' };
  if (!isSupportedLanguage(courseLanguage)) {
    return { kind: 'unsupported-course', actual: courseLanguage };
  }
  if (settings.apiKey.length === 0)
    return { kind: 'needs-api-key', userId, language: courseLanguage };
  return { kind: 'ready', userId, language: courseLanguage };
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
        const language = activeLanguageFromView(state.view);
        if (language === null) return;
        state.settings.deckNames = {
          ...state.settings.deckNames,
          [language]: deckInput.value,
        };
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
    const language = activeLanguageFromView(state.view);
    if (language === null) {
      state.view = {
        kind: 'error',
        message: 'Cannot start sync without a known active course.',
      };
      rerender();
      return;
    }
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
        language,
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
