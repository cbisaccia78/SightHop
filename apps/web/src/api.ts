import type { CreateSessionResponse, GuestProfile, ModerationPayload } from "@sighthop/shared";

const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
const isLoopbackHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
export const apiUrl = configuredApiUrl || (import.meta.env.DEV && isLoopbackHost && window.location.protocol === "http:" ? "http://localhost:3000" : window.location.origin);

export async function createSession(): Promise<CreateSessionResponse> {
  return request("/api/session", { method: "POST" });
}

export async function saveProfile(sessionId: string, profile: GuestProfile): Promise<void> {
  await request("/api/profile", {
    method: "POST",
    headers: { "x-session-id": sessionId },
    body: JSON.stringify(profile)
  });
}

export async function reportSession(sessionId: string, payload: ModerationPayload): Promise<void> {
  await request("/api/report", {
    method: "POST",
    headers: { "x-session-id": sessionId },
    body: JSON.stringify(payload)
  });
}

export async function blockSession(sessionId: string, payload: ModerationPayload): Promise<void> {
  await request("/api/block", {
    method: "POST",
    headers: { "x-session-id": sessionId },
    body: JSON.stringify(payload)
  });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed: ${response.status}`);
  }

  return response.json();
}
