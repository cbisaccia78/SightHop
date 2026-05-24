import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify from "fastify";
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
  type MatchCreatedPayload,
  type PublicGuestProfile
} from "@localchat/shared";
import { pickPartner } from "./matchmaking.js";
import { createStore } from "./store.js";
import type { EncounterRecord, QueueEntry, SessionRecord } from "./types.js";

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

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 3_000_000 });
  const store = createStore(app.log);
  const sessions = new Map<string, SessionRecord>();
  const queue = new Map<string, QueueEntry>();
  const encounters = new Map<string, EncounterRecord>();
  const clientOrigins = getClientOrigins();
  const iceServers = getIceServers();
  const deployment: DeploymentState = { draining: false };
  const deployAdminToken = process.env.DEPLOY_ADMIN_TOKEN?.trim();

  const getDeploymentStatus = () => ({
    draining: deployment.draining,
    drainStartedAt: deployment.drainStartedAt,
    queueSize: queue.size,
    activeEncounterCount: [...encounters.values()].filter((encounter) => encounter.state !== "ended").length
  });

  const startDrain = () => {
    deployment.draining = true;
    deployment.drainStartedAt ??= new Date().toISOString();
    app.log.info({ deployment: getDeploymentStatus() }, "Deployment drain mode enabled");
  };

  const stopDrain = () => {
    deployment.draining = false;
    deployment.drainStartedAt = undefined;
    app.log.info("Deployment drain mode disabled");
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
    const sessionId = randomUUID();
    sessions.set(sessionId, { id: sessionId, blockedSessionIds: new Set() });
    return createSessionResponseSchema.parse({ sessionId });
  });

  app.post("/api/profile", async (request, reply) => {
    const session = requireSession(request.headers["x-session-id"], sessions);
    if (!session) return reply.code(401).send({ message: "Unknown session" });

    const profile = guestProfileSchema.parse(request.body);
    session.profile = profile;
    return { ok: true };
  });

  app.post("/api/report", async (request, reply) => {
    const session = requireSession(request.headers["x-session-id"], sessions);
    if (!session) return reply.code(401).send({ message: "Unknown session" });

    const payload = moderationPayloadSchema.parse(request.body);
    await store.saveReport(session.id, payload);
    await store.recordMetric("report", { sessionId: session.id, targetSessionId: payload.targetSessionId });
    return { ok: true };
  });

  app.post("/api/block", async (request, reply) => {
    const session = requireSession(request.headers["x-session-id"], sessions);
    if (!session) return reply.code(401).send({ message: "Unknown session" });

    const payload = moderationPayloadSchema.parse(request.body);
    session.blockedSessionIds.add(payload.targetSessionId);
    await store.saveBlock(session.id, payload);
    await store.recordMetric("block", { sessionId: session.id, targetSessionId: payload.targetSessionId });
    endEncounter(io, encounters, sessions, payload.encounterId, "blocked");
    return { ok: true };
  });

  app.get("/api/health", async () => ({ ok: true, dependencies: await store.health(), deployment: getDeploymentStatus() }));

  app.post("/api/admin/drain/start", async (request, reply) => {
    const auth = authorizeDeployRequest(request.headers["x-deploy-token"]);
    if (!auth.ok) return reply.code(auth.statusCode).send({ message: auth.message });
    startDrain();
    return { ok: true, deployment: getDeploymentStatus() };
  });

  app.post("/api/admin/drain/stop", async (request, reply) => {
    const auth = authorizeDeployRequest(request.headers["x-deploy-token"]);
    if (!auth.ok) return reply.code(auth.statusCode).send({ message: auth.message });
    stopDrain();
    return { ok: true, deployment: getDeploymentStatus() };
  });

  const io = new Server(app.server, {
    cors: {
      origin: clientOrigins,
      credentials: true
    }
  });

  io.use((socket, next) => {
    const sessionId = socket.handshake.auth.sessionId;
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) return next(new Error("Unknown session"));
    socket.data.sessionId = sessionId;
    next();
  });

  io.on("connection", (socket) => {
    const session = sessions.get(socket.data.sessionId)!;
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
    if (session.socketId && session.socketId !== socket.id) {
      io.sockets.sockets.get(session.socketId)?.disconnect(true);
    }
    session.socketId = socket.id;

    socket.on(clientSocketEvents.queueJoin, async (raw) => {
      const payload = queueJoinPayloadSchema.parse(raw);
      if (deployment.draining) {
        return socket.emit(serverSocketEvents.error, {
          message: "This server is draining for a deployment. Refresh and try again in a moment."
        });
      }
      if (!session.profile) return socket.emit(serverSocketEvents.error, { message: "Profile required" });
      if (session.activeEncounterId) return;

      queue.set(session.id, { sessionId: session.id, matchMode: payload.matchMode, joinedAt: Date.now() });
      socket.emit(serverSocketEvents.queueWaiting, { matchMode: payload.matchMode, fallbackAfterMs });
      await store.recordMetric("queue_join", { sessionId: session.id, matchMode: payload.matchMode });
      await attemptMatch(io, store, sessions, queue, encounters, session.id);
    });

    socket.on(clientSocketEvents.queueLeave, () => {
      queue.delete(session.id);
    });

    socket.on(clientSocketEvents.swipeSubmit, async (raw) => {
      const payload = swipeSubmitPayloadSchema.parse(raw);
      const encounter = encounters.get(payload.encounterId);
      if (!encounter || !encounter.sessionIds.includes(session.id) || encounter.state !== "presented") return;

      encounter.swipes[session.id] = payload.decision;
      await store.recordMetric(payload.decision === "right" ? "swipe_right" : "swipe_left", {
        sessionId: session.id,
        encounterId: encounter.id
      });

      if (payload.decision === "left") {
        endEncounter(io, encounters, sessions, encounter.id, "left_swipe");
        return;
      }

      const [a, b] = encounter.sessionIds;
      if (encounter.swipes[a] === "right" && encounter.swipes[b] === "right") {
        encounter.state = "matched";
        encounter.roomId = randomUUID();
        await store.recordMetric("mutual_match", { encounterId: encounter.id });
        await store.recordMetric("call_start", { encounterId: encounter.id });
        emitToSession(io, sessions, a, serverSocketEvents.matchCreated, {
          encounterId: encounter.id,
          roomId: encounter.roomId,
          role: "initiator",
          iceServers
        });
        emitToSession(io, sessions, b, serverSocketEvents.matchCreated, {
          encounterId: encounter.id,
          roomId: encounter.roomId,
          role: "receiver",
          iceServers
        });
      }
    });

    socket.on(clientSocketEvents.signalOffer, (raw) => relaySignal(io, sessions, encounters, session.id, signalOfferPayloadSchema.parse(raw), serverSocketEvents.signalOffer));
    socket.on(clientSocketEvents.signalAnswer, (raw) => relaySignal(io, sessions, encounters, session.id, signalAnswerPayloadSchema.parse(raw), serverSocketEvents.signalAnswer));
    socket.on(clientSocketEvents.signalIce, (raw) => relaySignal(io, sessions, encounters, session.id, signalIcePayloadSchema.parse(raw), serverSocketEvents.signalIce));

    socket.on(clientSocketEvents.callReady, (raw) => {
      const payload = callReadyPayloadSchema.parse(raw);
      const encounter = encounters.get(payload.encounterId);
      if (!encounter || encounter.state !== "matched" || !encounter.sessionIds.includes(session.id)) return;
      encounter.readySessionIds ??= new Set();
      encounter.readySessionIds.add(session.id);
      if (encounter.sessionIds.every((sessionId) => encounter.readySessionIds?.has(sessionId))) {
        for (const sessionId of encounter.sessionIds) {
          emitToSession(io, sessions, sessionId, serverSocketEvents.callReady, { encounterId: encounter.id });
        }
      }
    });

    socket.on(clientSocketEvents.callEnd, async (raw) => {
      const payload = callEndPayloadSchema.parse(raw);
      await store.recordMetric(payload.reason === "ice_failed" ? "ice_failure" : "call_end", {
        sessionId: session.id,
        encounterId: payload.encounterId
      });
      if (payload.reason === "ice_failed") {
        const otherId = otherSessionId(encounters.get(payload.encounterId), session.id);
        if (otherId) emitToSession(io, sessions, otherId, serverSocketEvents.callFailed, { encounterId: payload.encounterId });
      }
      endEncounter(io, encounters, sessions, payload.encounterId, payload.reason);
    });

    socket.on("disconnect", () => {
      if (session.socketId !== socket.id) return;
      session.socketId = undefined;
      session.disconnectTimer = setTimeout(() => {
        if (session.socketId) return;
        queue.delete(session.id);
        session.disconnectTimer = undefined;
        endEncounter(io, encounters, sessions, session.activeEncounterId, "disconnected");
      }, disconnectGraceMs);
    });
  });

  app.addHook("onReady", async () => {
    await store.init();
  });

  app.addHook("onClose", async () => {
    await store.close();
  });

  return app;
}

