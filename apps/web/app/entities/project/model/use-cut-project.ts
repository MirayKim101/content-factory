import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";

import { createProjectsApi } from "~/shared/api/projects";

export function useCutProject(projectId: Ref<string | undefined>) {
  const config = useRuntimeConfig();
  const api = createProjectsApi({ apiBasePath: config.public.apiBasePath });
  return useQuery({
    queryKey: computed(() => ["project", projectId.value]),
    enabled: computed(() => Boolean(projectId.value)),
    queryFn: () => api.getProject!(projectId.value!),
    refetchInterval: (query) => {
      const project = query.state.data;
      return project?.source.durationMs !== undefined ||
        project?.source.probeState === "FAILED_FINAL"
        ? false
        : 3_000;
    },
  });
}
