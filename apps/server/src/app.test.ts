import { io as createSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { clientSocketEvents, serverSocketEvents } from "@localchat/shared";
import { buildApp } from "./app.js";

const previousDeployAdminToken = process.env.DEPLOY_ADMIN_TOKEN;

afterEach(() => {
  process.env.DEPLOY_ADMIN_TOKEN = previousDeployAdminToken;
});

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

  it("reports deployment drain status and blocks new sessions while draining", async () => {
    process.env.DEPLOY_ADMIN_TOKEN = "test-deploy-token";
    const app = buildApp();
    await app.ready();

    const drainResponse = await app.inject({
      method: "POST",
      url: "/api/admin/drain/start",
      headers: { "x-deploy-token": "test-deploy-token" }
    });

    expect(drainResponse.statusCode).toBe(200);

    const healthResponse = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json<{ deployment: { draining: boolean } }>().deployment.draining).toBe(true);

    const sessionResponse = await app.inject({ method: "POST", url: "/api/session" });
    expect(sessionResponse.statusCode).toBe(503);

    await app.close();
  });

  it("blocks queue joins while draining", async () => {
    process.env.DEPLOY_ADMIN_TOKEN = "test-deploy-token";
    const app = buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");

    const sessionResponse = await app.inject({ method: "POST", url: "/api/session" });
    const { sessionId } = sessionResponse.json<{ sessionId: string }>();

    await app.inject({
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

    const socket = createSocket(`http://127.0.0.1:${address.port}`, {
      auth: { sessionId },
      transports: ["websocket"]
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (error) => reject(error));
    });

    await app.inject({
      method: "POST",
      url: "/api/admin/drain/start",
      headers: { "x-deploy-token": "test-deploy-token" }
    });

    const errorPayload = await new Promise<{ message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for drain error")), 2_000);
      socket.once(serverSocketEvents.error, (payload) => {
        clearTimeout(timeout);
        resolve(payload as { message: string });
      });
      socket.emit(clientSocketEvents.queueJoin, { matchMode: "random" });
    });

    expect(errorPayload.message).toContain("draining");

    socket.close();
    await app.close();
  });
});
