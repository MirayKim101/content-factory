import { z } from "zod";
import {
  libraryPageSchema,
  projectSchema,
  type LibraryPage,
  type Project,
} from "~/shared/api/generated/project";
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
  loaded: number;
  total: number;
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
  listProjects?(
    query: ProjectListQuery,
    signal?: AbortSignal,
  ): Promise<LibraryPage>;
  attestSourceAuthorization?(
    request: AttestSourceAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<Project>;
}
export interface AttestSourceAuthorizationRequest {
  projectId: string;
  sourceVersion: number;
  expectedRevision: number;
}
export interface ProjectListQuery {
  q?: string;
  status?: "SOURCE_PENDING" | "SOURCE_READY" | "FAILED_FINAL";
  cursor?: string;
  limit?: number;
}
interface CreateProjectsApiOptions {
  apiBasePath: unknown;
  fetchImplementation?: typeof fetch;
  xmlHttpRequestFactory?: () => XMLHttpRequest;
}

/** Temporary typed adapter until the OpenAPI client is generated in a contract slice. */
export function createProjectsApi({
  apiBasePath,
  fetchImplementation = fetch,
  xmlHttpRequestFactory = () => new XMLHttpRequest(),
}: CreateProjectsApiOptions): ProjectsApi {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async createProject(request) {
      const body = new FormData();
      body.set("name", request.name);
      body.set("file", request.file);
      const payload = await sendProjectUpload({
        url: `${basePath}/projects`,
        body,
        idempotencyKey: request.idempotencyKey,
        signal: request.signal,
        onUploadProgress: request.onUploadProgress,
        createRequest: xmlHttpRequestFactory,
      });
      if (!payload.ok) throw toApiError(payload.body, payload.status);
      return projectSchema.parse(payload.body);
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
    async listProjects(query, signal) {
      const params = new URLSearchParams();
      if (query.q) params.set("q", query.q);
      if (query.status) params.set("status", query.status);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      let response: Response;
      try {
        response = await fetchImplementation(
          `${basePath}/projects${params.size ? `?${params}` : ""}`,
          { signal },
        );
      } catch {
        throw new ProjectNetworkError();
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw toApiError(payload, response.status);
      return libraryPageSchema.parse(payload);
    },
    async attestSourceAuthorization(request, signal) {
      let response: Response;
      try {
        response = await fetchImplementation(
          `${basePath}/projects/${request.projectId}/source-authorization`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceVersion: request.sourceVersion,
              expectedRevision: request.expectedRevision,
              declarationVersion: "source-authorization-v1",
              attested: true,
            }),
            signal,
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

interface UploadResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

interface SendProjectUploadOptions {
  url: string;
  body: FormData;
  idempotencyKey: string;
  signal?: AbortSignal;
  onUploadProgress?: (progress: UploadProgress) => void;
  createRequest: () => XMLHttpRequest;
}

function sendProjectUpload({
  url,
  body,
  idempotencyKey,
  signal,
  onUploadProgress,
  createRequest,
}: SendProjectUploadOptions): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const request = createRequest();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => request.abort();
    request.open("POST", url);
    request.setRequestHeader("Idempotency-Key", idempotencyKey);
    request.upload.onprogress = (event: ProgressEvent) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onUploadProgress?.({
        loaded: Math.min(Math.max(0, event.loaded), event.total),
        total: event.total,
      });
    };
    request.onerror = () => finish(() => reject(new ProjectNetworkError()));
    request.onabort = () => finish(() => reject(new ProjectNetworkError()));
    request.onload = () => {
      let responseBody: unknown;
      try {
        responseBody = request.responseText
          ? (JSON.parse(request.responseText) as unknown)
          : undefined;
      } catch {
        responseBody = undefined;
      }
      finish(() =>
        resolve({
          ok: request.status >= 200 && request.status < 300,
          status: request.status,
          body: responseBody,
        }),
      );
    };
    if (signal?.aborted) {
      request.abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.send(body);
  });
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
    SOURCE_VERSION_CONFLICT: "Версия исходника изменилась. Обнови медиатеку.",
    SOURCE_AUTHORIZATION_CONFLICT: "Решение уже изменилось. Обнови медиатеку.",
    SOURCE_NOT_READY: "Исходник ещё не готов к подтверждению.",
  };
  return new ProjectApiError(
    translations[parsedError.data.error.code] ??
      "Сервер не смог обработать запрос. Повтори попытку позже.",
    parsedError.data.error.code,
    status,
  );
}
