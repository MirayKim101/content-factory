export const REFERENCE_IMAGE_INSPECTOR = Symbol("REFERENCE_IMAGE_INSPECTOR");

export type ReferenceImageContentType =
  "image/jpeg" | "image/png" | "image/webp";

export interface ReferenceImageInspector {
  inspect(
    bytes: Buffer,
    declaredContentType: string,
  ): { contentType: ReferenceImageContentType; width: number; height: number };
}
