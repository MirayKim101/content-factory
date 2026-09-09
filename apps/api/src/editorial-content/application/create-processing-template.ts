import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  type EditorialRepository,
} from "./editorial-repository.port.js";

@Injectable()
export class CreateProcessingTemplate {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}

  execute(input: { name: string; idempotencyKey: string }) {
    const name = input.name.trim();
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ name, version: "manual-editorial-v1" }))
      .digest("hex");
    return this.repository.createTemplate({
      templateId: randomUUID(),
      revisionId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      name,
    });
  }
}
