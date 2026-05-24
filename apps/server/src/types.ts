import type { GuestProfile, MatchMode, SwipeDecision } from "@localchat/shared";

export type SessionRecord = {
  id: string;
  profile?: GuestProfile;
  socketId?: string;
  disconnectTimer?: NodeJS.Timeout;
  blockedSessionIds: Set<string>;
  activeEncounterId?: string;
};

export type QueueEntry = {
  sessionId: string;
  matchMode: MatchMode;
  joinedAt: number;
};

export type EncounterRecord = {
  id: string;
  roomId?: string;
  sessionIds: [string, string];
  matchMode: MatchMode;
  state: "presented" | "matched" | "ended";
  swipes: Partial<Record<string, SwipeDecision>>;
  readySessionIds?: Set<string>;
  createdAt: number;
};
