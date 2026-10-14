import "reflect-metadata";
import {
  INTERCEPTORS_METADATA,
  MODULE_METADATA,
} from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { AiContentModule } from "../src/ai-content/ai-content.module.js";
import { CreatorContextController } from "../src/ai-content/presentation/creator-context.controller.js";
import { CREATOR_REFERENCE_MAX_BYTES } from "../src/ai-content/application/creator-context.service.js";
import { EditorialContentModule } from "../src/editorial-content/editorial-content.module.js";
import { EditorialController } from "../src/editorial-content/presentation/editorial.controller.js";
import { EDITORIAL_THUMBNAIL_UPLOAD_MAX_BYTES } from "../src/editorial-content/presentation/editorial-upload-options.js";
import { MontageController } from "../src/editorial-content/presentation/montage.controller.js";
import { MONTAGE_MAX_BYTES } from "../src/editorial-content/domain/montage-asset.js";
import { ProjectsModule } from "../src/projects/projects.module.js";
import { ProjectsController } from "../src/projects/presentation/projects.controller.js";
import { TempUploadLifecycleInterceptor } from "../src/projects/presentation/temp-upload-lifecycle.interceptor.js";
import { UPLOAD_STAGING_MAX_BYTES } from "../src/projects/presentation/upload-staging-admission.metadata.js";
import { UploadStagingAdmissionService } from "../src/projects/presentation/upload-staging-admission.service.js";
import { SOURCE_UPLOAD_MAX_BYTES } from "../src/projects/presentation/upload-options.js";

// Import the production module graph only from a closed ADR-011 fixture: the
// protected pending application/repository files must not be read by the agent.
describe("production upload staging wiring", () => {
  it("provides and exports one shared lifecycle and capacity ledger", () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ProjectsModule,
    );
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      ProjectsModule,
    );
    for (const token of [
      UploadStagingAdmissionService,
      TempUploadLifecycleInterceptor,
    ]) {
      expect(providers.filter((provider) => provider === token)).toHaveLength(
        1,
      );
      expect(exports).toContain(token);
      for (const module of [EditorialContentModule, AiContentModule]) {
        const imports: unknown[] = Reflect.getMetadata(
          MODULE_METADATA.IMPORTS,
          module,
        );
        const localProviders: unknown[] = Reflect.getMetadata(
          MODULE_METADATA.PROVIDERS,
          module,
        );
        expect(imports).toContain(ProjectsModule);
        expect(localProviders).not.toContain(token);
        expect(
          localProviders.some(
            (provider) =>
              typeof provider === "object" &&
              provider !== null &&
              "provide" in provider &&
              provider.provide === token,
          ),
        ).toBe(false);
      }
    }
  });

  it.each([
    ["source", ProjectsController.prototype.create, SOURCE_UPLOAD_MAX_BYTES],
    ["montage", MontageController.prototype.create, MONTAGE_MAX_BYTES],
    [
      "thumbnail",
      EditorialController.prototype.createThumbnail,
      EDITORIAL_THUMBNAIL_UPLOAD_MAX_BYTES,
    ],
    [
      "reference",
      CreatorContextController.prototype.uploadReference,
      CREATOR_REFERENCE_MAX_BYTES,
    ],
  ] as const)(
    "places %s admission before its Multer interceptor with the exact maximum",
    (_name, handler, maximum) => {
      expect(Reflect.getMetadata(UPLOAD_STAGING_MAX_BYTES, handler)).toBe(
        maximum,
      );
      const interceptors: unknown[] = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        handler,
      );
      const lifecycle = interceptors.indexOf(TempUploadLifecycleInterceptor);
      expect(lifecycle).toBeGreaterThanOrEqual(0);
      // FileInterceptor's generated class is intentionally opaque; the final
      // interceptor position is what guarantees reservation before parsing.
      expect(lifecycle).toBe(interceptors.length - 2);
    },
  );
});
