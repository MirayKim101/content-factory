import { Inject, Injectable, Optional } from "@nestjs/common";

import {
  PublicationNotFoundError,
  PublishingUnavailableError,
} from "../domain/publication.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
  TIKTOK_PUBLISHING_ADMISSION_ENABLED,
  YOUTUBE_PUBLISHING_ADMISSION_ENABLED,
  type PublicationRepository,
} from "./publication-repository.port.js";
import {
  PUBLICATION_DISPATCH,
  type PublicationDispatch,
} from "./publication-dispatch.port.js";

@Injectable()
export class RetryPublicationIntent {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
    @Inject(PUBLISHING_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Inject(YOUTUBE_PUBLISHING_ADMISSION_ENABLED)
    private readonly youtubeAdmissionEnabled: boolean,
    @Inject(TIKTOK_PUBLISHING_ADMISSION_ENABLED)
    private readonly tiktokAdmissionEnabled: boolean,
    @Inject(PUBLICATION_DISPATCH)
    private readonly dispatch: PublicationDispatch,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(id: string) {
    if (!this.admissionEnabled) throw new PublishingUnavailableError();
    const current = await this.repository.get(id);
    if (!current) throw new PublicationNotFoundError();
    if (
      current.platform !== "LOCAL_DRY_RUN" &&
      !(current.platform === "YOUTUBE" && this.youtubeAdmissionEnabled) &&
      !(current.platform === "TIKTOK" && this.tiktokAdmissionEnabled)
    )
      throw new PublishingUnavailableError();
    const retried = await this.repository.retry(id, this.clock());
    await Promise.allSettled([
      this.dispatch.dispatch({
        id: retried.id,
        scheduledAt: retried.scheduledAt,
      }),
    ]);
    return retried;
  }
}
