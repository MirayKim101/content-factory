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
  sourceIdentity?: string;
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

export function reconcileWorkspaceSource(
  state: WorkspaceSourceState,
  sourceId: string,
  sourceVersion: number,
): boolean {
  const identity = `${sourceId}:${sourceVersion}`;
  const changed =
    state.sourceIdentity !== undefined && state.sourceIdentity !== identity;
  if (changed) {
    state.drafts = [emptySegment()];
    state.activeSegment = 0;
    state.submitted = false;
    state.submitting = false;
    state.jobs = [];
    state.error = undefined;
    state.retryIdentity = undefined;
    state.confirmation = undefined;
  }
  state.sourceIdentity = identity;
  return changed;
}

export function isCurrentWorkspaceSource(
  state: WorkspaceSourceState,
  identity: string | undefined,
): boolean {
  return identity !== undefined && state.sourceIdentity === identity;
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
