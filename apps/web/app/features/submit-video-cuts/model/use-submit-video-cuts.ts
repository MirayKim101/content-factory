import { useMutation } from "@tanstack/vue-query";

import { createMediaPipelineApi } from "~/shared/api/media-pipeline";

export function useSubmitVideoCuts() {
  const config = useRuntimeConfig();
  const api = createMediaPipelineApi(config.public.apiBasePath);
  return useMutation({
    mutationFn: (input: {
      projectId: string;
      idempotencyKey: string;
      segments: Array<{
        clientSegmentId: string;
        startMs: number;
        endMs: number;
      }>;
    }) => api.createCuts(input),
  });
}
