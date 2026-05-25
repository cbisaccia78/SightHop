import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import { Pool } from "pg";
import type { MetricName, ModerationPayload } from "@sighthop/shared";

export type Store = {
  init(): Promise<void>;
  close(): Promise<void>;
  recordMetric(name: MetricName, metadata?: Record<string, unknown>): Promise<void>;
  saveReport(sessionId: string, payload: ModerationPayload): Promise<void>;
  saveBlock(sessionId: string, payload: ModerationPayload): Promise<void>;
  health(): Promise<{ postgres: boolean; redis: boolean }>;
};

export function createStore(logger: FastifyBaseLogger): Store {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
  const redis = redisUrl ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : undefined;

  return {
    async init() {
      if (pool) {
        await pool.query(`
          create table if not exists reports (
            id uuid primary key,
            reporter_session_id uuid not null,
            target_session_id uuid not null,
            encounter_id uuid,
            reason text,
            details text,
            created_at timestamptz not null default now()
          );
          create table if not exists blocks (
            id uuid primary key,
            blocker_session_id uuid not null,
            target_session_id uuid not null,
            encounter_id uuid,
            created_at timestamptz not null default now()
          );
          create table if not exists metrics (
            id uuid primary key,
            name text not null,
            metadata jsonb not null default '{}',
            created_at timestamptz not null default now()
          );
        `);
      }

      if (redis) {
        try {
          await redis.connect();
        } catch (error) {
          logger.warn({ error }, "Redis unavailable; continuing with in-process live state");
        }
      }
    },

    async close() {
      await Promise.allSettled([pool?.end(), redis?.quit()]);
    },

    async recordMetric(name, metadata = {}) {
      if (!pool) return;
      await pool.query("insert into metrics (id, name, metadata) values ($1, $2, $3)", [
        randomUUID(),
        name,
        JSON.stringify(metadata)
      ]);
    },

    async saveReport(sessionId, payload) {
      if (!pool) return;
      await pool.query(
        "insert into reports (id, reporter_session_id, target_session_id, encounter_id, reason, details) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), sessionId, payload.targetSessionId, payload.encounterId ?? null, payload.reason ?? null, payload.details ?? null]
      );
    },

    async saveBlock(sessionId, payload) {
      if (!pool) return;
      await pool.query(
        "insert into blocks (id, blocker_session_id, target_session_id, encounter_id) values ($1, $2, $3, $4)",
        [randomUUID(), sessionId, payload.targetSessionId, payload.encounterId ?? null]
      );
    },

    async health() {
      const [postgres, redisHealth] = await Promise.allSettled([
        pool?.query("select 1"),
        redis?.ping()
      ]);
      return {
        postgres: !pool || postgres.status === "fulfilled",
        redis: !redis || redisHealth.status === "fulfilled"
      };
    }
  };
}
