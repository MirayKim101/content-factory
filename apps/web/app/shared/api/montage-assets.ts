import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type MontageAsset = components["schemas"]["MontageAssetDto"];
export type MontageAssetKind = MontageAsset["kind"];

const montageKindSchema = z.enum(["ADVERTISEMENT", "INTRO", "OUTRO", "BANNER"]);
const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
const probeSchema = z.object({
  attempt: z.number().int().nonnegative(),
  retryBudget: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  state: z.enum([
    "QUEUED",
    "PROCESSING",
    "RETRY_WAIT",
    "READY",
    "FAILED_FINAL",
  ]),
  failure: failureSchema.nullable(),
});
const montageAssetSchema: z.ZodType<MontageAsset> = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid(),
  sourceVersion: z.number().int().positive(),
  kind: montageKindSchema,
  status: z.enum(["UPLOADING", "PROBE_PENDING", "READY", "FAILED_FINAL"]),
  revision: z.number().int().positive(),
  originalFilename: z.string(),
  contentType: z.enum(["video/mp4", "image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  hasAudio: z.boolean().nullable(),
  probeJobId: z.uuid().nullable(),
  probe: probeSchema.nullable(),
  failure: failureSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const montageAssetListSchema = z.object({
  items: z.array(montageAssetSchema),
  nextCursor: z.string().nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface MontageUploadProgress {
  loaded: number;
  total: number;
}

export interface UploadMontageAssetRequest {
  projectId: string;
  kind: MontageAssetKind;
  file: File;
  idempotencyKey: string;
  signal?: AbortSignal;
  onUploadProgress?: (progress: MontageUploadProgress) => void;
}

export class MontageAssetsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MontageAssetsApiError";
  }
}

export class MontageAssetsNetworkError extends Error {
  constructor() {
    super(
      "Не удалось связаться с API. Проверьте локальный API и повторите попытку.",
    );
    this.name = "MontageAssetsNetworkError";
  }
}

export class MontageAssetsAbortError extends Error {
  constructor() {
    super("Загрузка отменена.");
    this.name = "MontageAssetsAbortError";
  }
}

interface MontageAssetsApiOptions {
  apiBasePath: unknown;
  fetchImplementation?: typeof fetch;
  xmlHttpRequestFactory?: () => XMLHttpRequest;
}

export function createMontageAssetsApi({
  apiBasePath,
  fetchImplementation = fetch,
  xmlHttpRequestFactory = () => new XMLHttpRequest(),
}: MontageAssetsApiOptions) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async list(
      projectId: string,
      kind?: MontageAssetKind,
    ): Promise<MontageAsset[]> {
      const items: MontageAsset[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ limit: "50" });
        if (kind) params.set("kind", kind);
        if (cursor) params.set("cursor", cursor);
        const payload = await request(
          fetchImplementation,
          `${basePath}/projects/${encodeURIComponent(projectId)}/montage-assets?${params}`,
        );
        const parsed = montageAssetListSchema.parse(payload);
        items.push(...parsed.items);
        if (!parsed.nextCursor) return uniqueAssets(items);
        if (cursors.has(parsed.nextCursor))
          throw new MontageAssetsApiError(
            "PAGINATION_CURSOR_LOOP",
            "Список материалов вернул повторяющийся курсор. Обновите страницу.",
            0,
          );
        cursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
      throw new MontageAssetsApiError(
        "PAGINATION_LIMIT_REACHED",
        "Материалов слишком много для одной безопасной загрузки. Уточните тип материала.",
        0,
      );
    },
    async get(projectId: string, assetId: string): Promise<MontageAsset> {
      return montageAssetSchema.parse(
        await request(
          fetchImplementation,
          `${basePath}/projects/${encodeURIComponent(projectId)}/montage-assets/${encodeURIComponent(assetId)}`,
        ),
      );
    },
    upload(request: UploadMontageAssetRequest): Promise<MontageAsset> {
      const body = new FormData();
      body.set("kind", request.kind);
      body.set("file", request.file);
      return sendUpload({
        url: `${basePath}/projects/${encodeURIComponent(request.projectId)}/montage-assets`,
        body,
        idempotencyKey: request.idempotencyKey,
        signal: request.signal,
        onUploadProgress: request.onUploadProgress,
        createRequest: xmlHttpRequestFactory,
      }).then((response) => {
        if (!response.ok) throw toApiError(response.body, response.status);
        return montageAssetSchema.parse(response.body);
      });
    },
    contentUrl(projectId: string, assetId: string): string {
      return `${basePath}/projects/${encodeURIComponent(projectId)}/montage-assets/${encodeURIComponent(assetId)}/content`;
    },
  };
}

function uniqueAssets(items: MontageAsset[]): MontageAsset[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function request(
  fetchImplementation: typeof fetch,
  url: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url);
  } catch {
    throw new MontageAssetsNetworkError();
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw toApiError(payload, response.status);
  return payload;
}

interface UploadResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function sendUpload(options: {
  url: string;
  body: FormData;
  idempotencyKey: string;
  signal?: AbortSignal;
  onUploadProgress?: (progress: MontageUploadProgress) => void;
  createRequest: () => XMLHttpRequest;
}): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new MontageAssetsAbortError());
      return;
    }
    const request = options.createRequest();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      finish(() => reject(new MontageAssetsAbortError()));
      // Some XHR implementations dispatch `onabort` synchronously. Settle the
      // caller's controlled cancellation before invoking it so that event
      // cannot be misreported as a network failure.
      request.abort();
    };
    request.open("POST", options.url);
    request.setRequestHeader("Idempotency-Key", options.idempotencyKey);
    request.upload.onprogress = (event: ProgressEvent) => {
      if (!event.lengthComputable || event.total <= 0) return;
      options.onUploadProgress?.({
        loaded: Math.min(Math.max(0, event.loaded), event.total),
        total: event.total,
      });
    };
    request.onerror = () =>
      finish(() => reject(new MontageAssetsNetworkError()));
    request.onabort = () =>
      finish(() => reject(new MontageAssetsNetworkError()));
    request.onload = () => {
      let body: unknown;
      try {
        body = request.responseText
          ? (JSON.parse(request.responseText) as unknown)
          : undefined;
      } catch {
        body = undefined;
      }
      finish(() =>
        resolve({
          ok: request.status >= 200 && request.status < 300,
          status: request.status,
          body,
        }),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    request.send(options.body);
  });
}

function toApiError(payload: unknown, status: number): MontageAssetsApiError {
  const parsed = errorSchema.safeParse(payload);
  if (!parsed.success)
    return new MontageAssetsApiError(
      "API_RESPONSE_INVALID",
      "Сервер вернул некорректный ответ. Повторите попытку позже.",
      status,
    );
  const messages: Record<string, string> = {
    FILE_REQUIRED: "Выберите файл.",
    INVALID_MONTAGE_KIND: "Выберите корректный тип монтажного материала.",
    INVALID_MONTAGE_FILE: "Файл не подходит для выбранного типа материала.",
    UPLOAD_TOO_LARGE: "Файл превышает допустимый размер.",
    IDEMPOTENCY_CONFLICT: "Эта попытка загрузки уже связана с другим файлом.",
  };
  return new MontageAssetsApiError(
    parsed.data.error.code,
    messages[parsed.data.error.code] ?? parsed.data.error.message,
    status,
  );
}
