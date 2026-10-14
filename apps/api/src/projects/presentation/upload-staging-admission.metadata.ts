import { SetMetadata } from "@nestjs/common";

export const UPLOAD_STAGING_MAX_BYTES = "upload-staging-max-bytes";

export const UploadStagingAdmission = (maximumBytes: number) =>
  SetMetadata(UPLOAD_STAGING_MAX_BYTES, maximumBytes);
