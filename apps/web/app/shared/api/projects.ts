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
}
interface CreateProjectsApiOptions {
  apiBasePath: unknown;
  fetchImplementation?: typeof fetch;
}

/** Temporary typed adapter until the OpenAPI client is generated in a contract slice. */
export function createProjectsApi({
  apiBasePath,
  fetchImplementation = fetch,
}: CreateProjectsApiOptions): ProjectsApi {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async createProject(request) {
      const body = new FormData();
      body.set("name", request.name);
      body.set("rightsConfirmed", "true");
      body.set("file", request.file);
      let response: Response;
      try {
        response = await fetchImplementation(`${basePath}/projects`, {
          method: "POST",
          body,
          signal: request.signal,
          headers: { "Idempotency-Key": request.idempotencyKey },
        });
      } catch {
        throw new ProjectNetworkError();
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw toApiError(payload, response.status);
      return projectSchema.parse(payload);
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
  };
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
  };
  return new ProjectApiError(
    translations[parsedError.data.error.code] ??
      "Сервер не смог обработать запрос. Повтори попытку позже.",
    parsedError.data.error.code,
    status,
  );
}
