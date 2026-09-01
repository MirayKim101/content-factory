import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface.js";

import { SecureDiskStorage } from "./secure-disk-storage.js";

import { apiEnvironment } from "../../config/environment.js";

const config = apiEnvironment();

export const uploadOptions: MulterOptions = {
  storage: new SecureDiskStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 2,
    // Fields and files are bounded separately; this also allows multipart's
    // framing overhead without accidentally rejecting the three valid parts.
    parts: 10,
    fieldSize: 1024 * 1024,
  },
};
