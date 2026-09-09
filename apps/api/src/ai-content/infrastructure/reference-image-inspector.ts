import { Injectable } from "@nestjs/common";

import {
  inspectThumbnail,
  ThumbnailValidationError,
} from "../../editorial-content/domain/editorial.js";
import { CreatorContextError } from "../domain/creator-context.js";
import type { ReferenceImageInspector } from "../application/reference-image-inspector.port.js";

@Injectable()
export class StructuralReferenceImageInspector implements ReferenceImageInspector {
  inspect(bytes: Buffer, declaredContentType: string) {
    try {
      return inspectThumbnail(bytes, declaredContentType);
    } catch (error) {
      if (!(error instanceof ThumbnailValidationError)) throw error;
      const code = error.code.replace("THUMBNAIL_", "CREATOR_REFERENCE_");
      throw new CreatorContextError(
        code,
        error.message.replaceAll("Thumbnail", "Reference image"),
        error.code === "THUMBNAIL_CORRUPT" ||
          error.code === "THUMBNAIL_PIXEL_LIMIT_EXCEEDED"
          ? 422
          : 415,
      );
    }
  }
}
