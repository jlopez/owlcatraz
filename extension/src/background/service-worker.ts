import { chromeStorageAdapter } from '../lib/enrich';
import { decodeUserIdFromJwt, fetchUserProfile, readJwtCookie } from '../lib/duolingo';
import { extractCurrentCourse, runFullSync, type SyncProgress } from '../lib/sync';
import { resolveDeckName } from '../lib/lang/registry';
import type { PopupMessage, StartSyncAck, StartSyncMessage, StatusMessage } from '../lib/messages';

// Duolingo's API rejects POSTs whose Origin header is `chrome-extension://…`
// with a bare 403. Stripping the Origin header on duolingo.com requests
// initiated by this service worker (and only this service worker) makes the
// extension's authenticated calls succeed without modifying the user's
// normal browsing traffic.
//
// Registered as a *session* rule rather than a static rule in the manifest
// because Chrome MV3 rejects `tabIds` / `excludedTabIds` on static DNR
// rules — those scoping keys are session-rule-only. `tabIds: [-1]` is
// `chrome.tabs.TAB_ID_NONE`, which matches requests not tied to any tab
// (i.e. service-worker fetches).
//
// Session rules are cleared when the browser quits, so this needs to run on
// every service-worker startup — `onInstalled` for first install / reload,
// `onStartup` for browser launch. Re-registration is made idempotent by
// removing the rule id before re-adding it; a second registration without
// removal would fail with a duplicate-id error.
const DNR_RULE_ID_ORIGIN_STRIP = 1;

async function registerOriginStripRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID_ORIGIN_STRIP],
    addRules: [
      {
        id: DNR_RULE_ID_ORIGIN_STRIP,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'origin',
              operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
            },
          ],
        },
        condition: {
          urlFilter: '||duolingo.com/',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          tabIds: [-1],
        },
      },
    ],
  });
  // One log line per registration so future Chrome-version regressions in
  // DNR validation leave a breadcrumb in the service-worker console for
  // diagnosis.
  const chromeVersion = navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? 'unknown';
  console.info(
    `owlcatraz: registered DNR session rule (Chrome ${chromeVersion}, rule id ${String(DNR_RULE_ID_ORIGIN_STRIP)})`,
  );
}

chrome.runtime.onInstalled.addListener(() => {
  void registerOriginStripRule();
});

chrome.runtime.onStartup.addListener(() => {
  void registerOriginStripRule();
});

function postToPopup(message: object): void {
  // Popup may already be closed by the time progress events fire; swallow the
  // "Could not establish connection. Receiving end does not exist" error rather
  // than tearing down the in-flight sync.
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Module-level guard: only one runFullSync may be active at a time. A second
// startSync click while one is in flight returns {accepted: false} so the
// popup can surface the conflict instead of silently launching a parallel run.
let syncInFlight = false;

function dispatchStartSync(msg: StartSyncMessage): StartSyncAck {
  if (syncInFlight) return { accepted: false };
  syncInFlight = true;
  // Mirror every progress event to the SW console so the pipeline stays
  // observable when the popup is closed. Low volume — one line per step
  // transition (fetch-lexemes ticks every 50 words), not per lexeme — matching
  // the codebase's "one breadcrumb per meaningful event" logging style.
  const onProgress = (progress: SyncProgress): void => {
    const counter =
      progress.current !== undefined
        ? progress.total !== undefined
          ? ` (${String(progress.current)}/${String(progress.total)})`
          : ` (${String(progress.current)})`
        : '';
    console.info(`owlcatraz: [${progress.step}] ${progress.message}${counter}`);
    postToPopup({ type: 'progress', progress });
  };
  void (async () => {
    const deckName = resolveDeckName(msg.settings.deckNames, msg.language);
    console.info(`owlcatraz: sync started — language=${msg.language}, deck="${deckName}"`);
    try {
      const result = await runFullSync({
        apiKey: msg.settings.apiKey,
        deckName,
        skipAudio: msg.settings.skipAudio,
        language: msg.language,
        cookies: chrome.cookies,
        storage: chromeStorageAdapter(),
        fetchImpl: fetch.bind(globalThis),
        onProgress,
      });
      const a = result.anki;
      console.info(
        `owlcatraz: sync complete — fetched=${String(result.lexemeCount)}, ` +
          `enriched=${String(result.enrichmentCount)}, added=${String(a.added)}, ` +
          `updated=${String(a.updated)}, skipped=${String(a.skipped)}, ` +
          `audioStored=${String(a.audioStored)}, audioFailed=${String(a.audioFailed)}, ` +
          `failed=${String(a.failed.length)}`,
      );
      // Surface the per-note failure reasons (LemmaKey + reason) so a partial
      // failure is diagnosable from the console without re-running.
      if (a.failed.length > 0) console.warn('owlcatraz: failed notes', a.failed);
      postToPopup({ type: 'syncResult', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log the full error (stack included) for diagnosis; the popup only
      // receives the message string.
      console.error('owlcatraz: sync failed —', err);
      postToPopup({ type: 'syncError', error: message });
    } finally {
      syncInFlight = false;
    }
  })();
  return { accepted: true };
}

async function handleGetStatus(): Promise<StatusMessage> {
  let jwt: string | null;
  try {
    jwt = await readJwtCookie(chrome.cookies);
  } catch {
    return notLoggedIn();
  }
  if (jwt === null) return notLoggedIn();

  let userId: string;
  try {
    userId = decodeUserIdFromJwt(jwt);
  } catch {
    // Cookie present but unparseable — effectively "not logged in", because a
    // fresh duolingo.com sign-in is the recovery path.
    return notLoggedIn();
  }

  try {
    const profile = await fetchUserProfile({
      jwt,
      userId,
      fetchImpl: fetch.bind(globalThis),
    });
    const course = extractCurrentCourse(profile);
    return {
      type: 'status',
      loggedIn: true,
      userId,
      courseLanguage: course?.learningLanguage ?? null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: 'status',
      loggedIn: true,
      userId,
      courseLanguage: null,
      error: `Could not read your Duolingo profile: ${message}`,
    };
  }
}

function notLoggedIn(): StatusMessage {
  return {
    type: 'status',
    loggedIn: false,
    userId: null,
    courseLanguage: null,
    error: null,
  };
}

chrome.runtime.onMessage.addListener(
  (
    msg: PopupMessage,
    _sender,
    sendResponse: (response: StatusMessage | StartSyncAck) => void,
  ): boolean => {
    if (msg.type === 'getStatus') {
      void handleGetStatus().then(sendResponse);
      return true;
    }
    if (msg.type === 'startSync') {
      sendResponse(dispatchStartSync(msg));
      return false;
    }
    return false;
  },
);
