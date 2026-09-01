-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('SOURCE_PENDING', 'SOURCE_READY', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "VideoSourceStatus" AS ENUM ('PENDING', 'READY', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "MediaArtifactStatus" AS ENUM ('PENDING', 'READY', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "MediaArtifactRole" AS ENUM ('SOURCE');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'SOURCE_PENDING',
    "rightsConfirmedAt" TIMESTAMP(3) NOT NULL,
    "rightsDeclarationVersion" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "VideoSourceStatus" NOT NULL DEFAULT 'PENDING',
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaArtifact" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "role" "MediaArtifactRole" NOT NULL,
    "status" "MediaArtifactStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" TEXT NOT NULL,
    "storageEtag" TEXT,
    "storageVersion" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "lineageSourceId" UUID NOT NULL,
    "lineageSourceVersion" INTEGER NOT NULL,
    "recipeVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoSource_projectId_key" ON "VideoSource"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaArtifact_objectKey_key" ON "MediaArtifact"("objectKey");

-- CreateIndex
CREATE INDEX "MediaArtifact_status_createdAt_idx" ON "MediaArtifact"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "VideoSource" ADD CONSTRAINT "VideoSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaArtifact" ADD CONSTRAINT "MediaArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaArtifact" ADD CONSTRAINT "MediaArtifact_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
