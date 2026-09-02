import { describe, expect, it, vi } from "vitest";

import { ListProjects } from "../src/projects/application/list-projects.js";
import type { ProjectLibraryRepository } from "../src/projects/application/project-library-repository.port.js";

describe("ListProjects", () => {
  it("passes validated filters to the library repository", async () => {
    const page = { items: [], nextCursor: null };
    const repository: ProjectLibraryRepository = {
      list: vi.fn().mockResolvedValue(page),
    };
    const useCase = new ListProjects(repository);
    const query = {
      limit: 20,
      status: "SOURCE_READY" as const,
      q: "source",
    };

    await expect(useCase.execute(query)).resolves.toBe(page);
    expect(repository.list).toHaveBeenCalledWith(query);
  });
});
