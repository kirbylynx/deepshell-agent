import { describe, expect, it } from "vitest";
import { redact } from "../../src-bootstrap/redact";

describe("redact", () => {
  it("masks short values", () => {
    expect(redact("abcd")).toBe("***");
  });

  it("keeps only prefix and suffix", () => {
    expect(redact("1234567890")).toBe("1234***7890");
  });
});
