import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  type EditorialRepository,
} from "./editorial-repository.port.js";

@Injectable()
export class ListProcessingTemplates {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}

  execute() {
    return this.repository.listTemplates();
  }
}