async function attemptMatch(
  io: Server,
  store: ReturnType<typeof createStore>,
  sessions: Map<string, SessionRecord>,
  queue: Map<string, QueueEntry>,
  encounters: Map<string, EncounterRecord>,
  sessionId: string
) {
  const entry = queue.get(sessionId);
  const session = sessions.get(sessionId);
  if (!entry || !session?.profile) return;

  for (const [queuedSessionId] of queue) {
    if (!sessions.get(queuedSessionId)?.socketId) queue.delete(queuedSessionId);
  }

  const profiles = new Map<string, PublicGuestProfile>();
  const blocks = new Map<string, Set<string>>();
  for (const liveSession of sessions.values()) {
    if (liveSession.profile && liveSession.socketId) profiles.set(liveSession.id, { sessionId: liveSession.id, ...liveSession.profile });
    blocks.set(liveSession.id, liveSession.blockedSessionIds);
  }

  const partner = pickPartner(entry, [...queue.values()], profiles, blocks);
  if (!partner) return;

  queue.delete(entry.sessionId);
  queue.delete(partner.sessionId);

  const encounter: EncounterRecord = {
    id: randomUUID(),
    sessionIds: [entry.sessionId, partner.sessionId],
    matchMode: entry.matchMode,
    state: "presented",
    swipes: {},
    createdAt: Date.now()
  };
  encounters.set(encounter.id, encounter);
  sessions.get(entry.sessionId)!.activeEncounterId = encounter.id;
  sessions.get(partner.sessionId)!.activeEncounterId = encounter.id;

  await store.recordMetric("pair_presented", { encounterId: encounter.id, matchMode: encounter.matchMode });

  emitToSession(io, sessions, entry.sessionId, serverSocketEvents.encounterPresented, {
    encounterId: encounter.id,
    counterpart: profiles.get(partner.sessionId),
    matchMode: encounter.matchMode
  });
  emitToSession(io, sessions, partner.sessionId, serverSocketEvents.encounterPresented, {
    encounterId: encounter.id,
    counterpart: profiles.get(entry.sessionId),
    matchMode: encounter.matchMode
  });
}

