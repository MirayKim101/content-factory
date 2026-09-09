import { Inject, Injectable } from "@nestjs/common";

import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import type { EditorialStorage } from "../application/editorial-storage.port.js";

@Injectable()
export class ProjectObjectEditorialStorage implements EditorialStorage {
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

  async readObject(objectKey: string) {
    if (!this.storage.readObject) return null;
    return this.storage.readObject(objectKey);
  }
}
