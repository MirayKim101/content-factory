-- Preserve every existing job-shape guard and admit only the owned vertical variant.
ALTER TABLE "PipelineJob" DROP CONSTRAINT "PipelineJob_montage_type";
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "verticalRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text = 'ASSEMBLE_HORIZONTAL' AND "assemblyRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "editorialExportIntentId" IS NULL AND "verticalRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'horizontal-render-v1')
  OR ("type"::text = 'EXPORT_EDITORIAL_PACKAGE' AND "editorialExportIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "verticalRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND (("payloadVersion" = 1 AND "recipeVersion" = 'editorial-export-zip-v1') OR ("payloadVersion" = 2 AND "recipeVersion" = 'editorial-export-zip-v2')))
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "verticalRenderIntentId" IS NULL)
  OR ("type"::text = 'EXTRACT_EDITORIAL_FRAMES' AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "verticalRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'quartiles-jpeg-640-v1')
  OR ("type"::text = 'RENDER_VERTICAL' AND "verticalRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'vertical-render-v1')
);
