# Stage 2B-6 operator acceptance

Status: ready for the owner; human evidence not yet recorded

Use only the Content Factory UI at
`http://127.0.0.1:3100/horizontal?projectIds=282fd2eb-1e82-4fb9-9019-bf3759159802`.
Do not use port 3000. The bounded comparison uses cut job
`108f6fdd-3016-4cfc-96c5-347d3348d1a7` for both runs.

## Before starting

1. Confirm API health at `http://127.0.0.1:3001/api/v1/health`.
   Expected result: `{"status":"ok"}`.
2. Open the horizontal workspace on port 3100 and select the existing project.
   Expected result: the production workspace loads without a red global error.
3. Do not approve or export until the video plays, the thumbnail is visible and
   metadata has been read. These actions represent the owner's editorial
   decision and are intentionally not automated by Codex.
4. Use one uninterrupted active browser tab for each measured review. The UI
   attention counters pause when the tab is not active.

## Run A — manual baseline

1. Keep the existing manual title, description, tags and manual thumbnail.
2. For the current READY assembly, click **Проверить и подтвердить**.
3. Verify the dialog shows:
   - **Финальная проверка**;
   - workflow mode **Ручной**;
   - playable video and visible 16:9 thumbnail;
   - metadata and exact revision;
   - no blocker under **Подтверждение пока недоступно**.
4. Expand **Происхождение и стоимость**. Expected result: Metadata and
   Thumbnail are `MANUAL`, combined AI direct cost is zero and no private
   object key or prompt is visible.
5. Record the displayed **Подготовка** and **Финальная проверка** values plus
   wall-clock start/end in the table below.
6. Select **Проверил и подтверждаю эту версию**, then click
   **Подтвердить версию**.
7. Expected result: **Версия готова к экспорту**. Click
   **Экспортировать пакет** and wait for READY in the cut card.
8. Download the ZIP. Expected result: one package containing video, thumbnail,
   metadata text, metadata JSON and manifest JSON.

## Run B — assisted path

This run requires `RESEARCH_TEXT_ENABLED=1` and
`THUMBNAIL_SUGGESTIONS_ENABLED=1` in the explicitly selected local acceptance
runtime. They remain off in the committed default configuration. Enable them
only immediately before this owner-run acceptance and return them to off after
the evidence is recorded.

1. Open the editorial package editor for the same cut.
2. Under **Исследование и варианты текста**, enter one bounded question and at
   least one HTTPS citation whose title, publisher and factual excerpt the
   owner has actually checked. Click **Создать вариант**.
3. Expected result: the saved suggestion reaches READY and shows citation and
   freshness. Click **Перенести в поля**, make any desired human edit, then
   click **Применить текущие поля**. The new immutable revision must report
   `AI_ASSISTED` when unchanged or `MIXED` after an edit.
4. Under **Вариант обложки без likeness**, click
   **Создать безопасный вариант**. Expected result: a READY private PNG with
   likeness `NONE`. Click **Применить точный вариант**.
5. Rebuild the current assembly if the UI marks the prior render stale. Wait for
   READY, then click **Проверить и подтвердить**.
6. Verify independent Metadata and Thumbnail modes, citations, freshness,
   likeness `NONE`, exact revision and direct AI cost under
   **Происхождение и стоимость**.
7. Record the displayed attention values and wall clock. Confirm the exact
   version and export the ZIP as in Run A.
8. Expected result: manifest v2 preserves the same visible modes/citation IDs
   and contains no citation excerpt, prompt, credential or object key.

## Evidence record

| Run          | Preparation foreground | Final-review foreground | Wall clock | Direct AI cost | Final mode | ZIP accepted |
| ------------ | ---------------------: | ----------------------: | ---------: | -------------: | ---------- | ------------ |
| A — manual   |                pending |                 pending |    pending |        pending | pending    | pending      |
| B — assisted |                pending |                 pending |    pending |        pending | pending    | pending      |

Acceptance is complete only when both rows contain real owner observations.
The result is evidence about this bounded workflow, not a general productivity
or cost-savings claim.

## Controlled failure check

After a successful approval, change and save one metadata field but do not
approve the new revision. Open review again. Expected result: the previous
approval is shown as stale and export for it is blocked. Restore or accept the
new value through a new explicit approval; do not mutate database rows directly.

## Stop and report

Stop the run and keep the manual path unchanged if the video or thumbnail does
not load, a private object key/prompt appears, component modes disagree with
the actions performed, approval remains current after an applied edit, or a
stale approval can create an export.