function requireSession(header: string | string[] | undefined, sessions: Map<string, SessionRecord>) {
  return typeof header === "string" ? sessions.get(header) : undefined;
}

function emitToSession(io: Server, sessions: Map<string, SessionRecord>, sessionId: string, event: string, payload: unknown) {
  const socketId = sessions.get(sessionId)?.socketId;
  if (socketId) io.to(socketId).emit(event, payload);
}

function relaySignal(
  io: Server,
  sessions: Map<string, SessionRecord>,
  encounters: Map<string, EncounterRecord>,
  senderId: string,
  payload: { encounterId: string },
  event: string
) {
  const encounter = encounters.get(payload.encounterId);
  if (!encounter || encounter.state !== "matched") return;
  const targetId = otherSessionId(encounter, senderId);
  if (targetId) emitToSession(io, sessions, targetId, event, payload);
}

function otherSessionId(encounter: EncounterRecord | undefined, sessionId: string) {
  if (!encounter?.sessionIds.includes(sessionId)) return undefined;
  return encounter.sessionIds[0] === sessionId ? encounter.sessionIds[1] : encounter.sessionIds[0];
}

function endEncounter(
  io: Server,
  encounters: Map<string, EncounterRecord>,
  sessions: Map<string, SessionRecord>,
  encounterId: string | undefined,
  reason: "left_swipe" | "hangup" | "blocked" | "disconnected" | "ice_failed"
) {
  if (!encounterId) return;
  const encounter = encounters.get(encounterId);
  if (!encounter || encounter.state === "ended") return;
  encounter.state = "ended";
  for (const sessionId of encounter.sessionIds) {
    const session = sessions.get(sessionId);
    if (session?.activeEncounterId === encounterId) session.activeEncounterId = undefined;
    emitToSession(io, sessions, sessionId, serverSocketEvents.encounterEnded, { encounterId, reason });
  }
}
