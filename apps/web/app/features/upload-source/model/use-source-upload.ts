import { computed, ref, watch } from "vue";
import { useMutation, useQuery } from "@tanstack/vue-query";
import type { Project } from "~/shared/api/generated/project";
import {
  ProjectApiError,
  ProjectNetworkError,
  type ProjectsApi,
} from "~/shared/api/projects";
import {
  type SourceUploadFormDraft,
  validateSourceUploadForm,
} from "./source-upload-form";
import {
  clearActiveAttempt,
  saveActiveAttempt,
  type ActiveAttempt,
} from "./active-attempt-storage";

type SubmissionState = "idle" | "sending" | "pending" | "success" | "error";
function newIdempotencyKey(): string {
  return `web-upload-${crypto.randomUUID()}`;
}
export function useSourceUpload(api: ProjectsApi) {
  const draft = ref<SourceUploadFormDraft>({
    name: "",
    rightsConfirmed: false,
    file: null,
  });
  const errors = ref<Record<string, string>>({});
  const phase = ref<"idle" | "pending">("idle");
  const activeProjectId = ref<string | null>(null);
  const idempotencyKey = ref<string | null>(null);
  let attemptVersion = 0;
  const mutation = useMutation({
    mutationFn: (request: Parameters<ProjectsApi["createProject"]>[0]) =>
      api.createProject(request),
    retry: false,
  });
  const poll = useQuery({
    queryKey: ["project-status", activeProjectId],
    queryFn: () => api.getProject!(activeProjectId.value!),
    enabled: computed(
      () => phase.value === "pending" && activeProjectId.value !== null,
    ),
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const result = computed<Project | null>(
    () => poll.data.value ?? mutation.data.value ?? null,
  );
  const requestError = computed<string | null>(() =>
    mutation.error.value
      ? toUserMessage(mutation.error.value)
      : phase.value === "pending" && poll.error.value
        ? toUserMessage(poll.error.value)
        : result.value?.status === "FAILED_FINAL"
          ? "Сервер завершил загрузку с ошибкой."
          : null,
  );
  const state = computed<SubmissionState>(() =>
    mutation.isPending.value
      ? "sending"
      : phase.value === "pending"
        ? "pending"
        : requestError.value
          ? "error"
          : result.value?.status === "SOURCE_READY"
            ? "success"
            : "idle",
  );
  const isSubmitting = computed(
    () => mutation.isPending.value || phase.value === "pending",
  );
  const isSending = computed(() => mutation.isPending.value);
  const isFinalizing = computed(
    () => phase.value === "pending" && !poll.error.value,
  );
  const pollError = computed(() =>
    phase.value === "pending" && poll.error.value
      ? toUserMessage(poll.error.value)
      : null,
  );
  function invalidateAttempt(): void {
    attemptVersion += 1;
    idempotencyKey.value = null;
    activeProjectId.value = null;
    phase.value = "idle";
    mutation.reset();
    if (import.meta.client) clearActiveAttempt();
  }
  function updateDraft(next: Partial<SourceUploadFormDraft>): void {
    draft.value = { ...draft.value, ...next };
    invalidateAttempt();
  }
  async function submit(): Promise<void> {
    if (isSubmitting.value) return;
    const validated = validateSourceUploadForm(draft.value);
    if (!validated.success) {
      errors.value = validated.errors;
      return;
    }
    errors.value = {};
    const version = ++attemptVersion;
    const key = idempotencyKey.value ?? newIdempotencyKey();
    idempotencyKey.value = key;
    if (import.meta.client)
      saveActiveAttempt({
        idempotencyKey: key,
        name: validated.data.name,
        fingerprint: {
          size: validated.data.file.size,
          lastModified: validated.data.file.lastModified,
          type: validated.data.file.type,
        },
        status: "SENDING",
      });
    try {
      const project = await mutation.mutateAsync({
        ...validated.data,
        idempotencyKey: key,
      });
      if (version !== attemptVersion) return;
      if (project.status === "FAILED_FINAL") {
        if (import.meta.client) clearActiveAttempt();
        idempotencyKey.value = null;
        return;
      }
      if (project.status === "SOURCE_PENDING") {
        if (import.meta.client)
          saveActiveAttempt({
            idempotencyKey: key,
            projectId: project.id,
            name: project.name,
            fingerprint: {
              size: validated.data.file.size,
              lastModified: validated.data.file.lastModified,
              type: validated.data.file.type,
            },
            status: "SOURCE_PENDING",
          });
        activeProjectId.value = project.id;
        phase.value = "pending";
        return;
      }
      if (import.meta.client) clearActiveAttempt();
      phase.value = "idle";
    } catch (error: unknown) {
      if (version !== attemptVersion) return;
      void error;
    }
  }
  watch(poll.data, (project) => {
    if (!project || phase.value !== "pending") return;
    if (project.status !== "SOURCE_PENDING") {
      phase.value = "idle";
      if (project.status === "SOURCE_READY" && import.meta.client)
        clearActiveAttempt();
      if (project.status === "FAILED_FINAL" && import.meta.client) {
        clearActiveAttempt();
        idempotencyKey.value = null;
      }
    }
  });
  function recoverAttempt(active: ActiveAttempt): void {
    if (
      !api.getProject ||
      !active.projectId ||
      mutation.isPending.value ||
      phase.value === "pending"
    )
      return;
    attemptVersion += 1;
    idempotencyKey.value = active.idempotencyKey;
    draft.value = { ...draft.value, name: active.name };
    activeProjectId.value = active.projectId;
    phase.value = "pending";
  }
  function prepareRecoveredRetry(active: ActiveAttempt, file: File): boolean {
    if (
      active.status !== "SENDING" ||
      active.fingerprint.size !== file.size ||
      active.fingerprint.lastModified !== file.lastModified ||
      active.fingerprint.type !== file.type
    )
      return false;
    attemptVersion += 1;
    idempotencyKey.value = active.idempotencyKey;
    // A stored attempt is written only after the original form passed this
    // confirmation. Reconstruct it so the explicit same-key retry cannot be
    // blocked by an unrelated, empty form after a page reload.
    draft.value = {
      ...draft.value,
      name: active.name,
      rightsConfirmed: true,
      file,
    };
    return true;
  }
  function startNewAttempt(): void {
    invalidateAttempt();
    errors.value = {};
  }
  function retryPoll(): void {
    if (phase.value === "pending") void poll.refetch();
  }
  return {
    draft,
    errors,
    state,
    result,
    requestError,
    isSubmitting,
    isSending,
    isFinalizing,
    pollError,
    updateDraft,
    submit,
    recoverAttempt,
    startNewAttempt,
    prepareRecoveredRetry,
    retryPoll,
  };
}
function toUserMessage(error: unknown): string {
  if (error instanceof ProjectNetworkError)
    return "Сеть не ответила. Мы не знаем, дошла ли загрузка до сервера: нажми «Повторить» — будет использован тот же ключ попытки.";
  if (error instanceof ProjectApiError) return error.message;
  return "Не удалось обработать ответ. Попробуй повторить загрузку.";
}
