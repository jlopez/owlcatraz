import type { Settings } from './settings';
import type { FullSyncResult, SyncProgress } from './sync';

export interface StartSyncMessage {
  type: 'startSync';
  settings: Settings;
  language: string;
}

export interface GetStatusMessage {
  type: 'getStatus';
}

export type PopupMessage = StartSyncMessage | GetStatusMessage;

export interface ProgressMessage {
  type: 'progress';
  progress: SyncProgress;
}

export interface SyncResultMessage {
  type: 'syncResult';
  result: FullSyncResult;
}

export interface SyncErrorMessage {
  type: 'syncError';
  error: string;
}

export interface StatusMessage {
  type: 'status';
  loggedIn: boolean;
  userId: string | null;
  courseLanguage: string | null;
  // Set when the JWT cookie was present but the profile fetch failed
  // (expired session, network blip, etc.). Distinct from `loggedIn=false`
  // which means "no cookie at all".
  error: string | null;
}

export type SWMessage = ProgressMessage | SyncResultMessage | SyncErrorMessage | StatusMessage;

export interface StartSyncAck {
  accepted: boolean;
}
