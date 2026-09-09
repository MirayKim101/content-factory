import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";

import { createMontageAssetsApi } from "~/shared/api/montage-assets";

export function useMontageAssets(projectId: Ref<string | undefined>) {
  const config = useRuntimeConfig();
  const api = createMontageAssetsApi({
    apiBasePath: config.public.apiBasePath,
  });
  return useQuery({
    queryKey: computed(() => ["montage-assets", projectId.value]),
    queryFn: () => api.list(projectId.value!),
    enabled: computed(() => Boolean(projectId.value)),
    retry: 1,
    refetchInterval: (query) => {
      const assets = query.state.data ?? [];
      return assets.some(
        (asset) =>
          asset.status === "UPLOADING" || asset.status === "PROBE_PENDING",
      )
        ? 1500
        : false;
    },
    refetchIntervalInBackground: false,
  });
}
