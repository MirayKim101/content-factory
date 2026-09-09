import { Inject, Injectable } from "@nestjs/common";

import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import type { CreatorContextStorage } from "../application/creator-context-storage.port.js";

@Injectable()
export class ProjectObjectCreatorContextStorage implements CreatorContextStorage {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
  }) {
    return this.storage.putFile(input);
  }

  deleteObject(objectKey: string) {
    return this.storage.deleteObject(objectKey);
  }

  headObject(objectKey: string) {
    return this.storage.headObject(objectKey);
  }

  async readObject(objectKey: string, range?: string) {
    if (!this.storage.readObject) return null;
    return this.storage.readObject(objectKey, range);
  }
}
