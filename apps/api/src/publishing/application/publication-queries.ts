import { Inject, Injectable } from "@nestjs/common";

import {
  PUBLICATION_REPOSITORY,
  type PublicationRepository,
} from "./publication-repository.port.js";
import { PublicationNotFoundError } from "../domain/publication.js";

@Injectable()
export class GetPublicationIntent {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}
  execute(id: string) {
    return this.repository.get(id);
  }
}

@Injectable()
export class ListPublicationIntents {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}
  execute(input: {
    projectId: string;
    channelId?: string;
    cursor?: string;
    limit: number;
  }) {
    return this.repository.listProject(input);
  }
}

@Injectable()
export class CancelPublicationIntent {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}
  execute(id: string) {
    return this.repository.cancel(id, new Date());
  }
}

@Injectable()
export class ConfirmPublicationRemoteAbsent {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}
  async execute(id: string) {
    if (!(await this.repository.get(id))) throw new PublicationNotFoundError();
    return this.repository.confirmRemoteAbsent(id, new Date());
  }
}
