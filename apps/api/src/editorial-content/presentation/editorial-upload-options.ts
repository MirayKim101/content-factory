import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface.js";

import { THUMBNAIL_MAX_BYTES } from "../domain/editorial.js";
import { SecureDiskStorage } from "../../projects/presentation/secure-disk-storage.js";

export const EDITORIAL_THUMBNAIL_UPLOAD_MAX_BYTES = THUMBNAIL_MAX_BYTES;

export const editorialUploadOptions: MulterOptions = {
  storage: new SecureDiskStorage(),
  limits: {
    fileSize: EDITORIAL_THUMBNAIL_UPLOAD_MAX_BYTES,
    files: 1,
    fields: 0,
    parts: 2,
  },
};
