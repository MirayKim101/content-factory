import { z } from "zod";
import { projectSchema, type Project } from "~/shared/api/generated/project";
import { parseApiBasePath } from "~/shared/config/api-config";

const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface CreateProjectRequest {
  name: string;
  file: File;
  idempotencyKey: string;
  signal?: AbortSignal;
  onUploadProgress?: (progress: UploadProgress) => void;
}
export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  transferCompleted: boolean;
}
export class ProjectApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}
export class ProjectNetworkError extends Error {
  constructor() {
    super("Не удалось связаться с API. Проверь, что локальный API запущен.");
    this.name = "ProjectNetworkError";
  }
}
export interface ProjectsApi {
  createProject(request: CreateProjectRequest): Promise<Project>;
  getProject?(id: string, signal?: AbortSignal): Promise<Project>;
  confirmSourceAuthorization?(
    projectId: string,
    request: {
      sourceVersion: number;
      sourceSha256: string;
      rightsConfirmed: true;
      declarationVersion: string;
    },
  ): Promise<Project>;
}
interface CreateProjectsApiOptions {
  apiBasePath: unknown;
  fetchImplementation?: typeof fetch;
  xhrFactory?: () => XMLHttpRequest;
}

/** Temporary typed adapter until the OpenAPI client is generated in a contract slice. */
export function createProjectsApi({
  apiBasePath,
  fetchImplementation = fetch,
  xhrFactory = () => new XMLHttpRequest(),
}: CreateProjectsApiOptions): ProjectsApi {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    createProject(request) {
      return uploadProject({
        basePath,
        request,
        xhrFactory,
      });
    },
    async getProject(id, signal) {
      let response: Response;
      try {
        response = await fetchImplementation(`${basePath}/projects/${id}`, {
          signal,
        });
      } catch {
        throw new ProjectNetworkError();
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw toApiError(payload, response.status);
      return projectSchema.parse(payload);
    },
    async confirmSourceAuthorization(projectId, request) {
      let response: Response;
      try {
        response = await fetchImplementation(
          `${basePath}/projects/${projectId}/source/authorization`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          },
        );
      } catch {
        throw new ProjectNetworkError();
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw toApiError(payload, response.status);
      return projectSchema.parse(payload);
    },
  };
}

interface UploadProjectOptions {
  basePath: string;
  request: CreateProjectRequest;
  xhrFactory: () => XMLHttpRequest;
}

/**
 * XHR is intentionally contained here: Fetch does not expose upload progress.
 * The API surface remains typed so feature and widget code never handles a
 * transport event directly.
 */
function uploadProject({
  basePath,
  request,
  xhrFactory,
}: UploadProjectOptions): Promise<Project> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.set("name", request.name);
    body.set("file", request.file);
    const xhr = xhrFactory();
    const startedAt = performance.now();
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => {
      xhr.abort();
      settle(() => reject(new ProjectNetworkError()));
    };
    const reportProgress = (
      event: ProgressEvent<EventTarget>,
      transferCompleted: boolean,
    ): void => {
      const elapsedSeconds = Math.max(
        (performance.now() - startedAt) / 1000,
        0,
      );
      const bytesPerSecond =
        elapsedSeconds > 0 ? event.loaded / elapsedSeconds : null;
      const totalBytes = event.lengthComputable ? event.total : null;
      const percent =
        totalBytes && totalBytes > 0 ? (event.loaded / totalBytes) * 100 : null;
      const etaSeconds =
        totalBytes && bytesPerSecond && bytesPerSecond > 0
          ? Math.max((totalBytes - event.loaded) / bytesPerSecond, 0)
          : null;
      request.onUploadProgress?.({
        uploadedBytes: event.loaded,
        totalBytes,
        percent,
        bytesPerSecond,
        etaSeconds: transferCompleted ? 0 : etaSeconds,
        transferCompleted,
      });
    };
    xhr.upload.onprogress = (event) => reportProgress(event, false);
    xhr.upload.onload = (event) => reportProgress(event, true);
    xhr.onerror = () => settle(() => reject(new ProjectNetworkError()));
    xhr.onabort = () => settle(() => reject(new ProjectNetworkError()));
    xhr.onload = () => {
      const payload: unknown = parseJson(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        settle(() => reject(toApiError(payload, xhr.status)));
        return;
      }
      try {
        const project = projectSchema.parse(payload);
        settle(() => resolve(project));
      } catch {
        settle(() =>
          reject(
            new ProjectApiError(
              "Сервер вернул некорректный ответ. Повтори попытку позже.",
              "API_RESPONSE_INVALID",
              xhr.status,
            ),
          ),
        );
      }
    };
    if (request.signal?.aborted) {
      abort();
      return;
    }
    request.signal?.addEventListener("abort", abort, { once: true });
    xhr.open("POST", `${basePath}/projects`);
    xhr.setRequestHeader("Idempotency-Key", request.idempotencyKey);
    xhr.send(body);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toApiError(payload: unknown, status: number): ProjectApiError {
  const parsedError = errorResponseSchema.safeParse(payload);
  if (!parsedError.success)
    return new ProjectApiError(
      "Сервер вернул некорректный ответ. Повтори попытку позже.",
      "API_RESPONSE_INVALID",
      status,
    );
  const translations: Record<string, string> = {
    INVALID_MP4: "Выбранный файл не является корректным MP4.",
    UPLOAD_TOO_LARGE: "Файл превышает допустимый размер.",
    FILE_REQUIRED: "Выбери MP4-файл.",
    IDEMPOTENCY_CONFLICT: "Этот ключ загрузки уже связан с другим файлом.",
    VALIDATION_FAILED: "Проверь заполнение формы.",
    STORAGE_UPLOAD_FAILED: "Хранилище временно недоступно.",
    SOURCE_NOT_READY: "Исходник ещё не готов. Дождись завершения загрузки.",
    SOURCE_VERSION_MISMATCH:
      "Версия исходника изменилась. Обнови данные проекта и повтори проверку.",
    RIGHTS_DECLARATION_OUTDATED:
      "Текст подтверждения обновился. Перезагрузи страницу и прочитай его снова.",
    SOURCE_AUTHORIZATION_CONFLICT:
      "Права уже подтверждены с другими данными. Обнови проект.",
  };
  return new ProjectApiError(
    translations[parsedError.data.error.code] ??
      "Сервер не смог обработать запрос. Повтори попытку позже.",
    parsedError.data.error.code,
    status,
  );
}
