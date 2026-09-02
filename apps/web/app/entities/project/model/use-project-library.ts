import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";

import {
  createProjectsApi,
  type ProjectListQuery,
} from "~/shared/api/projects";

export function useProjectLibrary(query: Ref<ProjectListQuery>) {
  const config = useRuntimeConfig();
  const api = createProjectsApi({ apiBasePath: config.public.apiBasePath });
  return useQuery({
    queryKey: computed(() => ["project-library", query.value]),
    queryFn: () => api.listProjects!(query.value),
  });
}
