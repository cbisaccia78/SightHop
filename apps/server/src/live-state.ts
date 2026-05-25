import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type { GuestProfile, MatchMode, PublicGuestProfile, SwipeDecision } from "@sighthop/shared";
import { pickPartner } from "./matchmaking.js";
import type { EncounterRecord, QueueEntry, SessionRecord } from "./types.js";

const defaultKeyPrefix = "sighthop";
const defaultPresenceTtlSeconds = 30;
const matchmakingLockTtlMs = 5_000;

export type SessionPresence = {
  sessionId: string;
  socketId: string;
  instanceId: string;
  releaseName: string;
  updatedAt: number;
};

export type LiveStateMessage =
  | {
      type: "emit";
      targetInstanceId: string;
      sessionId: string;
      event: string;
      payload: unknown;
    }
  | {
      type: "disconnect";
      targetInstanceId: string;
      sessionId: string;
      socketId: string;
    };

export type MatchResult = {
  encounter: EncounterRecord;
  counterpartProfiles: Record<string, PublicGuestProfile | undefined>;
};

export type SwipeResult =
  | { type: "ignored" }
  | { type: "pending"; encounter: EncounterRecord }
  | { type: "ended"; encounter: EncounterRecord }
  | { type: "matched"; encounter: EncounterRecord };

export type LiveState = {
  init(): Promise<void>;
  close(): Promise<void>;
  onMessage(handler: (message: LiveStateMessage) => void): void;
  createSession(): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  updateProfile(sessionId: string, profile: GuestProfile): Promise<boolean>;
  addBlock(sessionId: string, targetSessionId: string): Promise<boolean>;
  getPresence(sessionId: string): Promise<SessionPresence | undefined>;
  setPresence(presence: SessionPresence): Promise<SessionPresence | undefined>;
  refreshPresence(sessionId: string, socketId: string, instanceId: string): Promise<void>;
  clearPresence(sessionId: string, socketId: string, instanceId: string): Promise<boolean>;
  joinQueue(sessionId: string, matchMode: MatchMode): Promise<void>;
  leaveQueue(sessionId: string): Promise<void>;
  attemptMatch(sessionId: string): Promise<MatchResult | undefined>;
  getEncounter(encounterId: string): Promise<EncounterRecord | undefined>;
  applySwipe(sessionId: string, encounterId: string, decision: SwipeDecision): Promise<SwipeResult>;
  markCallReady(sessionId: string, encounterId: string): Promise<string[] | undefined>;
  endEncounter(encounterId: string | undefined): Promise<EncounterRecord | undefined>;
  getDeploymentCounts(releaseName: string): Promise<{ queueSize: number; activeEncounterCount: number }>;
  publishMessage(message: LiveStateMessage): Promise<void>;
};

type RedisLiveStateOptions = {
  logger: FastifyBaseLogger;
  redisUrl?: string;
  instanceId: string;
  keyPrefix?: string;
  presenceTtlSeconds?: number;
  redisFactory?: () => Redis;
};

const memoryBuses = new Map<string, EventEmitter>();

export function createLiveState(options: RedisLiveStateOptions): LiveState {
  if (options.redisUrl || options.redisFactory) {
    return new RedisLiveState(options);
  }
  return new MemoryLiveState(options);
}

class MemoryLiveState implements LiveState {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly queue = new Map<string, QueueEntry>();
  private readonly encounters = new Map<string, EncounterRecord>();
  private readonly presence = new Map<string, SessionPresence>();
  private readonly listeners = new Set<(message: LiveStateMessage) => void>();
  private readonly bus: EventEmitter;
  private readonly keyPrefix: string;

  constructor(private readonly options: RedisLiveStateOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.bus = memoryBuses.get(this.keyPrefix) ?? new EventEmitter();
    memoryBuses.set(this.keyPrefix, this.bus);
  }

  async init() {
    this.bus.on("message", this.handleMessage);
  }

  async close() {
    this.bus.off("message", this.handleMessage);
    this.listeners.clear();
  }

