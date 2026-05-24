import { clientSocketEvents, serverSocketEvents, type MatchCreatedPayload } from "@localchat/shared";
import type { Socket } from "socket.io-client";

export type CallState = {
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  status: "idle" | "requesting_media" | "connecting" | "connected" | "failed";
  error?: string;
};

export type CallControls = {
  start(match: MatchCreatedPayload): Promise<void>;
  toggleAudio(): void;
  toggleVideo(): void;
  end(reason?: "hangup" | "ice_failed"): void;
  close(): void;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
};

export function createPeerCall(
  socket: Socket,
  onState: (state: CallState) => void
): CallControls {
  let peer: RTCPeerConnection | undefined;
  let localStream: MediaStream | undefined;
  let remoteStream: MediaStream | undefined;
  let activeMatch: MatchCreatedPayload | undefined;
  let isAudioEnabled = true;
  let isVideoEnabled = true;
  let pendingIceCandidates: RTCIceCandidateInit[] = [];
  let pendingOffer: { encounterId: string; description: RTCSessionDescriptionInit } | undefined;
  let pendingAnswer: { encounterId: string; description: RTCSessionDescriptionInit } | undefined;
  let connectionTimer: number | undefined;
  let hasStartedOffer = false;

  const emitState = (status: CallState["status"], error?: string) => {
    onState({ localStream, remoteStream, status, error });
  };

  const cleanup = () => {
    if (connectionTimer) window.clearTimeout(connectionTimer);
    connectionTimer = undefined;
    peer?.close();
    peer = undefined;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = undefined;
    remoteStream = undefined;
    activeMatch = undefined;
    pendingIceCandidates = [];
    pendingOffer = undefined;
    pendingAnswer = undefined;
    hasStartedOffer = false;
    socket.off("signal:offer", handleOffer);
    socket.off("signal:answer", handleAnswer);
    socket.off("signal:ice", handleIce);
    socket.off(serverSocketEvents.callReady, handleCallReady);
  };

  const fail = (message: string) => {
    if (activeMatch) socket.emit(clientSocketEvents.callEnd, { encounterId: activeMatch.encounterId, reason: "ice_failed" });
    cleanup();
    emitState("failed", message);
  };

  const setupPeer = async (match: MatchCreatedPayload) => {
    activeMatch = match;
    socket.off("signal:offer", handleOffer);
    socket.off("signal:answer", handleAnswer);
    socket.off("signal:ice", handleIce);
    socket.off(serverSocketEvents.callReady, handleCallReady);
    socket.on("signal:offer", handleOffer);
    socket.on("signal:answer", handleAnswer);
    socket.on("signal:ice", handleIce);
    socket.on(serverSocketEvents.callReady, handleCallReady);

    emitState("requesting_media");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(getMediaUnavailableMessage());
    }
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();
    peer = new RTCPeerConnection({ iceServers: match.iceServers });

    localStream.getTracks().forEach((track) => peer!.addTrack(track, localStream!));
    peer.ontrack = (event) => {
      const tracks = event.streams[0]?.getTracks() ?? [event.track];
      tracks.forEach((track) => {
        if (!remoteStream!.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
          remoteStream!.addTrack(track);
        }
      });
      emitState("connected");
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) socket.emit(clientSocketEvents.signalIce, { encounterId: match.encounterId, candidate: event.candidate.toJSON() });
    };
    peer.oniceconnectionstatechange = () => {
      if (!peer) return;
      if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        emitState("connected");
      }
      if (peer.iceConnectionState === "failed") {
        fail("The peer-to-peer connection could not be established.");
      }
    };
    peer.onconnectionstatechange = () => {
      if (!peer) return;
      if (peer.connectionState === "connected") {
        emitState("connected");
      }
      if (peer.connectionState === "failed") {
        fail("The peer-to-peer connection could not be established.");
      }
    };

    emitState("connecting");
    connectionTimer = window.setTimeout(() => {
      if (peer?.connectionState !== "connected" && peer?.iceConnectionState !== "connected" && peer?.iceConnectionState !== "completed") {
        fail("The direct video connection timed out. Try requeueing.");
      }
    }, 30_000);
    if (pendingOffer) {
      const offer = pendingOffer;
      pendingOffer = undefined;
      await handleOffer(offer);
    }
    if (pendingAnswer) {
      const answer = pendingAnswer;
      pendingAnswer = undefined;
      await handleAnswer(answer);
    }
    socket.emit(clientSocketEvents.callReady, { encounterId: match.encounterId });
  };

  const handleCallReady = async (payload: { encounterId: string }) => {
    if (!peer || !activeMatch || payload.encounterId !== activeMatch.encounterId || activeMatch.role !== "initiator" || hasStartedOffer) return;
    try {
      hasStartedOffer = true;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit(clientSocketEvents.signalOffer, { encounterId: activeMatch.encounterId, description: peer.localDescription });
    } catch (error) {
      fail(error instanceof Error ? error.message : "The peer-to-peer offer could not be started.");
    }
  };

  const handleOffer = async (payload: { encounterId: string; description: RTCSessionDescriptionInit }) => {
    if (!activeMatch || payload.encounterId !== activeMatch.encounterId) return;
    if (!peer) {
      pendingOffer = payload;
      return;
    }
    try {
      await peer.setRemoteDescription(payload.description);
      await flushPendingIceCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit(clientSocketEvents.signalAnswer, { encounterId: activeMatch.encounterId, description: peer.localDescription });
    } catch (error) {
      fail(error instanceof Error ? error.message : "The peer-to-peer offer could not be handled.");
    }
  };

  const handleAnswer = async (payload: { encounterId: string; description: RTCSessionDescriptionInit }) => {
    if (!activeMatch || payload.encounterId !== activeMatch.encounterId) return;
    if (!peer) {
      pendingAnswer = payload;
      return;
    }
    try {
      await peer.setRemoteDescription(payload.description);
      await flushPendingIceCandidates();
    } catch (error) {
      fail(error instanceof Error ? error.message : "The peer-to-peer answer could not be handled.");
    }
  };

  const handleIce = async (payload: { encounterId: string; candidate: RTCIceCandidateInit }) => {
    if (!activeMatch || payload.encounterId !== activeMatch.encounterId) return;
    if (!peer) {
      pendingIceCandidates.push(payload.candidate);
      return;
    }
    if (!peer.remoteDescription) {
      pendingIceCandidates.push(payload.candidate);
      return;
    }
    try {
      await peer.addIceCandidate(payload.candidate);
    } catch (error) {
      fail(error instanceof Error ? error.message : "A peer-to-peer network candidate could not be handled.");
    }
  };

  const flushPendingIceCandidates = async () => {
    if (!peer?.remoteDescription) return;
    const candidates = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of candidates) {
      await peer.addIceCandidate(candidate);
    }
  };

  return {
    async start(match) {
      try {
        cleanup();
        await setupPeer(match);
      } catch (error) {
        fail(error instanceof Error ? error.message : "Camera or microphone could not be started.");
      }
    },
    toggleAudio() {
      isAudioEnabled = !isAudioEnabled;
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = isAudioEnabled;
      });
    },
    toggleVideo() {
      isVideoEnabled = !isVideoEnabled;
      localStream?.getVideoTracks().forEach((track) => {
        track.enabled = isVideoEnabled;
      });
    },
    end(reason = "hangup") {
      if (activeMatch) socket.emit(clientSocketEvents.callEnd, { encounterId: activeMatch.encounterId, reason });
      cleanup();
      emitState("idle");
    },
    close() {
      cleanup();
      emitState("idle");
    },
    get isAudioEnabled() {
      return isAudioEnabled;
    },
    get isVideoEnabled() {
      return isVideoEnabled;
    }
  };
}

function getMediaUnavailableMessage() {
  if (!window.isSecureContext) {
    return "Camera and microphone require HTTPS on this device. Open the app using an HTTPS URL, then try again.";
  }
  return "This browser does not expose camera and microphone access.";
}
