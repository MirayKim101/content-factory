import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_EXPORT_REPOSITORY,
  type EditorialExportRepository,
} from "./editorial-export-repository.port.js";
import {
  EditorialExportLineageInvalidError,
  EditorialExportNotFoundError,
  EditorialExportResultNotReadyError,
} from "../domain/editorial-export.js";

@Injectable()
export class GetEditorialExport {
  constructor(
    @Inject(EDITORIAL_EXPORT_REPOSITORY)
    private readonly repository: EditorialExportRepository,
  ) {}
  execute(exportId: string) {
    return this.repository.get(exportId);
  }
}

@Injectable()
export class ListEditorialExports {
  constructor(
    @Inject(EDITORIAL_EXPORT_REPOSITORY)
    private readonly repository: EditorialExportRepository,
  ) {}
  execute(input: { projectId: string; cursor?: string; limit: number }) {
    return this.repository.listProject(input);
  }
}

@Injectable()
export class GetEditorialExportContent {
  constructor(
    @Inject(EDITORIAL_EXPORT_REPOSITORY)
    private readonly repository: EditorialExportRepository,
  ) {}
  async execute(exportId: string) {
    const value = await this.repository.get(exportId);
    if (!value) throw new EditorialExportNotFoundError();
    if (!value.approvalCurrent || value.job.state !== "READY" || !value.result)
      throw new EditorialExportResultNotReadyError();
    const content = await this.repository.getContent(exportId);
    if (!content) throw new EditorialExportLineageInvalidError();
    return content;
  }
}
