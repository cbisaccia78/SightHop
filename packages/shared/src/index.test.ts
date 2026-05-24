import { describe, expect, it } from "vitest";
import { guestProfileSchema, matchModeSchema } from "./index";

describe("shared schemas", () => {
  it("accepts the three MVP match modes", () => {
    expect(matchModeSchema.options).toEqual(["location", "preferences", "random"]);
  });

  it("normalizes guest profile defaults", () => {
    const profile = guestProfileSchema.parse({
      displayName: "Cole",
      photoUrl: "data:image/png;base64,abc",
      bio: "Hello"
    });

    expect(profile.cityRegion).toBe("");
    expect(profile.interestTags).toEqual([]);
  });
});
