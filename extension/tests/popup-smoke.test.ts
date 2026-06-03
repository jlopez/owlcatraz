import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Smoke test: import Popup.ts in a happy-dom environment with a mocked
// chrome.* surface, mount it, and verify it renders one of its known states.
// This catches startup-path regressions that vitest's pure-logic tests miss
// (missing event handlers, malformed innerHTML, unresolved promises, etc.).

interface MessageHandler {
  (message: unknown): void;
}

function makeChromeMock(opts: {
  statusResponse?: unknown;
  storage?: Record<string, unknown>;
}): typeof chrome & { _messageHandlers: MessageHandler[] } {
  const data: Record<string, unknown> = { ...(opts.storage ?? {}) };
  const messageHandlers: MessageHandler[] = [];

  const c = {
    runtime: {
      sendMessage: vi.fn(async (msg: { type: string }) => {
        if (msg.type === 'getStatus') {
          return (
            opts.statusResponse ?? {
              type: 'status',
              loggedIn: false,
              userId: null,
              courseLanguage: null,
              fromLanguage: null,
            }
          );
        }
        return { accepted: true };
      }),
      onMessage: {
        addListener: vi.fn((handler: MessageHandler) => {
          messageHandlers.push(handler);
        }),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            const v = data[k];
            if (v !== undefined) out[k] = v;
          }
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const k of Object.keys(items)) {
            const v = items[k];
            if (v !== undefined) data[k] = v;
          }
        }),
      },
    },
    cookies: {
      get: vi.fn(async () => null),
    },
  };
  return Object.assign(c, { _messageHandlers: messageHandlers }) as unknown as typeof chrome & {
    _messageHandlers: MessageHandler[];
  };
}

const globalRef = globalThis as unknown as { chrome?: typeof chrome };

describe('computeProgressFraction', () => {
  it('interpolates a determinate event within its step slice', async () => {
    const { computeProgressFraction } = await import('../src/popup/Popup');
    // enrich spans [0.3, 0.9]; 25/100 within-step → 0.3 + 0.6*0.25 = 0.45.
    expect(
      computeProgressFraction({ step: 'enrich', current: 25, total: 100, message: '' }),
    ).toBeCloseTo(0.45);
    // sync-anki spans [0.9, 1]; a completed ratio lands at the top of the bar.
    expect(
      computeProgressFraction({ step: 'sync-anki', current: 10, total: 10, message: '' }),
    ).toBeCloseTo(1);
  });

  it('clamps an out-of-range ratio into [start, end]', async () => {
    const { computeProgressFraction } = await import('../src/popup/Popup');
    expect(
      computeProgressFraction({ step: 'enrich', current: 200, total: 100, message: '' }),
    ).toBeCloseTo(0.9);
  });

  it('returns null (indeterminate) when no determinate ratio is available', async () => {
    const { computeProgressFraction } = await import('../src/popup/Popup');
    // Streaming fetch with unknown total.
    expect(computeProgressFraction({ step: 'fetch-lexemes', current: 50, message: '' })).toBeNull();
    // A step that only announces its start (no counts), and a zero total.
    expect(computeProgressFraction({ step: 'auth', message: '' })).toBeNull();
    expect(
      computeProgressFraction({ step: 'enrich', current: 0, total: 0, message: '' }),
    ).toBeNull();
  });
});

