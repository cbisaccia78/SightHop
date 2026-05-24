import { describe, expect, it } from "vitest";
import { pickPartner } from "./matchmaking.js";
import type { QueueEntry } from "./types.js";

const now = Date.now();

function entry(sessionId: string, matchMode: QueueEntry["matchMode"], joinedAt = now): QueueEntry {
  return { sessionId, matchMode, joinedAt };
}

describe("pickPartner", () => {
  it("matches location users by self-entered city", () => {
    const profiles = new Map([
      ["a", { sessionId: "a", displayName: "A", photoUrl: "x", bio: "", cityRegion: "Brooklyn", interestTags: [] }],
      ["b", { sessionId: "b", displayName: "B", photoUrl: "x", bio: "", cityRegion: "brooklyn", interestTags: [] }],
      ["c", { sessionId: "c", displayName: "C", photoUrl: "x", bio: "", cityRegion: "Queens", interestTags: [] }]
    ]);

    expect(pickPartner(entry("a", "location"), [entry("b", "location"), entry("c", "location")], profiles, new Map())?.sessionId).toBe("b");
  });

  it("matches preference users by overlapping interest tags", () => {
    const profiles = new Map([
      ["a", { sessionId: "a", displayName: "A", photoUrl: "x", bio: "", cityRegion: "", interestTags: ["music"] }],
      ["b", { sessionId: "b", displayName: "B", photoUrl: "x", bio: "", cityRegion: "", interestTags: ["music", "art"] }],
      ["c", { sessionId: "c", displayName: "C", photoUrl: "x", bio: "", cityRegion: "", interestTags: ["sports"] }]
    ]);

    expect(pickPartner(entry("a", "preferences"), [entry("c", "preferences"), entry("b", "preferences")], profiles, new Map())?.sessionId).toBe("b");
  });

  it("allows random mode to match any profiled waiting user", () => {
    const profiles = new Map([
      ["a", { sessionId: "a", displayName: "A", photoUrl: "x", bio: "", cityRegion: "", interestTags: [] }],
      ["b", { sessionId: "b", displayName: "B", photoUrl: "x", bio: "", cityRegion: "", interestTags: [] }]
    ]);

    expect(pickPartner(entry("a", "random"), [entry("b", "location")], profiles, new Map())?.sessionId).toBe("b");
  });

  it("does not match blocked sessions", () => {
    const profiles = new Map([
      ["a", { sessionId: "a", displayName: "A", photoUrl: "x", bio: "", cityRegion: "", interestTags: [] }],
      ["b", { sessionId: "b", displayName: "B", photoUrl: "x", bio: "", cityRegion: "", interestTags: [] }]
    ]);
    const blocks = new Map([["a", new Set(["b"])]]);

    expect(pickPartner(entry("a", "random"), [entry("b", "random")], profiles, blocks)).toBeUndefined();
  });
});
