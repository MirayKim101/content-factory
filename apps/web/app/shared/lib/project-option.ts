import type { LibraryPage } from "~/shared/api/generated/project";

export interface ProjectOption {
  id: string;
  name: string;
  detail: string;
}

export function toProjectOption(
  project: LibraryPage["items"][number],
): ProjectOption {
  return {
    id: project.id,
    name: project.name,
    detail: `${project.source.originalFilename} · ${project.id.slice(0, 8)}`,
  };
}
