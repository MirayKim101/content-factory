# AI and Media Processing Strategy

## Horizontal video

The horizontal pipeline should be owned by Content Factory: timestamps/story plan, FFmpeg trimming, transitions, normalized audio, overlays, banner/video ad insertion, intro/outro, subtitles and final encoding. OpusClip is not the horizontal renderer baseline; it is primarily a long-to-short repurposing service.

Where AI helps horizontal work:

- transcript and scene/event indexing;
- candidate story boundaries and dead-air removal;
- title, description and thumbnail concepts;
- quality flags;
- optional highlight suggestions that a deterministic FFmpeg recipe renders.

## Vertical candidates

| Provider | Strong initial fit                       | Automation note                                              | Current public signal                                                                         |
| -------- | ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Eklipse  | Twitch/Kick/YouTube gaming streams       | stream-focused; validate API/export workflow                 | Premium publicly starts around $24.99 monthly; published limit up to 3 streams/12 hours daily |
| OpusClip | general long-form and social clipping    | limited API on public Pro plan; business terms may be needed | Free 60 min; paid tiers and multi-aspect output available                                     |
| Vizard   | speech-heavy video, podcasts, interviews | documented API and high-volume contact path                  | credits map to uploaded minutes; contact requested above 10,000 min/month                     |

Decision: build a provider-neutral `ClipGenerationProvider` and run a benchmark rather than hard-code one vendor. For gaming, test Eklipse first. For speech-heavy sources, test OpusClip and Vizard. The benchmark set must contain the same authorized source videos and score useful-clip precision, crop quality, captions, Russian-language quality, latency, price, API availability and export restrictions.

## Scale warning

Consumer subscriptions are suitable for an MVP quality test, not automatically for 50–100 channels. Production selection requires API/business pricing, provider rate limits, rights to automate and a fallback path. Local transcription plus owned FFmpeg cropping should be evaluated once external per-minute cost becomes material.

## Human quality gate

AI virality scores are ranking hints, not publication decisions. During MVP every clip is reviewed. Automation can expand only after measured false-positive, unsafe-content and copyright-review error rates remain within agreed thresholds.
