import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Camera, Heart, Loader2, MapPin, Mic, MicOff, PhoneOff, Shuffle, SlidersHorizontal, UserX, Video, VideoOff, X } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import {
  clientSocketEvents,
  guestProfileSchema,
  serverSocketEvents,
  type EncounterEndedPayload,
  type EncounterPresentedPayload,
  type GuestProfile,
  type MatchCreatedPayload,
  type MatchMode,
  type PublicGuestProfile
} from "@localchat/shared";
import { apiUrl, blockSession, createSession, reportSession, saveProfile } from "./api";
import { createPeerCall, type CallControls, type CallState } from "./webrtc";

type Screen = "onboarding" | "queue" | "encounter" | "call";
type QueueStatus = "idle" | "searching" | "exhausted";
const maxProfilePhotoLength = 1_800_000;
const defaultPhoto = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%23252a34'/%3E%3Ccircle cx='100' cy='78' r='36' fill='%23f4c35b'/%3E%3Cpath d='M38 180c10-42 113-42 124 0' fill='%238fd3c7'/%3E%3C/svg%3E";
const knownCityRegions = [
  "Atlanta",
  "Austin",
  "Boston",
  "Brooklyn",
  "Chicago",
  "Dallas",
  "Denver",
  "Detroit",
  "Houston",
  "Las Vegas",
  "Los Angeles",
  "Manhattan",
  "Miami",
  "Nashville",
  "New Orleans",
  "Oakland",
  "Philadelphia",
  "Phoenix",
  "Portland",
  "Queens",
  "San Diego",
  "San Francisco",
  "Seattle",
  "Washington, DC",
  "Toronto",
  "Vancouver",
  "London",
  "Paris",
  "Berlin",
  "Amsterdam",
  "Mexico City",
  "Sao Paulo",
  "Tokyo",
  "Seoul",
  "Sydney"
];