  onMessage(handler: (message: LiveStateMessage) => void) {
    this.listeners.add(handler);
  }

  async createSession() {
    const session: SessionRecord = { id: randomUUID(), blockedSessionIds: new Set() };
    this.sessions.set(session.id, session);
    return cloneSession(session)!;
  }

  async getSession(sessionId: string) {
    return cloneSession(this.sessions.get(sessionId));
  }

  async updateProfile(sessionId: string, profile: GuestProfile) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.profile = profile;
    return true;
  }

  async addBlock(sessionId: string, targetSessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.blockedSessionIds.add(targetSessionId);
    return true;
  }

  async getPresence(sessionId: string) {
    const presence = this.presence.get(sessionId);
    return presence ? { ...presence } : undefined;
  }

  async setPresence(presence: SessionPresence) {
    const previous = this.presence.get(presence.sessionId);
    const session = this.sessions.get(presence.sessionId);
    if (session) {
      session.lastReleaseName = presence.releaseName;
    }
    this.presence.set(presence.sessionId, { ...presence });
    return previous ? { ...previous } : undefined;
  }

  async refreshPresence(sessionId: string, socketId: string, instanceId: string) {
    const presence = this.presence.get(sessionId);
    if (!presence || presence.socketId !== socketId || presence.instanceId !== instanceId) return;
    presence.updatedAt = Date.now();
  }

  async clearPresence(sessionId: string, socketId: string, instanceId: string) {
    const presence = this.presence.get(sessionId);
    if (!presence || presence.socketId !== socketId || presence.instanceId !== instanceId) return false;
    this.presence.delete(sessionId);
    return true;
  }

  async joinQueue(sessionId: string, matchMode: MatchMode) {
    this.queue.set(sessionId, { sessionId, matchMode, joinedAt: Date.now() });
  }

  async leaveQueue(sessionId: string) {
    this.queue.delete(sessionId);
  }

  async attemptMatch(sessionId: string) {
    const entry = this.queue.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!entry || !session?.profile || session.activeEncounterId || !this.presence.has(sessionId)) return undefined;

    const queueEntries = [...this.queue.values()].filter((candidate) => this.presence.has(candidate.sessionId));
    const profiles = new Map<string, PublicGuestProfile>();
    const blocks = new Map<string, Set<string>>();
    for (const candidate of queueEntries) {
      const queuedSession = this.sessions.get(candidate.sessionId);
      if (queuedSession?.profile) {
        profiles.set(candidate.sessionId, toPublicProfile(queuedSession));
      }
      if (queuedSession) {
        blocks.set(candidate.sessionId, new Set(queuedSession.blockedSessionIds));
      }
    }

    const partner = pickPartner(entry, queueEntries, profiles, blocks);
    if (!partner) return undefined;

    const partnerSession = this.sessions.get(partner.sessionId);
    if (!partnerSession?.profile || partnerSession.activeEncounterId || !this.presence.has(partner.sessionId)) return undefined;

    this.queue.delete(sessionId);
    this.queue.delete(partner.sessionId);

    const encounter: EncounterRecord = {
      id: randomUUID(),
      sessionIds: [sessionId, partner.sessionId],
      matchMode: entry.matchMode,
      state: "presented",
      swipes: {},
      createdAt: Date.now()
    };
    this.encounters.set(encounter.id, encounter);
    session.activeEncounterId = encounter.id;
    partnerSession.activeEncounterId = encounter.id;

    return {
      encounter: cloneEncounter(encounter)!,
      counterpartProfiles: {
        [sessionId]: profiles.get(partner.sessionId),
        [partner.sessionId]: profiles.get(sessionId)
      }
    };
  }

  async getEncounter(encounterId: string) {
    return cloneEncounter(this.encounters.get(encounterId));
  }

  async applySwipe(sessionId: string, encounterId: string, decision: SwipeDecision) {
    const encounter = this.encounters.get(encounterId);
    if (!encounter || encounter.state !== "presented" || !encounter.sessionIds.includes(sessionId)) {
      return { type: "ignored" as const };
    }

    encounter.swipes[sessionId] = decision;
    if (decision === "left") {
      const ended = await this.endEncounter(encounterId);
      return ended ? { type: "ended" as const, encounter: ended } : { type: "ignored" as const };
    }

    const [a, b] = encounter.sessionIds;
    if (encounter.swipes[a] === "right" && encounter.swipes[b] === "right") {
      encounter.state = "matched";
      encounter.roomId = randomUUID();
      return { type: "matched" as const, encounter: cloneEncounter(encounter)! };
    }

    return { type: "pending" as const, encounter: cloneEncounter(encounter)! };
  }

  async markCallReady(sessionId: string, encounterId: string) {
    const encounter = this.encounters.get(encounterId);
    if (!encounter || encounter.state !== "matched" || !encounter.sessionIds.includes(sessionId)) return undefined;
    encounter.readySessionIds ??= new Set();
    encounter.readySessionIds.add(sessionId);
    return encounter.sessionIds.every((candidate) => encounter.readySessionIds?.has(candidate)) ? [...encounter.sessionIds] : undefined;
  }

  async endEncounter(encounterId: string | undefined) {
    if (!encounterId) return undefined;
    const encounter = this.encounters.get(encounterId);
    if (!encounter || encounter.state === "ended") return cloneEncounter(encounter);
    encounter.state = "ended";
    for (const sessionId of encounter.sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session?.activeEncounterId === encounterId) session.activeEncounterId = undefined;
    }
    return cloneEncounter(encounter);
  }

  async getDeploymentCounts(releaseName: string) {
    let queueSize = 0;
    for (const entry of this.queue.values()) {
      const session = this.sessions.get(entry.sessionId);
      if (session?.lastReleaseName === releaseName) queueSize += 1;
    }

    let activeEncounterCount = 0;
    for (const encounter of this.encounters.values()) {
      if (encounter.state === "ended") continue;
      const relevant = await Promise.all(encounter.sessionIds.map(async (sessionId) => this.getSession(sessionId)));
      if (relevant.some((session) => session?.lastReleaseName === releaseName)) {
        activeEncounterCount += 1;
      }
    }

    return { queueSize, activeEncounterCount };
  }

  async publishMessage(message: LiveStateMessage) {
    this.bus.emit("message", message);
  }

  private readonly handleMessage = (message: LiveStateMessage) => {
    for (const listener of this.listeners) {
      listener(message);
    }
  };
}

