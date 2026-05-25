import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import { ZodError } from "zod";
import {
  callEndPayloadSchema,
  callReadyPayloadSchema,
  clientSocketEvents,
  createSessionResponseSchema,
  guestProfileSchema,
  moderationPayloadSchema,
  queueJoinPayloadSchema,
  serverSocketEvents,
  signalAnswerPayloadSchema,
  signalIcePayloadSchema,
  signalOfferPayloadSchema,
  swipeSubmitPayloadSchema,
  type MatchCreatedPayload
} from "@sighthop/shared";
import { createLiveState } from "./live-state.js";
import { createStore } from "./store.js";
import type { EncounterRecord } from "./types.js";

const fallbackAfterMs = 15_000;
const disconnectGraceMs = 10_000;
const defaultIceServers: MatchCreatedPayload["iceServers"] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
const defaultClientOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

type DeploymentState = {
  draining: boolean;
  drainStartedAt?: string;
};

type BuildAppOptions = {
  redisUrl?: string;
  liveStateKeyPrefix?: string;
  releaseName?: string;
  instanceId?: string;
  redisFactory?: () => Redis;
};

function getClientOrigins() {
  const configuredOrigins = process.env.CLIENT_ORIGINS ?? process.env.CLIENT_ORIGIN;
  if (!configuredOrigins) return defaultClientOrigins;
  return configuredOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function splitEnvList(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getIceServers(): MatchCreatedPayload["iceServers"] {
  const stunUrls = splitEnvList(process.env.STUN_SERVER_URLS);
  const turnUrls = splitEnvList(process.env.TURN_SERVER_URLS);
  const iceServers: MatchCreatedPayload["iceServers"] = stunUrls.length
    ? stunUrls.map((urls) => ({ urls }))
    : [...defaultIceServers];

  if (!turnUrls.length) return iceServers;

  const username = process.env.TURN_USERNAME?.trim();
  const credential = process.env.TURN_PASSWORD?.trim();
  if (!username || !credential) {
    throw new Error("TURN_SERVER_URLS requires TURN_USERNAME and TURN_PASSWORD.");
  }

  iceServers.push({
    urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
    username,
    credential
  });
  return iceServers;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: 3_000_000 });
  const store = createStore(app.log);
  const clientOrigins = getClientOrigins();
  const iceServers = getIceServers();
  const deployment: DeploymentState = { draining: false };
  const deployAdminToken = process.env.DEPLOY_ADMIN_TOKEN?.trim();
  const releaseName = options.releaseName ?? process.env.RELEASE_NAME?.trim() ?? "default";
  const instanceId = options.instanceId ?? randomUUID();
  const liveState = createLiveState({
    logger: app.log,
    redisUrl: options.redisUrl ?? process.env.REDIS_URL,
    instanceId,
    keyPrefix: options.liveStateKeyPrefix ?? process.env.LIVE_STATE_KEY_PREFIX,
    redisFactory: options.redisFactory
  });
  const localSockets = new Map<string, string>();
  const disconnectTimers = new Map<string, NodeJS.Timeout>();

  const getDeploymentStatus = async () => {
    const counts = await liveState.getDeploymentCounts(releaseName);
    return {
      draining: deployment.draining,
      drainStartedAt: deployment.drainStartedAt,
      ...counts
    };
  };

  const startDrain = async () => {
    deployment.draining = true;
    deployment.drainStartedAt ??= new Date().toISOString();
    app.log.info({ deployment: await getDeploymentStatus() }, "Deployment drain mode enabled");
  };

  const stopDrain = async () => {
    deployment.draining = false;
    deployment.drainStartedAt = undefined;
    app.log.info({ deployment: await getDeploymentStatus() }, "Deployment drain mode disabled");
  };

  const authorizeDeployRequest = (tokenHeader: string | string[] | undefined) => {
    if (!deployAdminToken) return { ok: false as const, statusCode: 404, message: "Deploy admin endpoints are disabled." };
    if (typeof tokenHeader !== "string" || tokenHeader !== deployAdminToken) {
      return { ok: false as const, statusCode: 401, message: "Invalid deploy token." };
    }
    return { ok: true as const };
  };

  app.register(cors, {
    origin: clientOrigins,
    credentials: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: error.issues[0]?.message ?? "Invalid request" });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      const message = "message" in error && typeof error.message === "string" ? error.message : "Bad request";
      return reply.code(error.statusCode).send({ message });
    }
    app.log.error(error);
    return reply.code(500).send({ message: "Internal server error" });
  });

  app.post("/api/session", async (_request, reply) => {
    if (deployment.draining) {
      return reply.code(503).send({ message: "This server is draining for a deployment. Refresh and try again in a moment." });
    }
    const session = await liveState.createSession();
    return createSessionResponseSchema.parse({ sessionId: session.id });
  });

  app.post("/api/profile", async (request, reply) => {
    const sessionId = getSessionIdFromHeader(request.headers["x-session-id"]);
    if (!sessionId) return reply.code(401).send({ message: "Unknown session" });
    const profile = guestProfileSchema.parse(request.body);
    const updated = await liveState.updateProfile(sessionId, profile);
    if (!updated) return reply.code(401).send({ message: "Unknown session" });
    return { ok: true };
  });

  app.post("/api/report", async (request, reply) => {
    const session = await requireSession(request.headers["x-session-id"], liveState);
    if (!session) return reply.code(401).send({ message: "Unknown session" });

    const payload = moderationPayloadSchema.parse(request.body);
    await store.saveReport(session.id, payload);
    await store.recordMetric("report", { sessionId: session.id, targetSessionId: payload.targetSessionId });
    return { ok: true };
  });

  app.post("/api/block", async (request, reply) => {
    const session = await requireSession(request.headers["x-session-id"], liveState);
    if (!session) return reply.code(401).send({ message: "Unknown session" });

    const payload = moderationPayloadSchema.parse(request.body);
    await liveState.addBlock(session.id, payload.targetSessionId);
    await store.saveBlock(session.id, payload);
    await store.recordMetric("block", { sessionId: session.id, targetSessionId: payload.targetSessionId });
    await endEncounter(io, liveState, localSockets, instanceId, payload.encounterId, "blocked");
    return { ok: true };
  });

  app.get("/api/health", async () => ({ ok: true, dependencies: await store.health(), deployment: await getDeploymentStatus() }));

  app.post("/api/admin/drain/start", async (request, reply) => {
    const auth = authorizeDeployRequest(request.headers["x-deploy-token"]);
    if (!auth.ok) return reply.code(auth.statusCode).send({ message: auth.message });
    await startDrain();
    return { ok: true, deployment: await getDeploymentStatus() };
  });

  app.post("/api/admin/drain/stop", async (request, reply) => {
    const auth = authorizeDeployRequest(request.headers["x-deploy-token"]);
    if (!auth.ok) return reply.code(auth.statusCode).send({ message: auth.message });
    await stopDrain();
    return { ok: true, deployment: await getDeploymentStatus() };
  });

  const io = new Server(app.server, {
    cors: {
      origin: clientOrigins,
      credentials: true
    }
  });

  liveState.onMessage((message) => {
    if (message.targetInstanceId !== instanceId) return;
    if (message.type === "emit") {
      const socketId = localSockets.get(message.sessionId);
      if (socketId) {
        io.to(socketId).emit(message.event, message.payload);
      }
      return;
    }

    const socketId = localSockets.get(message.sessionId);
    if (socketId && socketId === message.socketId) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
  });

  io.use((socket, next) => {
    void (async () => {
      const sessionId = socket.handshake.auth.sessionId;
      const session = typeof sessionId === "string" ? await liveState.getSession(sessionId) : undefined;
      if (!session) return next(new Error("Unknown session"));
      socket.data.sessionId = sessionId;
      next();
    })().catch((error) => next(error instanceof Error ? error : new Error("Unknown session")));
  });

  io.on("connection", (socket) => {
    const sessionId = socket.data.sessionId as string;
    const existingTimer = disconnectTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      disconnectTimers.delete(sessionId);
    }

    void (async () => {
      const previousPresence = await liveState.setPresence({
        sessionId,
        socketId: socket.id,
        instanceId,
        releaseName,
        updatedAt: Date.now()
      });
      if (!previousPresence || previousPresence.socketId === socket.id) {
        localSockets.set(sessionId, socket.id);
        return;
      }
      if (previousPresence.instanceId === instanceId) {
        io.sockets.sockets.get(previousPresence.socketId)?.disconnect(true);
      } else {
        await liveState.publishMessage({
          type: "disconnect",
          targetInstanceId: previousPresence.instanceId,
          sessionId,
          socketId: previousPresence.socketId
        });
      }
      localSockets.set(sessionId, socket.id);
    })().catch((error) => {
      app.log.error({ error, sessionId }, "Failed to register session presence");
      socket.disconnect(true);
    });

    const heartbeat = setInterval(() => {
      void liveState.refreshPresence(sessionId, socket.id, instanceId);
    }, 10_000);

    socket.on(clientSocketEvents.queueJoin, async (raw) => {
      const payload = queueJoinPayloadSchema.parse(raw);
      if (deployment.draining) {
        return socket.emit(serverSocketEvents.error, {
          message: "This server is draining for a deployment. Refresh and try again in a moment."
        });
      }
      const session = await liveState.getSession(sessionId);
      if (!session?.profile) return socket.emit(serverSocketEvents.error, { message: "Profile required" });
      if (session.activeEncounterId) return;

      await liveState.joinQueue(sessionId, payload.matchMode);
      socket.emit(serverSocketEvents.queueWaiting, { matchMode: payload.matchMode, fallbackAfterMs });
      await store.recordMetric("queue_join", { sessionId, matchMode: payload.matchMode });

      const match = await liveState.attemptMatch(sessionId);
      if (!match) return;

      await store.recordMetric("pair_presented", {
        encounterId: match.encounter.id,
        matchMode: match.encounter.matchMode
      });

      await emitToSession(io, liveState, localSockets, instanceId, match.encounter.sessionIds[0], serverSocketEvents.encounterPresented, {
        encounterId: match.encounter.id,
        counterpart: match.counterpartProfiles[match.encounter.sessionIds[0]],
        matchMode: match.encounter.matchMode
      });
      await emitToSession(io, liveState, localSockets, instanceId, match.encounter.sessionIds[1], serverSocketEvents.encounterPresented, {
        encounterId: match.encounter.id,
        counterpart: match.counterpartProfiles[match.encounter.sessionIds[1]],
        matchMode: match.encounter.matchMode
      });
    });

    socket.on(clientSocketEvents.queueLeave, () => {
      void liveState.leaveQueue(sessionId);
    });

    socket.on(clientSocketEvents.swipeSubmit, async (raw) => {
      const payload = swipeSubmitPayloadSchema.parse(raw);
      const result = await liveState.applySwipe(sessionId, payload.encounterId, payload.decision);
      if (result.type === "ignored") return;

      await store.recordMetric(payload.decision === "right" ? "swipe_right" : "swipe_left", {
        sessionId,
        encounterId: payload.encounterId
      });

      if (result.type === "ended") {
        await notifyEncounterEnded(io, liveState, localSockets, instanceId, result.encounter, "left_swipe");
        return;
      }

      if (result.type === "matched") {
        const [a, b] = result.encounter.sessionIds;
        await store.recordMetric("mutual_match", { encounterId: result.encounter.id });
        await store.recordMetric("call_start", { encounterId: result.encounter.id });
        await emitToSession(io, liveState, localSockets, instanceId, a, serverSocketEvents.matchCreated, {
          encounterId: result.encounter.id,
          roomId: result.encounter.roomId,
          role: "initiator",
          iceServers
        });
        await emitToSession(io, liveState, localSockets, instanceId, b, serverSocketEvents.matchCreated, {
          encounterId: result.encounter.id,
          roomId: result.encounter.roomId,
          role: "receiver",
          iceServers
        });
      }
    });

    socket.on(clientSocketEvents.signalOffer, (raw) => {
      void relaySignal(io, liveState, localSockets, instanceId, sessionId, signalOfferPayloadSchema.parse(raw), serverSocketEvents.signalOffer);
    });
    socket.on(clientSocketEvents.signalAnswer, (raw) => {
      void relaySignal(io, liveState, localSockets, instanceId, sessionId, signalAnswerPayloadSchema.parse(raw), serverSocketEvents.signalAnswer);
    });
    socket.on(clientSocketEvents.signalIce, (raw) => {
      void relaySignal(io, liveState, localSockets, instanceId, sessionId, signalIcePayloadSchema.parse(raw), serverSocketEvents.signalIce);
    });

    socket.on(clientSocketEvents.callReady, async (raw) => {
      const payload = callReadyPayloadSchema.parse(raw);
      const readySessionIds = await liveState.markCallReady(sessionId, payload.encounterId);
      if (!readySessionIds) return;
      for (const readySessionId of readySessionIds) {
        await emitToSession(io, liveState, localSockets, instanceId, readySessionId, serverSocketEvents.callReady, {
          encounterId: payload.encounterId
        });
      }
    });

    socket.on(clientSocketEvents.callEnd, async (raw) => {
      const payload = callEndPayloadSchema.parse(raw);
      await store.recordMetric(payload.reason === "ice_failed" ? "ice_failure" : "call_end", {
        sessionId,
        encounterId: payload.encounterId
      });
      if (payload.reason === "ice_failed") {
        const encounter = await liveState.getEncounter(payload.encounterId);
        const otherId = otherSessionId(encounter, sessionId);
        if (otherId) {
          await emitToSession(io, liveState, localSockets, instanceId, otherId, serverSocketEvents.callFailed, {
            encounterId: payload.encounterId
          });
        }
      }
      await endEncounter(io, liveState, localSockets, instanceId, payload.encounterId, payload.reason);
    });

    socket.on("disconnect", () => {
      clearInterval(heartbeat);
      if (localSockets.get(sessionId) !== socket.id) return;
      localSockets.delete(sessionId);
      void liveState.clearPresence(sessionId, socket.id, instanceId);
      const timer = setTimeout(() => {
        disconnectTimers.delete(sessionId);
        void (async () => {
          const presence = await liveState.getPresence(sessionId);
          if (presence) return;
          await liveState.leaveQueue(sessionId);
          const session = await liveState.getSession(sessionId);
          await endEncounter(io, liveState, localSockets, instanceId, session?.activeEncounterId, "disconnected");
        })().catch((error) => {
          app.log.error({ error, sessionId }, "Failed to finalize disconnect cleanup");
        });
      }, disconnectGraceMs);
      disconnectTimers.set(sessionId, timer);
    });
  });

  app.addHook("onReady", async () => {
    await store.init();
    await liveState.init();
  });

  app.addHook("onClose", async () => {
    for (const timer of disconnectTimers.values()) {
      clearTimeout(timer);
    }
    disconnectTimers.clear();
    await Promise.all([store.close(), liveState.close()]);
  });

  return app;
}

