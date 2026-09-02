import { describe, expect, it } from "vitest";

import {
  normalizeProjectIds,
  projectIdsFromReturnTo,
  mergeProjectSelections,
  toggleProjectSelection,
} from "~/features/select-library-sources/model/selection";
import {
  cutRequestFingerprint,
  createWorkspaceSourceState,
  firstReadyProjectId,
  idempotencyForCutRequest,
  getSessionSourceState,
  markerTimecode,
  nextActiveProjectId,
} from "~/features/edit-cut-segments/model/workspace-state";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

describe("media library selection and horizontal workspace state", () => {
  it("normalizes a shareable query without letting invalid IDs block ready sources", () => {
    expect(
      normalizeProjectIds(`${first},not-a-uuid,${first},${second}`),
    ).toEqual({
      ids: [first, second],
      removed: true,
    });
  });

  it("keeps selection order and toggles only the selected source", () => {
    const selected = toggleProjectSelection([first], second);
    expect(selected).toEqual([first, second]);
    expect(toggleProjectSelection(selected, first)).toEqual([second]);
  });

  it("keeps drafts isolated by source instead of sharing timecodes", () => {
    const sourceA = createWorkspaceSourceState();
    const sourceB = createWorkspaceSourceState();
    sourceA.drafts[0]!.startText = "00:00:03.500";
    sourceA.drafts.push({
      clientKey: "extra",
      startText: "00:00:08",
      endText: "00:00:10",
    });
    expect(sourceB.drafts).toEqual([
      { clientKey: sourceB.drafts[0]!.clientKey, startText: "", endText: "" },
    ]);
    expect(sourceA.drafts).toHaveLength(2);
  });

  it("keeps one active player source and converts its marker exactly", () => {
    expect(nextActiveProjectId([first, second])).toBe(first);
    expect(nextActiveProjectId([first, second], second)).toBe(second);
    expect(nextActiveProjectId([first], second)).toBe(first);
    expect(markerTimecode(12.3456)).toBe("00:00:12.346");
  });

  it("retains the same idempotency key after an unknown network outcome", () => {
    const firstBody = [{ clientSegmentId: first, startMs: 100, endMs: 200 }];
    const firstIdentity = idempotencyForCutRequest(
      undefined,
      cutRequestFingerprint(firstBody),
      () => "cuts-first",
    );
    const retry = idempotencyForCutRequest(
      firstIdentity,
      cutRequestFingerprint(firstBody),
      () => "must-not-be-used",
    );
    const changed = idempotencyForCutRequest(
      retry,
      cutRequestFingerprint([{ ...firstBody[0]!, endMs: 300 }]),
      () => "cuts-changed",
    );
    expect(retry.key).toBe("cuts-first");
    expect(changed.key).toBe("cuts-changed");
  });

  it("returns from the library with existing project IDs merged and session drafts intact", () => {
    const returned = projectIdsFromReturnTo(
      `/horizontal?projectIds=${first},${second}`,
    );
    expect(mergeProjectSelections(returned, [second])).toEqual([first, second]);
    const stored = getSessionSourceState(first);
    stored.drafts[0]!.startText = "00:00:11";
    expect(getSessionSourceState(first).drafts[0]!.startText).toBe("00:00:11");
  });

  it("activates cached READY detail immediately when the first ID is unavailable", () => {
    expect(
      firstReadyProjectId(
        [
          { id: first, status: "SOURCE_PENDING" },
          { id: second, status: "SOURCE_READY" },
        ],
        first,
      ),
    ).toBe(second);
  });
});
