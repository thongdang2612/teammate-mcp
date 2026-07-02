import { describe, it, expect } from "vitest";
import { slugify } from "../../src/utils/slug.js";
import { buildModulePath } from "../../src/utils/upload-paths.js";

describe("upload utils", () => {
  it("slugify lowercases and hyphenates", () => {
    expect(slugify("My Avatar (v2).PNG")).toBe("my-avatar-v2-.png");
  });

  it("buildModulePath formats dd-mm-yy", () => {
    const d = new Date(Date.UTC(2026, 6, 2)); // 2 Jul 2026
    expect(buildModulePath("agent-teammate-icons", d)).toBe("agent-teammate-icons/02-07-26");
  });
});