describe('Popup smoke', () => {
  let originalChrome: typeof chrome | undefined;

  beforeEach(() => {
    originalChrome = globalRef.chrome;
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  afterEach(() => {
    if (originalChrome === undefined) delete globalRef.chrome;
    else globalRef.chrome = originalChrome;
    document.body.innerHTML = '';
  });

  it('renders the not-logged-in state when no JWT cookie is set', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: false,
        userId: null,
        courseLanguage: null,
        error: null,
      },
    });
    const { renderPopup } = await import('../src/popup/Popup');
    await renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/Please log in/);
  });

  it('renders the needs-api-key state when logged in but no API key stored', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'el',
        error: null,
      },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/Set your Anthropic API key/);
    expect(root?.textContent).toMatch(/user 42/);
  });

  it('renders the ready state when logged in with a stored API key', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'el',
        error: null,
      },
      storage: { 'settings:apiKey': 'sk-ant-stored' },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.querySelector('#sync')).not.toBeNull();
  });

  it('renders the no-course-detected state when courseLanguage is null without an error', async () => {
    // Distinct from unsupported-course: profile fetched OK but the
    // currentCourse field came back without a learningLanguage. Different
    // remediation (wait/retry vs. switch courses).
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: null,
        error: null,
      },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/couldn't detect an active Duolingo course/i);
    expect(root?.querySelector('#try-again')).not.toBeNull();
  });

  it('renders the unsupported-course state when the active course is not in the registry', async () => {
    // `es` (Spanish) is not registered, so an active Spanish course is treated
    // as unsupported. (`fr` used to live here in PR 1; PR 2 registered French,
    // so it now renders the ready/needs-api-key state instead — see below.)
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'es',
        error: null,
      },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/es/);
    expect(root?.textContent).toMatch(/does not support yet/);
    // The supported list should mention the registered courses by display name.
    expect(root?.textContent).toMatch(/Greek/);
    expect(root?.textContent).toMatch(/French/);
  });

  it('renders the needs-api-key state for a French course when no API key is stored', async () => {
    // Regression guard for PR 2: French is registered, so an active `fr`
    // course must reach needs-api-key (not unsupported-course) and surface the
    // French display name.
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'fr',
        error: null,
      },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/Set your Anthropic API key/);
    expect(root?.textContent).toMatch(/French/);
  });

  it('renders the ready state for a French course when an API key is stored', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'fr',
        error: null,
      },
      storage: { 'settings:apiKey': 'sk-ant-stored' },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.querySelector('#sync')).not.toBeNull();
    expect(root?.textContent).toMatch(/French/);
  });

  it('renders the error state when the status carries a profile-fetch error', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: null,
        error: 'Could not read your Duolingo profile: HTTP 502',
      },
    });
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/HTTP 502/);
    expect(root?.querySelector('#try-again')).not.toBeNull();
  });

  it('renders a progress bar while syncing and advances it on progress events', async () => {
    globalRef.chrome = makeChromeMock({
      statusResponse: {
        type: 'status',
        loggedIn: true,
        userId: '42',
        courseLanguage: 'el',
        error: null,
      },
      storage: { 'settings:apiKey': 'sk-ant-stored' },
    });
    const c = globalRef.chrome as unknown as { _messageHandlers: MessageHandler[] };
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');

    // Kick off a sync; the view transitions to 'syncing' and renders a bar.
    root?.querySelector<HTMLButtonElement>('#sync')?.click();
    await Promise.resolve();
    expect(root?.querySelector('.progress')).not.toBeNull();

    // A determinate enrich event (50%) puts the fill mid-track. enrich spans
    // [0.3, 0.9], so 50/100 within-step → 0.6 overall → 60%.
    c._messageHandlers.forEach((h) =>
      h({
        type: 'progress',
        progress: { step: 'enrich', current: 50, total: 100, message: 'Enriching…' },
      }),
    );
    const fill = root?.querySelector<HTMLElement>('.progress-fill');
    expect(fill?.style.width).toBe('60%');
    expect(root?.querySelector('.progress')?.getAttribute('aria-valuenow')).toBe('60');
  });

  it('renders an error state when sendMessage(getStatus) rejects', async () => {
    const c = {
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error('SW not woken up');
        }),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
      cookies: { get: vi.fn(async () => null) },
    };
    globalRef.chrome = c as unknown as typeof chrome;
    const popupModule = await import('../src/popup/Popup');
    await popupModule.renderPopup(document.getElementById('root'));
    const root = document.getElementById('root');
    expect(root?.textContent).toMatch(/Could not contact/);
    expect(root?.querySelector('#try-again')).not.toBeNull();
  });
});
