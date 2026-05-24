import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("REST API", () => {
  it("creates a guest session and accepts a profile", async () => {
    const app = buildApp();
    await app.ready();

    const sessionResponse = await app.inject({ method: "POST", url: "/api/session" });
    expect(sessionResponse.statusCode).toBe(200);
    const { sessionId } = sessionResponse.json<{ sessionId: string }>();

    const profileResponse = await app.inject({
      method: "POST",
      url: "/api/profile",
      headers: { "x-session-id": sessionId },
      payload: {
        displayName: "Cole",
        photoUrl: "data:image/png;base64,abc",
        bio: "Testing",
        cityRegion: "Brooklyn",
        interestTags: ["music"]
      }
    });

    expect(profileResponse.statusCode).toBe(200);
    await app.close();
  });

  it("persists report and block requests through the moderation endpoints", async () => {
    const app = buildApp();
    await app.ready();

    const a = (await app.inject({ method: "POST", url: "/api/session" })).json<{ sessionId: string }>();
    const b = (await app.inject({ method: "POST", url: "/api/session" })).json<{ sessionId: string }>();

    const report = await app.inject({
      method: "POST",
      url: "/api/report",
      headers: { "x-session-id": a.sessionId },
      payload: { targetSessionId: b.sessionId, reason: "other", details: "test" }
    });
    const block = await app.inject({
      method: "POST",
      url: "/api/block",
      headers: { "x-session-id": a.sessionId },
      payload: { targetSessionId: b.sessionId }
    });

    expect(report.statusCode).toBe(200);
    expect(block.statusCode).toBe(200);
    await app.close();
  });
});
