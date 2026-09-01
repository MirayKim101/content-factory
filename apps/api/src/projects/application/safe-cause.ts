export interface SafeCause {
  classification: string;
  code?: string;
  httpStatus?: number;
  providerRequestId?: string;
  providerExtendedRequestId?: string;
  stackFrames?: string[];
}

export function safeCause(error: unknown): SafeCause {
  if (!(error instanceof Error)) return { classification: "UnknownError" };
  const candidate = error as Error & {
    code?: unknown;
    requestId?: unknown;
    $metadata?: {
      httpStatusCode?: unknown;
      requestId?: unknown;
      extendedRequestId?: unknown;
      cfId?: unknown;
    };
  };
  const code = safeIdentifier(candidate.code, 80);
  const status = candidate.$metadata?.httpStatusCode;
  const providerRequestId = safeProviderId(
    candidate.$metadata?.requestId ?? candidate.requestId,
  );
  const providerExtendedRequestId = safeProviderId(
    candidate.$metadata?.extendedRequestId ?? candidate.$metadata?.cfId,
  );
  const stackFrames = sanitizeStack(candidate.stack);
  return {
    classification:
      candidate.name.replaceAll(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error",
    ...(code ? { code } : {}),
    ...(typeof status === "number" ? { httpStatus: status } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerExtendedRequestId ? { providerExtendedRequestId } : {}),
    ...(stackFrames.length > 0 ? { stackFrames } : {}),
  };
}

function safeIdentifier(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === "string" &&
    new RegExp(`^[A-Za-z0-9_.-]{1,${maximumLength}}$`).test(value)
    ? value
    : undefined;
}

function safeProviderId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:/+=-]{1,200}$/.test(value)
    ? value
    : undefined;
}

function sanitizeStack(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const location = line.match(
      /(?:^|[/\\])([A-Za-z0-9_.-]+\.(?:[cm]?[jt]s)):(\d+):(\d+)\)?$/,
    );
    if (!location) continue;
    const functionName = line.match(
      /^\s*at\s+([A-Za-z0-9_.$<>[\]-]{1,100})/,
    )?.[1];
    frames.push(
      `at ${functionName ?? "anonymous"} (${location[1]}:${location[2]}:${location[3]})`,
    );
    if (frames.length === 5) break;
  }
  return frames;
}
