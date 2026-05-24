import { z } from "zod";

export const matchModeSchema = z.enum(["location", "preferences", "random"]);
export type MatchMode = z.infer<typeof matchModeSchema>;

export const swipeDecisionSchema = z.enum(["left", "right"]);
export type SwipeDecision = z.infer<typeof swipeDecisionSchema>;

export const encounterStateSchema = z.enum(["waiting", "presented", "matched", "ended"]);
export type EncounterState = z.infer<typeof encounterStateSchema>;

export const reportReasonSchema = z.enum([
  "harassment",
  "nudity_sexual_content",
  "underage_concern",
  "spam",
  "other"
]);
export type ReportReason = z.infer<typeof reportReasonSchema>;

export const guestProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  photoUrl: z.string().trim().min(1).max(2_000_000),
  bio: z.string().trim().max(240),
  cityRegion: z.string().trim().max(80).optional().default(""),
  interestTags: z.array(z.string().trim().min(1).max(24)).max(8).default([])
});
export type GuestProfile = z.infer<typeof guestProfileSchema>;

export const publicGuestProfileSchema = guestProfileSchema.extend({
  sessionId: z.string().uuid()
});
export type PublicGuestProfile = z.infer<typeof publicGuestProfileSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().uuid()
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const queueJoinPayloadSchema = z.object({
  matchMode: matchModeSchema
});
export type QueueJoinPayload = z.infer<typeof queueJoinPayloadSchema>;

export const queueWaitingPayloadSchema = z.object({
  matchMode: matchModeSchema,
  fallbackAfterMs: z.number().int().positive()
});
export type QueueWaitingPayload = z.infer<typeof queueWaitingPayloadSchema>;

export const encounterPresentedPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  counterpart: publicGuestProfileSchema,
  matchMode: matchModeSchema
});
export type EncounterPresentedPayload = z.infer<typeof encounterPresentedPayloadSchema>;

export const swipeSubmitPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  decision: swipeDecisionSchema
});
export type SwipeSubmitPayload = z.infer<typeof swipeSubmitPayloadSchema>;

export const encounterEndedPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  reason: z.enum(["left_swipe", "hangup", "blocked", "disconnected", "ice_failed"])
});
export type EncounterEndedPayload = z.infer<typeof encounterEndedPayloadSchema>;

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional()
});

export const matchCreatedPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  roomId: z.string().uuid(),
  role: z.enum(["initiator", "receiver"]),
  iceServers: z.array(iceServerSchema)
});
export type MatchCreatedPayload = z.infer<typeof matchCreatedPayloadSchema>;

export const signalOfferPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  description: z.any()
});
export type SignalOfferPayload = z.infer<typeof signalOfferPayloadSchema>;

export const signalAnswerPayloadSchema = signalOfferPayloadSchema;
export type SignalAnswerPayload = SignalOfferPayload;

export const signalIcePayloadSchema = z.object({
  encounterId: z.string().uuid(),
  candidate: z.any()
});
export type SignalIcePayload = z.infer<typeof signalIcePayloadSchema>;

export const callEndPayloadSchema = z.object({
  encounterId: z.string().uuid(),
  reason: z.enum(["hangup", "ice_failed"]).default("hangup")
});
export type CallEndPayload = z.infer<typeof callEndPayloadSchema>;

export const callReadyPayloadSchema = z.object({
  encounterId: z.string().uuid()
});
export type CallReadyPayload = z.infer<typeof callReadyPayloadSchema>;

export const moderationPayloadSchema = z.object({
  targetSessionId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  reason: reportReasonSchema.optional(),
  details: z.string().trim().max(500).optional()
});
export type ModerationPayload = z.infer<typeof moderationPayloadSchema>;

export const clientSocketEvents = {
  queueJoin: "queue:join",
  queueLeave: "queue:leave",
  swipeSubmit: "swipe:submit",
  signalOffer: "signal:offer",
  signalAnswer: "signal:answer",
  signalIce: "signal:ice",
  callReady: "call:ready",
  callEnd: "call:end"
} as const;

export const serverSocketEvents = {
  queueWaiting: "queue:waiting",
  encounterPresented: "encounter:presented",
  encounterEnded: "encounter:ended",
  matchCreated: "match:created",
  signalOffer: "signal:offer",
  signalAnswer: "signal:answer",
  signalIce: "signal:ice",
  callReady: "call:ready",
  callFailed: "call:failed",
  error: "error"
} as const;

export type MetricName =
  | "queue_join"
  | "pair_presented"
  | "swipe_left"
  | "swipe_right"
  | "mutual_match"
  | "call_start"
  | "ice_failure"
  | "call_end"
  | "report"
  | "block";
