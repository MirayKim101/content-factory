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
  publicationPlatformEnabled,
  resolvePublishingCapabilities,
} from "./publishing-admission.js";
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
    const current = await this.repository.get(id);
    if (!current) throw new PublicationNotFoundError();
    if (
      !publicationPlatformEnabled(
        resolvePublishingCapabilities(
          this.admissionEnabled,
          this.youtubeAdmissionEnabled,
          this.tiktokAdmissionEnabled,
        ),
        current.platform,
      )
    )
      throw new PublishingUnavailableError();
    const retried = await this.repository.retry(id, this.clock());
    await Promise.allSettled([
      this.dispatch.dispatch({
        id: retried.id,
        scheduledAt: retried.scheduledAt,
        deliveryRevision: retried.updatedAt.getTime().toString(),
      }),
    ]);
    return retried;
  }
}
