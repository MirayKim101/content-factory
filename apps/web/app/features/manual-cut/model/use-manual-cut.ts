import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

import { ProjectApiError, ProjectNetworkError } from "~/shared/api/projects";
import type { CutsApi } from "~/shared/api/cuts";
import { formatTimecode, parseTimecode } from "./timecode";

export class CutIntentKeys {
  private pending: { signature: string; key: string } | null = null;

  constructor(
    private readonly createKey = () => `web-cut-${crypto.randomUUID()}`,
  ) {}

  forRange(startMs: number, endMs: number): string {
    const signature = `${startMs}:${endMs}`;
    if (this.pending?.signature === signature) return this.pending.key;
    const key = this.createKey();
    this.pending = { signature, key };
    return key;
  }

  clear(): void {
    this.pending = null;
  }
}

export function useManualCut(projectId: string, api: CutsApi) {
  const start = ref("00:00:00.000");
  const end = ref("00:00:01.000");
  const formError = ref<string | null>(null);
  const queryClient = useQueryClient();
  const intentKeys = new CutIntentKeys();
  const jobs = useQuery({
    queryKey: ["cut-jobs", projectId],
    queryFn: ({ signal }) => api.list(projectId, signal),
    refetchInterval: 1_000,
    retry: false,
  });
  const create = useMutation({
    mutationFn: (range: {
      startMs: number;
      endMs: number;
      idempotencyKey: string;
    }) => api.create(projectId, range),
    onSuccess: () => {
      intentKeys.clear();
      return queryClient.invalidateQueries({
        queryKey: ["cut-jobs", projectId],
      });
    },
  });

  async function submit(): Promise<void> {
    const startMs = parseTimecode(start.value);
    const endMs = parseTimecode(end.value);
    if (startMs === null || endMs === null || startMs >= endMs) {
      formError.value = "Проверь таймкоды: начало должно быть раньше конца.";
      return;
    }
    formError.value = null;
    await create
      .mutateAsync({
        startMs,
        endMs,
        idempotencyKey: intentKeys.forRange(startMs, endMs),
      })
      .catch((error: unknown) => {
        if (error instanceof ProjectApiError && error.status < 500)
          intentKeys.clear();
      });
  }

  function setFromPlayer(side: "start" | "end", currentTime: number): void {
    const milliseconds = Math.round(currentTime * 1_000);
    if (side === "start") start.value = formatTimecode(milliseconds);
    else end.value = formatTimecode(milliseconds);
    formError.value = null;
  }

  const requestError = computed(() => {
    const error = create.error.value ?? jobs.error.value;
    if (error instanceof ProjectApiError) return error.message;
    if (error instanceof ProjectNetworkError) return error.message;
    return error ? "Не удалось обновить задания нарезки." : null;
  });

  return {
    start,
    end,
    formError,
    jobs,
    create,
    submit,
    setFromPlayer,
    requestError,
  };
}
