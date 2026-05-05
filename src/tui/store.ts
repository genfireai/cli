import { create } from 'zustand';
import type { GenFireClient, Run } from '@genfire/sdk';

export type LogEntryKind = 'system' | 'command' | 'output' | 'error' | 'success' | 'info';

export interface LogEntry {
  id: string;
  kind: LogEntryKind;
  text: string;
  timestamp: number;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  label: string;
  runId?: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  message?: string;
  outputUrls?: string[];
  downloadedPaths?: string[];
}

export interface AccountSnapshot {
  id: string;
  email: string;
  displayName: string;
  plan: string;
  credits: number;
}

export interface TuiState {
  /** Connection / identity */
  client: GenFireClient | null;
  account: AccountSnapshot | null;
  baseUrl: string;
  authSource: 'env' | 'stored' | 'none';

  /** UI */
  log: LogEntry[];
  busy: boolean;
  exitRequested: boolean;
  inputDraft: string;

  /** Background jobs (for v0.3 multi-job mode — already wired up so we don't refactor later) */
  jobs: JobRecord[];

  /** Actions */
  setClient: (client: GenFireClient | null, source: 'env' | 'stored' | 'none', baseUrl: string) => void;
  setAccount: (account: AccountSnapshot | null) => void;
  appendLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLog: () => void;
  setBusy: (busy: boolean) => void;
  setInputDraft: (draft: string) => void;
  requestExit: () => void;

  upsertJob: (job: Partial<JobRecord> & { id: string; label: string; status: JobStatus; startedAt?: number }) => void;
  updateJob: (id: string, patch: Partial<JobRecord>) => void;
  removeJob: (id: string) => void;
}

let logSeq = 0;
function nextLogId(): string {
  logSeq += 1;
  return `log_${Date.now().toString(36)}_${logSeq}`;
}

export const useTuiStore = create<TuiState>((set) => ({
  client: null,
  account: null,
  baseUrl: '',
  authSource: 'none',

  log: [],
  busy: false,
  exitRequested: false,
  inputDraft: '',

  jobs: [],

  setClient: (client, source, baseUrl) =>
    set(() => ({ client, authSource: source, baseUrl })),

  setAccount: (account) => set(() => ({ account })),

  appendLog: (entry) =>
    set((state) => ({
      log: [
        ...state.log,
        {
          id: nextLogId(),
          timestamp: Date.now(),
          kind: entry.kind,
          text: entry.text
        }
      ]
    })),

  clearLog: () => set(() => ({ log: [] })),

  setBusy: (busy) => set(() => ({ busy })),

  setInputDraft: (inputDraft) => set(() => ({ inputDraft })),

  requestExit: () => set(() => ({ exitRequested: true })),

  upsertJob: (job) =>
    set((state) => {
      const existing = state.jobs.find((entry) => entry.id === job.id);
      if (existing) {
        return {
          jobs: state.jobs.map((entry) =>
            entry.id === job.id ? { ...entry, ...job } : entry
          )
        };
      }
      return {
        jobs: [
          ...state.jobs,
          {
            id: job.id,
            label: job.label,
            status: job.status,
            startedAt: job.startedAt ?? Date.now(),
            runId: job.runId,
            message: job.message,
            outputUrls: job.outputUrls,
            downloadedPaths: job.downloadedPaths,
            endedAt: job.endedAt
          }
        ]
      };
    }),

  updateJob: (id, patch) =>
    set((state) => ({
      jobs: state.jobs.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    })),

  removeJob: (id) =>
    set((state) => ({ jobs: state.jobs.filter((entry) => entry.id !== id) }))
}));

export interface AppendLogParams {
  kind: LogEntryKind;
  text: string;
}

export function appendLog(entry: AppendLogParams): void {
  useTuiStore.getState().appendLog(entry);
}