class RedisLiveState implements LiveState {
  private readonly keyPrefix: string;
  private readonly presenceTtlSeconds: number;
  private readonly client: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(message: LiveStateMessage) => void>();

  constructor(private readonly options: RedisLiveStateOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.presenceTtlSeconds = options.presenceTtlSeconds ?? defaultPresenceTtlSeconds;
    this.client = options.redisFactory?.() ?? new Redis(options.redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.subscriber = options.redisFactory?.() ?? new Redis(options.redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  async init() {
    await Promise.all([ensureRedisConnected(this.client), ensureRedisConnected(this.subscriber)]);
    await this.subscriber.subscribe(this.channelKey());
    this.subscriber.on("message", this.handleMessage);
  }

  async close() {
    this.subscriber.off("message", this.handleMessage);
    await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);
    this.listeners.clear();
  }

  onMessage(handler: (message: LiveStateMessage) => void) {
    this.listeners.add(handler);
  }

  async createSession() {
    const session: SessionRecord = { id: randomUUID(), blockedSessionIds: new Set() };
    await this.setJson(this.sessionKey(session.id), serializeSession(session));
    return session;
  }

  async getSession(sessionId: string) {
    return this.readSession(sessionId);
  }

  async updateProfile(sessionId: string, profile: GuestProfile) {
    const session = await this.readSession(sessionId);
    if (!session) return false;
    session.profile = profile;
    await this.setJson(this.sessionKey(sessionId), serializeSession(session));
    return true;
  }

  async addBlock(sessionId: string, targetSessionId: string) {
    const session = await this.readSession(sessionId);
    if (!session) return false;
    session.blockedSessionIds.add(targetSessionId);
    await this.setJson(this.sessionKey(sessionId), serializeSession(session));
    return true;
  }

  async getPresence(sessionId: string) {
    return this.getJson<SessionPresence>(this.presenceKey(sessionId));
  }

  async setPresence(presence: SessionPresence) {
    const previous = await this.getPresence(presence.sessionId);
    const session = await this.readSession(presence.sessionId);
    if (session) {
      session.lastReleaseName = presence.releaseName;
      await this.setJson(this.sessionKey(presence.sessionId), serializeSession(session));
    }
    await this.client.set(this.presenceKey(presence.sessionId), JSON.stringify(presence), "EX", this.presenceTtlSeconds);
    return previous;
  }

  async refreshPresence(sessionId: string, socketId: string, instanceId: string) {
    const presence = await this.getPresence(sessionId);
    if (!presence || presence.socketId !== socketId || presence.instanceId !== instanceId) return;
    presence.updatedAt = Date.now();
    await this.client.set(this.presenceKey(sessionId), JSON.stringify(presence), "EX", this.presenceTtlSeconds);
  }

  async clearPresence(sessionId: string, socketId: string, instanceId: string) {
    const presence = await this.getPresence(sessionId);
    if (!presence || presence.socketId !== socketId || presence.instanceId !== instanceId) return false;
    await this.client.del(this.presenceKey(sessionId));
    return true;
  }

  async joinQueue(sessionId: string, matchMode: MatchMode) {
    const entry: QueueEntry = { sessionId, matchMode, joinedAt: Date.now() };
    await this.setJson(this.queueEntryKey(sessionId), entry);
    await this.client.zadd(this.queueKey(), String(entry.joinedAt), sessionId);
  }

  async leaveQueue(sessionId: string) {
    await Promise.all([this.client.zrem(this.queueKey(), sessionId), this.client.del(this.queueEntryKey(sessionId))]);
  }

  async attemptMatch(sessionId: string) {
    const lockId = randomUUID();
    const acquired = await this.client.set(this.matchLockKey(), lockId, "PX", matchmakingLockTtlMs, "NX");
    if (acquired !== "OK") return undefined;

    try {
      const entry = await this.readQueueEntry(sessionId);
      const session = await this.readSession(sessionId);
      const presence = await this.getPresence(sessionId);
      if (!entry || !session?.profile || session.activeEncounterId || !presence) return undefined;

      const queueEntries = await this.readQueueEntries();
      const liveQueueEntries = new Array<QueueEntry>();
      const profiles = new Map<string, PublicGuestProfile>();
      const blocks = new Map<string, Set<string>>();

      for (const candidate of queueEntries) {
        const [candidateSession, candidatePresence] = await Promise.all([
          this.readSession(candidate.sessionId),
          this.getPresence(candidate.sessionId)
        ]);
        if (!candidateSession || !candidatePresence || candidateSession.activeEncounterId) continue;
        liveQueueEntries.push(candidate);
        if (candidateSession.profile) {
          profiles.set(candidate.sessionId, toPublicProfile(candidateSession));
        }
        blocks.set(candidate.sessionId, new Set(candidateSession.blockedSessionIds));
      }

      const partner = pickPartner(entry, liveQueueEntries, profiles, blocks);
      if (!partner) return undefined;

      const partnerSession = await this.readSession(partner.sessionId);
      if (!partnerSession?.profile || partnerSession.activeEncounterId) return undefined;

      const encounter: EncounterRecord = {
        id: randomUUID(),
        sessionIds: [sessionId, partner.sessionId],
        matchMode: entry.matchMode,
        state: "presented",
        swipes: {},
        createdAt: Date.now()
      };

      session.activeEncounterId = encounter.id;
      partnerSession.activeEncounterId = encounter.id;

      await Promise.all([
        this.leaveQueue(sessionId),
        this.leaveQueue(partner.sessionId),
        this.setJson(this.encounterKey(encounter.id), serializeEncounter(encounter)),
        this.client.zadd(this.activeEncounterKey(), String(encounter.createdAt), encounter.id),
        this.setJson(this.sessionKey(sessionId), serializeSession(session)),
        this.setJson(this.sessionKey(partner.sessionId), serializeSession(partnerSession))
      ]);

      return {
        encounter,
        counterpartProfiles: {
          [sessionId]: profiles.get(partner.sessionId),
          [partner.sessionId]: profiles.get(sessionId)
        }
      };
    } finally {
      const currentLockId = await this.client.get(this.matchLockKey());
      if (currentLockId === lockId) {
        await this.client.del(this.matchLockKey());
      }
    }
  }

  async getEncounter(encounterId: string) {
    return this.readEncounter(encounterId);
  }

  async applySwipe(sessionId: string, encounterId: string, decision: SwipeDecision) {
    const encounter = await this.readEncounter(encounterId);
    if (!encounter || encounter.state !== "presented" || !encounter.sessionIds.includes(sessionId)) {
      return { type: "ignored" as const };
    }

    encounter.swipes[sessionId] = decision;
    if (decision === "left") {
      const ended = await this.endEncounter(encounterId);
      return ended ? { type: "ended" as const, encounter: ended } : { type: "ignored" as const };
    }

    const [a, b] = encounter.sessionIds;
    if (encounter.swipes[a] === "right" && encounter.swipes[b] === "right") {
      encounter.state = "matched";
      encounter.roomId = randomUUID();
      await this.setJson(this.encounterKey(encounter.id), serializeEncounter(encounter));
      return { type: "matched" as const, encounter };
    }

    await this.setJson(this.encounterKey(encounter.id), serializeEncounter(encounter));
    return { type: "pending" as const, encounter };
  }

  async markCallReady(sessionId: string, encounterId: string) {
    const encounter = await this.readEncounter(encounterId);
    if (!encounter || encounter.state !== "matched" || !encounter.sessionIds.includes(sessionId)) return undefined;
    encounter.readySessionIds ??= new Set();
    encounter.readySessionIds.add(sessionId);
    await this.setJson(this.encounterKey(encounter.id), serializeEncounter(encounter));
    return encounter.sessionIds.every((candidate) => encounter.readySessionIds?.has(candidate)) ? [...encounter.sessionIds] : undefined;
  }

  async endEncounter(encounterId: string | undefined) {
    if (!encounterId) return undefined;
    const encounter = await this.readEncounter(encounterId);
    if (!encounter || encounter.state === "ended") return encounter;

    encounter.state = "ended";
    const sessions = await Promise.all(encounter.sessionIds.map(async (sessionId) => this.readSession(sessionId)));
    for (const session of sessions) {
      if (session?.activeEncounterId === encounterId) {
        session.activeEncounterId = undefined;
      }
    }

    await Promise.all([
      this.setJson(this.encounterKey(encounter.id), serializeEncounter(encounter)),
      this.client.zrem(this.activeEncounterKey(), encounter.id),
      ...sessions
        .filter((session): session is SessionRecord => Boolean(session))
        .map((session) => this.setJson(this.sessionKey(session.id), serializeSession(session)))
    ]);
    return encounter;
  }

  async getDeploymentCounts(releaseName: string) {
    const queueEntries = await this.readQueueEntries();
    let queueSize = 0;
    for (const entry of queueEntries) {
      const session = await this.readSession(entry.sessionId);
      if (session?.lastReleaseName === releaseName) {
        queueSize += 1;
      }
    }

    const encounterIds = await this.client.zrange(this.activeEncounterKey(), 0, -1);
    let activeEncounterCount = 0;
    for (const encounterId of encounterIds) {
      const encounter = await this.readEncounter(encounterId);
      if (!encounter || encounter.state === "ended") continue;
      const sessions = await Promise.all(encounter.sessionIds.map(async (sessionId) => this.readSession(sessionId)));
      if (sessions.some((session) => session?.lastReleaseName === releaseName)) {
        activeEncounterCount += 1;
      }
    }

    return { queueSize, activeEncounterCount };
  }

  async publishMessage(message: LiveStateMessage) {
    await this.client.publish(this.channelKey(), JSON.stringify(message));
  }

  private async readSession(sessionId: string) {
    const value = await this.getJson<SerializedSession>(this.sessionKey(sessionId));
    return deserializeSession(value);
  }

  private async readQueueEntry(sessionId: string) {
    return this.getJson<QueueEntry>(this.queueEntryKey(sessionId));
  }

  private async readQueueEntries() {
    const sessionIds = await this.client.zrange(this.queueKey(), 0, -1);
    if (!sessionIds.length) return [] as QueueEntry[];
    const values = await this.client.mget(sessionIds.map((sessionId) => this.queueEntryKey(sessionId)));
    return values
      .map((value) => parseJson<QueueEntry>(value))
      .filter((entry): entry is QueueEntry => Boolean(entry));
  }

  private async readEncounter(encounterId: string) {
    const value = await this.getJson<SerializedEncounter>(this.encounterKey(encounterId));
    return deserializeEncounter(value);
  }

  private async getJson<T>(key: string) {
    const value = await this.client.get(key);
    return parseJson<T>(value);
  }

  private async setJson(key: string, value: unknown) {
    await this.client.set(key, JSON.stringify(value));
  }

  private readonly handleMessage = (_channel: string, payload: string) => {
    const message = parseJson<LiveStateMessage>(payload);
    if (!message) return;
    for (const listener of this.listeners) {
      listener(message);
    }
  };

  private sessionKey(sessionId: string) {
    return `${this.keyPrefix}:session:${sessionId}`;
  }

  private presenceKey(sessionId: string) {
    return `${this.keyPrefix}:presence:${sessionId}`;
  }

  private queueKey() {
    return `${this.keyPrefix}:queue`;
  }

  private queueEntryKey(sessionId: string) {
    return `${this.keyPrefix}:queue:${sessionId}`;
  }

  private encounterKey(encounterId: string) {
    return `${this.keyPrefix}:encounter:${encounterId}`;
  }

  private activeEncounterKey() {
    return `${this.keyPrefix}:encounters:active`;
  }

  private matchLockKey() {
    return `${this.keyPrefix}:matchmaking:lock`;
  }

  private channelKey() {
    return `${this.keyPrefix}:events`;
  }
}

type SerializedSession = Omit<SessionRecord, "blockedSessionIds"> & {
  blockedSessionIds: string[];
};

type SerializedEncounter = Omit<EncounterRecord, "readySessionIds"> & {
  readySessionIds?: string[];
};

function serializeSession(session: SessionRecord): SerializedSession {
  return {
    ...session,
    blockedSessionIds: [...session.blockedSessionIds]
  };
}

function deserializeSession(session: SerializedSession | undefined): SessionRecord | undefined {
  if (!session) return undefined;
  return {
    ...session,
    blockedSessionIds: new Set(session.blockedSessionIds)
  };
}

function serializeEncounter(encounter: EncounterRecord): SerializedEncounter {
  return {
    ...encounter,
    readySessionIds: encounter.readySessionIds ? [...encounter.readySessionIds] : undefined
  };
}

function deserializeEncounter(encounter: SerializedEncounter | undefined): EncounterRecord | undefined {
  if (!encounter) return undefined;
  return {
    ...encounter,
    readySessionIds: encounter.readySessionIds ? new Set(encounter.readySessionIds) : undefined
  };
}

function cloneSession(session: SessionRecord | undefined) {
  return session ? deserializeSession(serializeSession(session)) : undefined;
}

function cloneEncounter(encounter: EncounterRecord | undefined) {
  return encounter ? deserializeEncounter(serializeEncounter(encounter)) : undefined;
}

function toPublicProfile(session: SessionRecord): PublicGuestProfile {
  if (!session.profile) {
    throw new Error(`Session ${session.id} is missing a profile`);
  }
  return {
    sessionId: session.id,
    ...session.profile
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

async function ensureRedisConnected(redis: Redis) {
  try {
    await redis.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("already connecting/connected")) {
      throw error;
    }
  }
}