export function App() {
  const [sessionId, setSessionId] = useState("");
  const [profile, setProfile] = useState<GuestProfile | undefined>();
  const [screen, setScreen] = useState<Screen>("onboarding");
  const [matchMode, setMatchMode] = useState<MatchMode>("location");
  const [queueStatus, setQueueStatus] = useState<QueueStatus>("idle");
  const [queueFallback, setQueueFallback] = useState(false);
  const [encounter, setEncounter] = useState<EncounterPresentedPayload | undefined>();
  const [match, setMatch] = useState<MatchCreatedPayload | undefined>();
  const [callState, setCallState] = useState<CallState>({ status: "idle" });
  const [notice, setNotice] = useState("");
  const [socketReady, setSocketReady] = useState(false);
  const socketRef = useRef<Socket>();
  const callRef = useRef<CallControls>();
  const queueTimerRef = useRef<number>();
  const socketErrorTimerRef = useRef<number>();
  const matchModeRef = useRef(matchMode);
  const queueStatusRef = useRef(queueStatus);

  function clearQueueTimer() {
    if (queueTimerRef.current) window.clearTimeout(queueTimerRef.current);
    queueTimerRef.current = undefined;
  }

  function clearSocketErrorTimer() {
    if (socketErrorTimerRef.current) window.clearTimeout(socketErrorTimerRef.current);
    socketErrorTimerRef.current = undefined;
  }

  useEffect(() => {
    matchModeRef.current = matchMode;
  }, [matchMode]);

  useEffect(() => {
    queueStatusRef.current = queueStatus;
  }, [queueStatus]);

  useEffect(() => {
    if (!sessionId) return;
    const socket = io(apiUrl, { auth: { sessionId }, transports: ["polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      clearSocketErrorTimer();
      setSocketReady(true);
      setNotice("");
      if (queueStatusRef.current === "searching") {
        socket.emit(clientSocketEvents.queueJoin, { matchMode: matchModeRef.current });
      }
    });
    socket.on("connect_error", () => {
      setSocketReady(false);
      clearSocketErrorTimer();
      socketErrorTimerRef.current = window.setTimeout(() => {
        if (!socket.connected) setNotice("Realtime connection is not ready. Refresh and try again if this does not clear.");
      }, 3_000);
    });
    socket.on("disconnect", () => {
      setSocketReady(false);
      clearSocketErrorTimer();
      socketErrorTimerRef.current = window.setTimeout(() => {
        if (!socket.connected) setNotice("Realtime connection is reconnecting...");
      }, 3_000);
    });
    socket.on(serverSocketEvents.queueWaiting, (payload: { fallbackAfterMs: number; matchMode: MatchMode }) => {
      setScreen("queue");
      setQueueStatus("searching");
      setQueueFallback(false);
      clearQueueTimer();
      queueTimerRef.current = window.setTimeout(() => {
        if (payload.matchMode === "random") {
          socket.emit(clientSocketEvents.queueLeave);
          setQueueStatus("exhausted");
          setQueueFallback(false);
          return;
        }
        setQueueFallback(true);
      }, payload.fallbackAfterMs);
    });
    socket.on(serverSocketEvents.encounterPresented, (payload: EncounterPresentedPayload) => {
      clearQueueTimer();
      setQueueStatus("idle");
      setQueueFallback(false);
      setEncounter(payload);
      setScreen("encounter");
      setNotice("");
    });
    socket.on(serverSocketEvents.matchCreated, (payload: MatchCreatedPayload) => {
      clearQueueTimer();
      setQueueStatus("idle");
      setQueueFallback(false);
      setMatch(payload);
      setScreen("call");
      setNotice("");
    });
    socket.on(serverSocketEvents.encounterEnded, (payload: EncounterEndedPayload) => {
      callRef.current?.close();
      setMatch(undefined);
      setEncounter(undefined);
      setScreen("queue");
      setQueueStatus("idle");
      setQueueFallback(false);
      setNotice(payload.reason === "ice_failed" ? "The direct connection failed. Try another match." : "Encounter ended.");
    });
    socket.on(serverSocketEvents.callFailed, () => {
      setNotice("The direct connection failed for the other person too.");
    });
    socket.on(serverSocketEvents.error, (payload: { message: string }) => setNotice(payload.message));

    return () => {
      setSocketReady(false);
      clearQueueTimer();
      clearSocketErrorTimer();
      socket.disconnect();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!match || !socketRef.current) return;
    const call = createPeerCall(socketRef.current, setCallState);
    callRef.current = call;
    void call.start(match);
    return () => call.close();
  }, [match]);

  const canQueue = Boolean(profile && socketReady);

  async function handleOnboard(nextProfile: GuestProfile) {
    const session = await createSession();
    await saveProfile(session.sessionId, nextProfile);
    setSessionId(session.sessionId);
    setProfile(nextProfile);
    setScreen("queue");
  }

  function joinQueue(nextMode = matchMode) {
    if (!canQueue) return;
    setMatchMode(nextMode);
    socketRef.current?.emit(clientSocketEvents.queueJoin, { matchMode: nextMode });
    setScreen("queue");
    setQueueStatus("searching");
    setQueueFallback(false);
    setNotice("");
  }

  function updateMatchMode(nextMode: MatchMode) {
    setMatchMode(nextMode);
    if (queueStatus === "exhausted") {
      setQueueStatus("idle");
      setQueueFallback(false);
    }
  }

  function leaveQueue() {
    clearQueueTimer();
    socketRef.current?.emit(clientSocketEvents.queueLeave);
    setQueueStatus("idle");
    setQueueFallback(false);
  }

  function swipe(decision: "left" | "right") {
    if (!encounter) return;
    socketRef.current?.emit(clientSocketEvents.swipeSubmit, { encounterId: encounter.encounterId, decision });
    if (decision === "right") setNotice("Waiting for their swipe...");
  }

  async function moderate(action: "report" | "block", target: PublicGuestProfile) {
    if (!sessionId) return;
    const payload = { targetSessionId: target.sessionId, encounterId: encounter?.encounterId ?? match?.encounterId, reason: "other" as const };
    if (action === "report") await reportSession(sessionId, payload);
    if (action === "block") await blockSession(sessionId, payload);
    setNotice(action === "report" ? "Report saved." : "Blocked and ended.");
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">LocalChat</p>
          <h1>Swipe into a direct video match.</h1>
        </div>
        {profile ? <div className="mini-profile"><img src={profile.photoUrl} alt="" /><span>{profile.displayName}</span></div> : null}
      </section>

      {notice ? <div className="notice">{notice}</div> : null}

      {screen === "onboarding" ? <Onboarding onSubmit={handleOnboard} /> : null}
      {screen === "queue" && profile ? (
        <QueuePanel
          matchMode={matchMode}
          setMatchMode={updateMatchMode}
          onJoin={joinQueue}
          onLeave={leaveQueue}
          showFallback={queueFallback}
          status={queueStatus}
          socketReady={socketReady}
        />
      ) : null}
      {screen === "encounter" && encounter ? (
        <EncounterCard
          encounter={encounter}
          onSwipe={swipe}
          onReport={() => moderate("report", encounter.counterpart)}
          onBlock={() => moderate("block", encounter.counterpart)}
        />
      ) : null}
      {screen === "call" && encounter ? (
        <CallRoom
          counterpart={encounter.counterpart}
          callState={callState}
          controls={callRef.current}
          onReport={() => moderate("report", encounter.counterpart)}
          onBlock={() => moderate("block", encounter.counterpart)}
          onRequeue={() => joinQueue(matchMode)}
        />
      ) : null}
    </main>
  );
}

function Onboarding({ onSubmit }: { onSubmit(profile: GuestProfile): Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [cityRegion, setCityRegion] = useState("");
  const [interestTags, setInterestTags] = useState("");
  const [photoUrl, setPhotoUrl] = useState(defaultPhoto);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError("");
    if (!accepted) {
      setError("Please accept the basic conduct rules.");
      return;
    }
    const parsed = guestProfileSchema.safeParse({
      displayName,
      photoUrl,
      bio,
      cityRegion,
      interestTags: interestTags.split(",").map((tag) => tag.trim()).filter(Boolean)
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Profile needs a little more detail.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create session.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="avatar-picker">
        <img src={photoUrl} alt="" />
        <label className="icon-button">
          <Camera size={18} />
          <input
            type="file"
            accept="image/*"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setError("");
              try {
                setPhotoUrl(await compressProfilePhoto(file));
              } catch (err) {
                setError(err instanceof Error ? err.message : "That image could not be loaded.");
              } finally {
                event.target.value = "";
              }
            }}
          />
        </label>
      </div>
      <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} /></label>
      <label>Bio<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={240} /></label>
      <CityRegionSearch value={cityRegion} onChange={setCityRegion} />
      <label>Interest tags<input value={interestTags} onChange={(event) => setInterestTags(event.target.value)} placeholder="music, coffee, startups" /></label>
      <label className="check"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I will use report/block when needed and not harass people.</label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" onClick={submit} disabled={saving}>{saving ? <Loader2 className="spin" size={18} /> : null} Start</button>
    </section>
  );
}