async function requireSession(header: string | string[] | undefined, liveState: ReturnType<typeof createLiveState>) {
  const sessionId = getSessionIdFromHeader(header);
  return sessionId ? liveState.getSession(sessionId) : undefined;
}

function getSessionIdFromHeader(header: string | string[] | undefined) {
  return typeof header === "string" ? header : undefined;
}

async function emitToSession(
  io: Server,
  liveState: ReturnType<typeof createLiveState>,
  localSockets: Map<string, string>,
  instanceId: string,
  sessionId: string,
  event: string,
  payload: unknown
) {
  const presence = await liveState.getPresence(sessionId);
  if (!presence) return;
  if (presence.instanceId === instanceId) {
    const socketId = localSockets.get(sessionId);
    if (socketId) {
      io.to(socketId).emit(event, payload);
    }
    return;
  }
  await liveState.publishMessage({
    type: "emit",
    targetInstanceId: presence.instanceId,
    sessionId,
    event,
    payload
  });
}

async function relaySignal(
  io: Server,
  liveState: ReturnType<typeof createLiveState>,
  localSockets: Map<string, string>,
  instanceId: string,
  senderId: string,
  payload: { encounterId: string },
  event: string
) {
  const encounter = await liveState.getEncounter(payload.encounterId);
  if (!encounter || encounter.state !== "matched") return;
  const targetId = otherSessionId(encounter, senderId);
  if (targetId) {
    await emitToSession(io, liveState, localSockets, instanceId, targetId, event, payload);
  }
}

