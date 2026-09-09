import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { AiContextAdmissionInterceptor } from "../src/ai-content/presentation/ai-context-admission.interceptor.js";
import type { ReconcileCreatorReferences } from "../src/ai-content/application/reconcile-creator-references.js";
import { CreatorReferenceReconciliationStartup } from "../src/ai-content/infrastructure/creator-reference-reconciliation.startup.js";

describe("AI context admission", () => {
  it("fails closed when the feature is disabled", () => {
    const next = { handle: vi.fn(() => of("called")) } as CallHandler;
    const interceptor = new AiContextAdmissionInterceptor(false);

    expect(() =>
      interceptor.intercept({} as ExecutionContext, next),
    ).toThrowError(HttpException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it("does not alter an admitted request", () => {
    const stream = of("called");
    const next = { handle: vi.fn(() => stream) } as CallHandler;
    const interceptor = new AiContextAdmissionInterceptor(true);

    expect(interceptor.intercept({} as ExecutionContext, next)).toBe(stream);
    expect(next.handle).toHaveBeenCalledOnce();
  });
});

describe("AI context admission-off startup", () => {
  it("does not query Stage 2B tables before the additive migration", async () => {
    const previous = process.env.AI_CONTEXT_ENABLED;
    process.env.AI_CONTEXT_ENABLED = "0";
    const reconcile = { execute: vi.fn() };
    try {
      await new CreatorReferenceReconciliationStartup(
        reconcile as unknown as ReconcileCreatorReferences,
      ).onApplicationBootstrap();
      expect(reconcile.execute).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AI_CONTEXT_ENABLED;
      else process.env.AI_CONTEXT_ENABLED = previous;
    }
  });
});