async function compressProfilePhoto(file: File): Promise<string> {
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  const size = Math.min(Math.max(image.naturalWidth, image.naturalHeight), 960);
  const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not process that image.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const qualities = [0.82, 0.72, 0.62, 0.52, 0.42];
  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= maxProfilePhotoLength) return dataUrl;
  }

  throw new Error("That image is too large. Try a smaller photo.");
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("That image could not be loaded."));
    };
    image.src = objectUrl;
  });
}

function CityRegionSearch({ value, onChange }: { value: string; onChange(value: string): void }) {
  const listId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debouncedValue = useDebouncedValue(value, 180);
  const normalizedQuery = debouncedValue.trim().toLowerCase();
  const options = useMemo(() => {
    if (!isOpen || normalizedQuery.length === 0) return [];
    const currentValue = value.trim().toLowerCase();
    return knownCityRegions
      .filter((option) => {
        const normalizedOption = option.toLowerCase();
        return normalizedOption !== currentValue && normalizedOption.includes(normalizedQuery);
      })
      .slice(0, 6);
  }, [isOpen, normalizedQuery, value]);

  useEffect(() => {
    setActiveIndex(options.length ? 0 : -1);
  }, [options]);

  function selectOption(option: string) {
    onChange(option);
    setIsOpen(false);
    setActiveIndex(-1);
  }

  return (
    <label className="city-search">
      City or region
      <div className="city-search-box">
        <input
          type="search"
          value={value}
          onBlur={() => setIsOpen(false)}
          onChange={(event) => {
            onChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={(event) => {
            if (!options.length) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % options.length);
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => (index <= 0 ? options.length - 1 : index - 1));
            }
            if (event.key === "Enter" && activeIndex >= 0) {
              event.preventDefault();
              selectOption(options[activeIndex]);
            }
            if (event.key === "Escape") {
              setIsOpen(false);
            }
          }}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={options.length > 0}
          maxLength={80}
        />
        {options.length ? (
          <div className="city-options" id={listId} role="listbox">
            {options.map((option, index) => (
              <button
                aria-selected={activeIndex === index}
                className={activeIndex === index ? "active" : ""}
                key={option}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
                role="option"
                type="button"
              >
                <MapPin size={16} />
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </label>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
}

function QueuePanel({ matchMode, setMatchMode, onJoin, onLeave, showFallback, status, socketReady }: {
  matchMode: MatchMode;
  setMatchMode(mode: MatchMode): void;
  onJoin(mode?: MatchMode): void;
  onLeave(): void;
  showFallback: boolean;
  status: QueueStatus;
  socketReady: boolean;
}) {
  const modes = useMemo(() => [
    { id: "location" as const, label: "Location", icon: MapPin },
    { id: "preferences" as const, label: "Preferences", icon: SlidersHorizontal },
    { id: "random" as const, label: "Random", icon: Shuffle }
  ], []);
  const isSearching = status === "searching";
  const isExhausted = status === "exhausted";

  return (
    <section className="panel queue-panel">
      <div className="segmented">
        {modes.map(({ id, label, icon: Icon }) => (
          <button key={id} className={matchMode === id ? "active" : ""} onClick={() => setMatchMode(id)}>
            <Icon size={18} /> {label}
          </button>
        ))}
      </div>
      <button className="primary" disabled={!socketReady || isSearching} onClick={() => onJoin(isExhausted ? "random" : matchMode)}>
        {isSearching ? <Loader2 className="spin" size={18} /> : null}
        {!socketReady ? "Connecting..." : isSearching ? "Searching..." : isExhausted ? "Try again" : "Find someone"}
      </button>
      {isSearching ? <button className="ghost" onClick={onLeave}>Leave queue</button> : null}
      {showFallback && matchMode !== "random" ? <button className="ghost" onClick={() => onJoin("random")}>Try random instead</button> : null}
      {isExhausted ? (
        <div className="queue-empty">
          <strong>No one is available right now.</strong>
          <span>Random search timed out. You can try again or come back later.</span>
        </div>
      ) : null}
    </section>
  );
}

function EncounterCard({ encounter, onSwipe, onReport, onBlock }: {
  encounter: EncounterPresentedPayload;
  onSwipe(decision: "left" | "right"): void;
  onReport(): void;
  onBlock(): void;
}) {
  const person = encounter.counterpart;
  return (
    <section className="person-card">
      <img className="person-photo" src={person.photoUrl} alt="" />
      <div className="person-body">
        <h2>{person.displayName}</h2>
        <p>{person.bio || "No bio yet."}</p>
        <div className="chips">
          {person.cityRegion ? <span>{person.cityRegion}</span> : null}
          {person.interestTags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      </div>
      <div className="actions">
        <button className="round danger" onClick={() => onSwipe("left")} title="Swipe left"><X /></button>
        <button className="round good" onClick={() => onSwipe("right")} title="Swipe right"><Heart /></button>
        <button className="round" onClick={onReport} title="Report"><UserX /></button>
        <button className="round" onClick={onBlock} title="Block"><PhoneOff /></button>
      </div>
    </section>
  );
}

function CallRoom({ counterpart, callState, controls, onReport, onBlock, onRequeue }: {
  counterpart: PublicGuestProfile;
  callState: CallState;
  controls?: CallControls;
  onReport(): void;
  onBlock(): void;
  onRequeue(): void;
}) {
  const localRef = useVideo(callState.localStream);
  const remoteRef = useVideo(callState.remoteStream);

  return (
    <section className="call-room">
      <video ref={remoteRef} autoPlay playsInline className="remote-video" />
      <video ref={localRef} autoPlay muted playsInline className="local-video" />
      {callState.status !== "connected" ? <div className="call-status">{callState.error ?? "Connecting direct peer-to-peer video..."}</div> : null}
      <div className="call-controls">
        <span>{counterpart.displayName}</span>
        <button className="round" onClick={() => controls?.toggleAudio()} title="Toggle microphone">{controls?.isAudioEnabled === false ? <MicOff /> : <Mic />}</button>
        <button className="round" onClick={() => controls?.toggleVideo()} title="Toggle camera">{controls?.isVideoEnabled === false ? <VideoOff /> : <Video />}</button>
        <button className="round danger" onClick={() => controls?.end("hangup")} title="Hang up"><PhoneOff /></button>
        <button className="round" onClick={onReport} title="Report"><UserX /></button>
        <button className="round" onClick={onBlock} title="Block"><X /></button>
        {callState.status === "failed" ? <button className="ghost" onClick={onRequeue}>Requeue</button> : null}
      </div>
    </section>
  );
}

function useVideo(stream?: MediaStream) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);
  return ref;
}