function otherSessionId(encounter: EncounterRecord | undefined, sessionId: string) {
  if (!encounter?.sessionIds.includes(sessionId)) return undefined;
  return encounter.sessionIds[0] === sessionId ? encounter.sessionIds[1] : encounter.sessionIds[0];
}

async function endEncounter(
  io: Server,
  liveState: ReturnType<typeof createLiveState>,
  localSockets: Map<string, string>,
  instanceId: string,
  encounterId: string | undefined,
  reason: "left_swipe" | "hangup" | "blocked" | "disconnected" | "ice_failed"
) {
  const encounter = await liveState.endEncounter(encounterId);
  if (!encounter) return;
  await notifyEncounterEnded(io, liveState, localSockets, instanceId, encounter, reason);
}

async function notifyEncounterEnded(
  io: Server,
  liveState: ReturnType<typeof createLiveState>,
  localSockets: Map<string, string>,
  instanceId: string,
  encounter: EncounterRecord,
  reason: "left_swipe" | "hangup" | "blocked" | "disconnected" | "ice_failed"
) {
  for (const sessionId of encounter.sessionIds) {
    await emitToSession(io, liveState, localSockets, instanceId, sessionId, serverSocketEvents.encounterEnded, {
      encounterId: encounter.id,
      reason
    });
  }
}
