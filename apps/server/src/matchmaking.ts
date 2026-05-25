import type { PublicGuestProfile } from "@sighthop/shared";
import type { QueueEntry } from "./types.js";

type ProfileMap = Map<string, PublicGuestProfile>;
type BlockMap = Map<string, Set<string>>;

export function pickPartner(
  candidate: QueueEntry,
  queue: QueueEntry[],
  profiles: ProfileMap,
  blocks: BlockMap
): QueueEntry | undefined {
  const candidateProfile = profiles.get(candidate.sessionId);
  if (!candidateProfile) return undefined;

  const candidates = queue
    .filter((entry) => entry.sessionId !== candidate.sessionId)
    .filter((entry) => profiles.has(entry.sessionId))
    .filter((entry) => !hasBlockBetween(candidate.sessionId, entry.sessionId, blocks))
    .map((entry) => ({
      entry,
      score: scoreEntry(candidate, entry, candidateProfile, profiles.get(entry.sessionId)!)
    }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.joinedAt - b.entry.joinedAt);

  return candidates[0]?.entry;
}

function hasBlockBetween(a: string, b: string, blocks: BlockMap): boolean {
  return Boolean(blocks.get(a)?.has(b) || blocks.get(b)?.has(a));
}

function scoreEntry(
  candidate: QueueEntry,
  entry: QueueEntry,
  candidateProfile: PublicGuestProfile,
  otherProfile: PublicGuestProfile
): number {
  if (candidate.matchMode === "random") return 1;

  if (candidate.matchMode === "location") {
    const candidateCity = normalize(candidateProfile.cityRegion);
    const otherCity = normalize(otherProfile.cityRegion);
    if (!candidateCity || !otherCity) return -1;
    return candidateCity === otherCity ? 5 : -1;
  }

  const candidateTags = new Set(candidateProfile.interestTags.map(normalize).filter(Boolean));
  const overlap = otherProfile.interestTags.filter((tag) => candidateTags.has(normalize(tag))).length;
  return overlap > 0 ? 2 + overlap : -1;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
