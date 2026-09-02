import { reactive } from "vue";

import {
  emptySegment,
  formatTimecode,
  type CutSubmissionSummary,
  type SegmentDraft,
} from "./segments";

export interface WorkspaceSourceState {
  drafts: SegmentDraft[];
  activeSegment: number;
  submitted: boolean;
  submitting: boolean;
  jobs: string[];
  error?: string;
  retryIdentity?: CutRequestIdentity;
  confirmation?: CutSubmissionSummary;
}

export interface CutRequestIdentity {
  fingerprint: string;
  key: string;
}

const sessionSourceStates = reactive<Record<string, WorkspaceSourceState>>({});

export function createWorkspaceSourceState(): WorkspaceSourceState {
  return {
    drafts: [emptySegment()],
    activeSegment: 0,
    submitted: false,
    submitting: false,
    jobs: [],
  };
}

/** Keeps unsent drafts only for the current browser session across route changes. */
export function getSessionSourceState(id: string): WorkspaceSourceState {
  return (sessionSourceStates[id] ??= createWorkspaceSourceState());
}

export function cutRequestFingerprint(
  segments: Array<{ clientSegmentId: string; startMs: number; endMs: number }>,
): string {
  return JSON.stringify(segments);
}

export function idempotencyForCutRequest(
  previous: CutRequestIdentity | undefined,
  fingerprint: string,
  createKey: () => string,
): CutRequestIdentity {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, key: createKey() };
}

export function markerTimecode(seconds: number): string {
  return formatTimecode(Math.round(Math.max(0, seconds) * 1_000));
}

export function nextActiveProjectId(
  ids: string[],
  active?: string,
): string | undefined {
  return active && ids.includes(active) ? active : ids[0];
}

export function firstReadyProjectId(
  rows: Array<{ id: string; status?: string }>,
  active?: string,
): string | undefined {
  return rows.find((row) => row.id === active && row.status === "SOURCE_READY")
    ? active
    : rows.find((row) => row.status === "SOURCE_READY")?.id;
}
