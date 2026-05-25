import { useState, useEffect, useRef } from "react";
import { supabase, isSupabaseConfigured } from "./lib/supabase";

// Helper to safely invoke Tauri commands without crashing standard browsers
const isTauriApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const invokeTauri = async (cmd: string, args?: any) => {
  if (isTauriApp) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke(cmd, args);
    } catch (err) {
      console.error(`Failed to invoke Tauri command "${cmd}":`, err);
      throw err;
    }
  } else {
    console.log(`[Browser Simulation] Tauri command "${cmd}" simulated with args:`, args);
    return null;
  }
};

// Helper to toggle Tauri window fullscreen natively
const toggleTauriFullscreen = async () => {
  if (isTauriApp) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      const isFullscreen = await appWindow.isFullscreen();
      await appWindow.setFullscreen(!isFullscreen);
      return !isFullscreen;
    } catch (err) {
      console.error("Failed to toggle Tauri fullscreen:", err);
    }
  }
  return null;
};

// Helper to toggle Tauri window maximization natively
const toggleTauriMaximize = async () => {
  if (isTauriApp) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      return !isMaximized;
    } catch (err) {
      console.error("Failed to toggle Tauri maximize:", err);
    }
  }
  return null;
};

// --- Types ---
type ConnectionStatus = "idle" | "connecting" | "connected" | "rejected" | "incoming";
type Theme = "light" | "dark" | "system";

interface SignalPayload {
  senderId: string;
  receiverId: string;
  metadata?: {
    timestamp: number;
    platform?: string;
  };
}

export default function App() {
  // --- Theme State ---
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("controldesk-theme") as Theme;
    return saved || "system";
  });

  // --- Desk ID State (Generates once on mount, supports URL query param) ---
  const [myId, setMyId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get("share");
    if (shareId && shareId.length === 6 && /^\d+$/.test(shareId)) {
      return shareId;
    }
    return Math.floor(100000 + Math.random() * 900000).toString();
  });

  // --- Interactive UI States ---
  const [partnerIdInput, setPartnerIdInput] = useState<string>("");
  const [activePartnerId, setActivePartnerId] = useState<string>("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [copied, setCopied] = useState<boolean>(false);
  const [connectionTime, setConnectionTime] = useState<number>(0);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [isCaller, setIsCaller] = useState<boolean>(false);
  const [isControlActive, setIsControlActive] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [scaleMode, setScaleMode] = useState<"fit" | "50%" | "75%" | "100%" | "125%" | "150%">("fit");
  const [videoDims, setVideoDims] = useState({ width: 0, height: 0 });

  // --- Custom ID Edit States ---
  const [isEditingId, setIsEditingId] = useState<boolean>(false);
  const [customIdInput, setCustomIdInput] = useState<string>("");

  const isCapturingRef = useRef<boolean>(false);
  const nativeCaptureIntervalRef = useRef<any>(null);

  // --- Refs to mitigate closures in broadcast events ---
  const statusRef = useRef<ConnectionStatus>(status);
  const partnerIdInputRef = useRef<string>(partnerIdInput);
  const activePartnerIdRef = useRef<string>(activePartnerId);
  const isCallerRef = useRef<boolean>(false);
  const timeoutRef = useRef<number | null>(null);
  const connectionTimerRef = useRef<number | null>(null);
  const channelRef = useRef<any>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // Keep refs in sync with state
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { partnerIdInputRef.current = partnerIdInput; }, [partnerIdInput]);
  useEffect(() => { activePartnerIdRef.current = activePartnerId; }, [activePartnerId]);
  useEffect(() => { isCallerRef.current = isCaller; }, [isCaller]);

  // --- Theme Sync Engine ---
  useEffect(() => {
    const root = window.document.documentElement;
    
    const applyTheme = (currentTheme: Theme) => {
      root.classList.remove("light", "dark");
      if (currentTheme === "system") {
        const isSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        root.classList.add(isSystemDark ? "dark" : "light");
      } else {
        root.classList.add(currentTheme);
      }
    };

    applyTheme(theme);
    localStorage.setItem("controldesk-theme", theme);

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = () => applyTheme("system");
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
  }, [theme]);

  // --- Connection Session Timer ---
  useEffect(() => {
    if (status === "connected") {
      setConnectionTime(0);
      connectionTimerRef.current = window.setInterval(() => {
        setConnectionTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (connectionTimerRef.current) {
        window.clearInterval(connectionTimerRef.current);
        connectionTimerRef.current = null;
      }
    }

    return () => {
      if (connectionTimerRef.current) window.clearInterval(connectionTimerRef.current);
    };
  }, [status]);

  // --- Browser DOM Input Simulator ---
  const simulateBrowserInput = (payload: {
    eventType: "mousemove" | "mousedown" | "mouseup" | "keydown" | "keyup";
    xPct?: number;
    yPct?: number;
    button?: string;
    key?: string;
  }) => {
    const { eventType, xPct, yPct, button, key } = payload;

    if (xPct !== undefined && yPct !== undefined) {
      const x = xPct * window.innerWidth;
      const y = yPct * window.innerHeight;

      // DOM interaction logic for clicks
      if (eventType === "mousedown" || eventType === "mouseup") {
        const element = document.elementFromPoint(x, y) as HTMLElement | null;
        if (element) {
          const clientX = x;
          const clientY = y;

          const createEvent = (type: string) => {
            return new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX,
              clientY,
              screenX: clientX + window.screenX,
              screenY: clientY + window.screenY,
              button: button === "right" ? 2 : (button === "middle" ? 1 : 0),
              buttons: type === "mousedown" ? (button === "right" ? 2 : (button === "middle" ? 4 : 1)) : 0,
            });
          };

          if (eventType === "mousedown") {
            element.dispatchEvent(createEvent("mousedown"));
            
            // Focus matching input/textarea/contenteditable
            if (
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element.isContentEditable
            ) {
              element.focus();
            } else {
              const active = document.activeElement as HTMLElement | null;
              if (active && active !== element) {
                active.blur();
              }
            }
          } else if (eventType === "mouseup") {
            element.dispatchEvent(createEvent("mouseup"));
            element.dispatchEvent(createEvent("click"));
          }
        }
      }
    }

    if ((eventType === "keydown" || eventType === "keyup") && key) {
      const activeEl = document.activeElement as HTMLElement | null;
      const target = activeEl || document.body;

      if (eventType === "keydown" && activeEl) {
        if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
          const input = activeEl;
          if (key === "Backspace") {
            input.value = input.value.slice(0, -1);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (key === "Enter") {
            if (input.form) {
              input.form.requestSubmit();
            }
          } else if (key.length === 1) {
            input.value += key;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else if (activeEl.isContentEditable) {
          if (key === "Backspace") {
            activeEl.textContent = activeEl.textContent?.slice(0, -1) || "";
            activeEl.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (key.length === 1) {
            activeEl.textContent = (activeEl.textContent || "") + key;
            activeEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }

      // Dispatch standard keyboard event
      const kEvt = new KeyboardEvent(eventType, {
        key: key,
        code: key,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(kEvt);
    }
  };

  // --- Supabase Signaling Layer ---
  useEffect(() => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

      const isValidUrl = (url: string): boolean => {
        try {
          new URL(url);
          return true;
        } catch {
          return false;
        }
      };

      // Check environment configuration
      if (!isSupabaseConfigured) {
        const issues: string[] = [];
        if (!supabaseUrl) issues.push("VITE_SUPABASE_URL is missing");
        else if (!isValidUrl(supabaseUrl)) issues.push(`VITE_SUPABASE_URL "${supabaseUrl}" is invalid`);
        if (!supabaseAnonKey) issues.push("VITE_SUPABASE_ANON_KEY is missing");
        
        throw new Error(
          `Supabase configuration error: ${issues.join(", ")}. Please configure your .env file and restart your Vite server.`
        );
      }

      // Check if Supabase client is initialized correctly with the URL
      const clientUrl = (supabase as any).supabaseUrl;
      if (!clientUrl || clientUrl.includes("placeholder-url-for-compilation") || !isValidUrl(clientUrl)) {
        throw new Error(
          `Supabase client itself is not initialized correctly with URL: "${clientUrl || "undefined"}".`
        );
      }

      if (!supabase || supabase.auth === undefined) {
        throw new Error("Supabase client is uninstantiated or invalid.");
      }

      // Explicitly define the channel name
      const channelName = "desk_signals";
      const channel = supabase.channel(channelName, {
        config: {
          broadcast: { self: false },
        },
      });

      channelRef.current = channel;

      // Listen for broadcast events
      channel
        .on("broadcast", { event: "offer" }, ({ payload }: { payload: SignalPayload }) => {
          console.log("🔔 Incoming connection offer payload:", payload);
          if (payload.receiverId === myId) {
            if (statusRef.current === "idle" || statusRef.current === "rejected") {
              setIsCaller(false);
              setActivePartnerId(payload.senderId);
              setStatus("incoming");
            } else {
              // Auto-decline if currently occupied
              channel.send({
                type: "broadcast",
                event: "reject",
                payload: { senderId: myId, receiverId: payload.senderId },
              });
            }
          }
        })
        .on("broadcast", { event: "accept" }, ({ payload }: { payload: SignalPayload }) => {
          console.log("✅ Outgoing connection accepted:", payload);
          if (payload.receiverId === myId && payload.senderId === partnerIdInputRef.current) {
            if (timeoutRef.current) {
              window.clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }
            setActivePartnerId(payload.senderId);
            setStatus("connected");
          } else if (payload.senderId === myId && isTauriApp && !isCallerRef.current) {
            console.log("🔌 Tauri Assistant: Local browser twin accepted connection. Syncing connected state.");
            if (timeoutRef.current) {
              window.clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }
            setActivePartnerId(payload.receiverId);
            setStatus("connected");
          }
        })
        .on("broadcast", { event: "reject" }, ({ payload }: { payload: SignalPayload }) => {
          console.log("❌ Outgoing connection declined:", payload);
          const isRelated = 
            (payload.receiverId === myId && payload.senderId === partnerIdInputRef.current) ||
            (payload.senderId === myId && payload.receiverId === activePartnerIdRef.current);

          if (isRelated) {
            if (timeoutRef.current) {
              window.clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }
            setStatus("rejected");
            // Revert to idle state automatically after 3.5 seconds
            window.setTimeout(() => {
              if (statusRef.current === "rejected") {
                setStatus("idle");
                setActivePartnerId("");
              }
            }, 3500);
          }
        })
        .on("broadcast", { event: "disconnect" }, ({ payload }: { payload: SignalPayload }) => {
          console.log("🔌 Connection disconnected:", payload);
          const isRelated = 
            (payload.receiverId === myId && payload.senderId === activePartnerIdRef.current) ||
            (payload.senderId === myId && payload.receiverId === activePartnerIdRef.current);

          if (isRelated) {
            setStatus("idle");
            setActivePartnerId("");
            setIsMaximized(false);
            cleanupWebRTC();
          }
        })
        .on("broadcast", { event: "webrtc-offer" }, async ({ payload }: { payload: any }) => {
          if (payload.receiverId === myId && payload.senderId === activePartnerIdRef.current) {
            console.log("📺 Received WebRTC SDP Offer from Host");
            try {
              iceCandidatesQueueRef.current = [];
              const pc = new RTCPeerConnection({
                iceServers: [
                  { urls: "stun:stun.l.google.com:19302" },
                  { urls: "stun:stun1.l.google.com:19302" },
                  { urls: "stun:stun2.l.google.com:19302" },
                  { urls: "stun:stun3.l.google.com:19302" },
                  { urls: "stun:stun4.l.google.com:19302" }
                ],
              });
              peerConnectionRef.current = pc;

              pc.oniceconnectionstatechange = () => {
                console.log("⚡ ICE Connection State (Guest):", pc.iceConnectionState);
              };
              pc.onconnectionstatechange = () => {
                console.log("⚡ Connection State (Guest):", pc.connectionState);
              };

              pc.ontrack = (event) => {
                console.log("📺 Remote track received!", event.streams[0]);
                if (remoteVideoRef.current) {
                  remoteVideoRef.current.srcObject = event.streams[0];
                  remoteVideoRef.current.play().catch((err) => {
                    console.warn("Auto-play failed on ontrack:", err);
                  });
                }
              };

              pc.onicecandidate = (event) => {
                if (event.candidate && channelRef.current) {
                  channelRef.current.send({
                    type: "broadcast",
                    event: "webrtc-candidate",
                    payload: {
                      senderId: myId,
                      receiverId: activePartnerIdRef.current,
                      candidate: event.candidate,
                    },
                  });
                }
              };

              await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
              console.log("📺 setRemoteDescription (Offer) successful on Guest");

              if (iceCandidatesQueueRef.current.length > 0) {
                console.log(`📶 Processing ${iceCandidatesQueueRef.current.length} queued ICE candidates`);
                for (const candidate of iceCandidatesQueueRef.current) {
                  try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                  } catch (e) {
                    console.error("Error adding queued ICE candidate:", e);
                  }
                }
                iceCandidatesQueueRef.current = [];
              }

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              if (channelRef.current) {
                channelRef.current.send({
                  type: "broadcast",
                  event: "webrtc-answer",
                  payload: {
                    senderId: myId,
                    receiverId: activePartnerIdRef.current,
                    sdp: answer,
                  },
                });
              }
            } catch (err) {
              console.error("Failed to handle WebRTC offer:", err);
            }
          }
        })
        .on("broadcast", { event: "webrtc-answer" }, async ({ payload }: { payload: any }) => {
          if (payload.receiverId === myId && payload.senderId === activePartnerIdRef.current) {
            console.log("📺 Received WebRTC SDP Answer from Guest");
            try {
              const pc = peerConnectionRef.current;
              if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                console.log("📺 setRemoteDescription (Answer) successful on Host");

                if (iceCandidatesQueueRef.current.length > 0) {
                  console.log(`📶 Processing ${iceCandidatesQueueRef.current.length} queued ICE candidates`);
                  for (const candidate of iceCandidatesQueueRef.current) {
                     try {
                      await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (e) {
                      console.error("Error adding queued ICE candidate:", e);
                    }
                  }
                  iceCandidatesQueueRef.current = [];
                }
              }
            } catch (err) {
              console.error("Failed to set remote description (answer):", err);
            }
          }
        })
        .on("broadcast", { event: "webrtc-candidate" }, async ({ payload }: { payload: any }) => {
          if (payload.receiverId === myId && payload.senderId === activePartnerIdRef.current) {
            console.log("📶 Received WebRTC ICE Candidate");
            try {
              const pc = peerConnectionRef.current;
              if (!pc || !pc.remoteDescription) {
                console.log("📶 Queueing ICE Candidate (remoteDescription not set yet)");
                iceCandidatesQueueRef.current.push(payload.candidate);
              } else {
                await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
              }
            } catch (err) {
              console.error("Failed to add ICE candidate:", err);
            }
          }
        })
        .on("broadcast", { event: "remote-input" }, async ({ payload }: { payload: any }) => {
          // Verify we are the receiver (Host) and connection is active
          if (payload.receiverId === myId && payload.senderId === activePartnerIdRef.current) {
            console.log("🎮 Received remote input event:", payload.eventType, payload);
            if (isTauriApp) {
              try {
                await invokeTauri("handle_remote_input", {
                  event_type: payload.eventType,
                  x_pct: payload.xPct,
                  y_pct: payload.yPct,
                  button: payload.button,
                  key: payload.key,
                });
              } catch (err) {
                console.error("Failed to execute remote input command:", err);
              }
            } else {
              simulateBrowserInput(payload);
            }
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') console.log('Successfully subscribed!');
          else console.error('Subscription failed:', status);

          if (status === "SUBSCRIBED") {
            setRealtimeError(null);
          } else {
            setRealtimeError(`Subscription failed: ${status}`);
          }
        });
    } catch (err: any) {
      console.error("Error setting up Supabase signaling channel:", err);
      setRealtimeError(`Subscription initialization exception: ${err.message || err}`);
    }

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (channelRef.current) {
        channelRef.current.unsubscribe();
      }
    };
  }, [myId]);

  // --- WebRTC Logic ---
  const cleanupWebRTC = () => {
    console.log("🧹 Cleaning up WebRTC Peer Connection and Streams...");
    setIsControlActive(false);
    setScaleMode("fit");
    setVideoDims({ width: 0, height: 0 });
    iceCandidatesQueueRef.current = [];
    isCapturingRef.current = false;
    if (nativeCaptureIntervalRef.current) {
      clearTimeout(nativeCaptureIntervalRef.current);
      nativeCaptureIntervalRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const startScreenSharing = async () => {
    try {
      console.log("🎥 Starting screen capture...");
      let stream: MediaStream;

      if (isTauriApp) {
        console.log("🖥️ Tauri mode: Initializing native Rust screen capture pipeline...");
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        
        // Initial dummy dimensions so captureStream doesn't fail
        canvas.width = 1280;
        canvas.height = 720;
        
        // Capture stream at 30 fps
        stream = (canvas as any).captureStream(30);
        localStreamRef.current = stream;

        isCapturingRef.current = true;
        const captureFrame = async () => {
          if (!isCapturingRef.current) return;
          try {
            const base64Str = await invokeTauri("capture_screen");
            if (base64Str && ctx) {
              const img = new Image();
              img.onload = () => {
                if (!isCapturingRef.current) return;
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
              };
              img.src = "data:image/jpeg;base64," + base64Str;
            }
          } catch (err) {
            console.error("Error capturing native frame:", err);
          }
          if (isCapturingRef.current) {
            nativeCaptureIntervalRef.current = setTimeout(captureFrame, 33); // ~30 FPS
          }
        };

        // Start capture loop
        captureFrame();
      } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          throw new Error(
            "Screen capture is not supported in this browser. To share this desk's screen, please open the application in a web browser (e.g. Chrome) at http://localhost:1420."
          );
        }
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: "monitor",
          },
          audio: false,
        });
        localStreamRef.current = stream;
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" }
        ],
      });
      peerConnectionRef.current = pc;

      pc.oniceconnectionstatechange = () => {
        console.log("⚡ ICE Connection State (Host):", pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        console.log("⚡ Connection State (Host):", pc.connectionState);
      };

      // Add tracks
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Handle ICE Candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && channelRef.current) {
          channelRef.current.send({
            type: "broadcast",
            event: "webrtc-candidate",
            payload: {
              senderId: myId,
              receiverId: activePartnerIdRef.current,
              candidate: event.candidate,
            },
          });
        }
      };

      // Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send Offer
      if (channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "webrtc-offer",
          payload: {
            senderId: myId,
            receiverId: activePartnerIdRef.current,
            sdp: offer,
          },
        });
      }

      // Handle stream termination by user (e.g. clicking Stop Sharing in browser)
      if (!isTauriApp) {
        stream.getVideoTracks()[0].onended = () => {
          console.log("🎥 Screen sharing track ended by user");
          handleDisconnect();
        };
      }
    } catch (err: any) {
      console.error("Failed to start screen sharing:", err);
      alert(`Could not start screen sharing: ${err.message || err}`);
      handleDisconnect();
    }
  };

  // Trigger WebRTC when connection status changes
  useEffect(() => {
    if (status === "connected") {
      if (!isCallerRef.current) {
        // We are the host/callee, start sharing screen
        startScreenSharing();
      } else {
        // Viewer: autofocus the video player so keyboard input works immediately
        setTimeout(() => {
          remoteVideoRef.current?.focus();
        }, 500);
      }
    } else {
      cleanupWebRTC();
    }
  }, [status]);

  // --- Handlers ---
  const handleConnect = () => {
    if (!partnerIdInput) return;
    
    const targetId = partnerIdInput.trim();
    if (targetId.length !== 6 || !/^\d+$/.test(targetId)) {
      alert("Please enter a valid 6-digit numeric Desk ID.");
      return;
    }

    if (targetId === myId) {
      alert("Cannot initiate connection to your own system.");
      return;
    }

    setStatus("connecting");
    setIsCaller(true);
    setActivePartnerId(targetId);

    // Broadcast connection offer
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "offer",
        payload: {
          senderId: myId,
          receiverId: targetId,
          metadata: {
            timestamp: Date.now(),
            platform: "Tauri Desktop",
          },
        },
      });
    }

    // Outbound request timeout handler (15 seconds)
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      if (statusRef.current === "connecting") {
        setStatus("idle");
        setActivePartnerId("");
        alert("Connection request timed out. Partner desk is unreachable.");
      }
    }, 15000);
  };

  const handleAccept = () => {
    if (!activePartnerId) return;

    setStatus("connected");
    setIsCaller(false);

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "accept",
        payload: {
          senderId: myId,
          receiverId: activePartnerId,
        },
      });
    }
  };

  const handleReject = () => {
    if (!activePartnerId) return;

    setStatus("idle");
    setIsCaller(false);
    const target = activePartnerId;
    setActivePartnerId("");

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "reject",
        payload: {
          senderId: myId,
          receiverId: target,
        },
      });
    }
  };

  const handleDisconnect = () => {
    if (!activePartnerId) return;

    setStatus("idle");
    setIsCaller(false);
    setIsMaximized(false);
    const target = activePartnerId;
    setActivePartnerId("");

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "disconnect",
        payload: {
          senderId: myId,
          receiverId: target,
        },
      });
    }
  };

  const handleCancelConnect = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setStatus("idle");
    setIsCaller(false);
    setIsMaximized(false);
    setActivePartnerId("");
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(myId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  // --- Remote Input Capture & Transmission ---
  const lastMouseMoveRef = useRef<number>(0);

  const sendRemoteInput = (inputData: {
    eventType: "mousemove" | "mousedown" | "mouseup" | "keydown" | "keyup";
    xPct?: number;
    yPct?: number;
    button?: string;
    key?: string;
  }) => {
    if (channelRef.current && status === "connected" && activePartnerIdRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "remote-input",
        payload: {
          senderId: myId,
          receiverId: activePartnerIdRef.current,
          ...inputData,
        },
      });
    }
  };

  const handleVideoMouseEvent = (
    e: React.MouseEvent<HTMLVideoElement>,
    eventType: "mousemove" | "mousedown" | "mouseup"
  ) => {
    if (status !== "connected" || !isCaller || !remoteVideoRef.current) return;

    // If control is not active, a click (mousedown) will activate it
    if (!isControlActive) {
      if (eventType === "mousedown") {
        setIsControlActive(true);
      }
      return;
    }

    // Throttle mousemove events to 8ms to keep remote movements buttery smooth
    if (eventType === "mousemove") {
      const now = Date.now();
      if (now - lastMouseMoveRef.current < 8) return;
      lastMouseMoveRef.current = now;
    }

    const video = remoteVideoRef.current;
    const { videoWidth, videoHeight, clientWidth, clientHeight } = video;

    if (videoWidth === 0 || videoHeight === 0 || clientWidth === 0 || clientHeight === 0) return;

    const r = videoWidth / videoHeight;
    const R = clientWidth / clientHeight;

    let displayedWidth = clientWidth;
    let displayedHeight = clientHeight;
    let xOffset = 0;
    let yOffset = 0;

    if (r > R) {
      // Letterboxed (bars at top/bottom)
      displayedHeight = clientWidth / r;
      yOffset = (clientHeight - displayedHeight) / 2;
    } else {
      // Pillarboxed (bars at sides)
      displayedWidth = clientHeight * r;
      xOffset = (clientWidth - displayedWidth) / 2;
    }

    const rect = video.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const xRelative = mouseX - xOffset;
    const yRelative = mouseY - yOffset;

    // Process only if inside actual video frame bounds
    if (
      xRelative >= 0 &&
      xRelative <= displayedWidth &&
      yRelative >= 0 &&
      yRelative <= displayedHeight
    ) {
      const xPct = xRelative / displayedWidth;
      const yPct = yRelative / displayedHeight;

      let buttonStr: string | undefined = undefined;
      if (eventType === "mousedown" || eventType === "mouseup") {
        if (e.button === 0) buttonStr = "left";
        else if (e.button === 1) buttonStr = "middle";
        else if (e.button === 2) buttonStr = "right";
      }

      sendRemoteInput({
        eventType,
        xPct,
        yPct,
        button: buttonStr,
      });
    }
  };

  // --- Keyboard Focus & Capture Engine (Window Level) ---
  useEffect(() => {
    if (!isControlActive || !isCaller || status !== "connected") return;

    const handleWindowKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing inside any form input/textarea fields
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable)
      ) {
        return;
      }

      // Exit remote control mode on Escape
      if (e.key === "Escape") {
        setIsControlActive(false);
        return;
      }

      // Prevent browser default behaviors (scroll, tab navigate, etc.) for forwarded keys
      if (["Tab", "Space", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace"].includes(e.key)) {
        e.preventDefault();
      }

      sendRemoteInput({
        eventType: "keydown",
        key: e.key,
      });
    };

    const handleWindowKeyUp = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable)
      ) {
        return;
      }

      if (["Tab", "Space", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace"].includes(e.key)) {
        e.preventDefault();
      }

      sendRemoteInput({
        eventType: "keyup",
        key: e.key,
      });
    };

    window.addEventListener("keydown", handleWindowKeyDown, { capture: true });
    window.addEventListener("keyup", handleWindowKeyUp, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, { capture: true });
      window.removeEventListener("keyup", handleWindowKeyUp, { capture: true });
    };
  }, [isControlActive, isCaller, status]);

  const handleVideoLoadedMetadata = () => {
    if (remoteVideoRef.current) {
      setVideoDims({
        width: remoteVideoRef.current.videoWidth,
        height: remoteVideoRef.current.videoHeight,
      });
    }
  };

  const handleVideoResize = () => {
    if (remoteVideoRef.current) {
      setVideoDims({
        width: remoteVideoRef.current.videoWidth,
        height: remoteVideoRef.current.videoHeight,
      });
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 font-sans transition-colors duration-300 flex flex-col justify-between antialiased">
      
      {/* HEADER */}
      {!(status === "connected" && isCaller && isMaximized) && (
        <header className="px-6 py-5 max-w-4xl mx-auto w-full flex items-center justify-between border-b border-zinc-200/40 dark:border-zinc-800/40">
          <div className="flex flex-col">
            <h1 className="font-semibold tracking-tight text-base leading-tight">ControlDesk Ai</h1>
            <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mt-0.5">Tauri Client</span>
          </div>

          <div className="flex items-center gap-6">
            {/* Subtle real-time signal status indicator */}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${realtimeError ? "bg-red-500 animate-pulse" : "bg-emerald-500 animate-pulse"}`} />
              <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                {realtimeError ? "Signaling Offline" : "Signaling Active"}
              </span>
            </div>

            {/* Theme switcher pill */}
            <div className="p-0.5 bg-zinc-200/50 dark:bg-zinc-900/50 rounded-lg flex gap-0.5 border border-zinc-200/20 dark:border-zinc-800/30">
              {(["light", "system", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all duration-200 cursor-pointer ${
                    theme === t
                      ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </header>
      )}

      {/* MAIN LAYOUT */}
      <main className={
        status === "connected" && isCaller
          ? (isMaximized
              ? "flex-grow flex flex-col justify-center w-screen h-screen bg-black p-0 max-w-none animate-fade-in"
              : "flex-grow flex flex-col justify-center p-6 max-w-7xl mx-auto w-full")
          : "flex-grow flex flex-col justify-center p-6 max-w-4xl mx-auto w-full"
      }>
        
        {/* Signaling Error warning alert */}
        {realtimeError && (
          <div className="mb-6 p-3 bg-red-50/50 dark:bg-red-950/20 border border-red-200/40 dark:border-red-900/30 rounded-xl text-xs text-red-700 dark:text-red-400 flex flex-col gap-1">
            <span>
              <strong>Signaling Error:</strong> {realtimeError}
            </span>
            <span className="text-[10px] text-red-600/80 dark:text-red-400/80">
              💡 Please configure your <code>.env</code> file credentials and restart your Vite server to load the variables properly.
            </span>
          </div>
        )}

        {status === "connected" ? (
          isCaller ? (
            /* VIEWER SCREEN DISPLAY */
            <div className={`w-full mx-auto flex flex-col items-stretch transition-all duration-300 ${
              isMaximized ? "max-w-none h-screen bg-black" : "max-w-7xl"
            }`}>
              {/* Glassmorphic control header (NOT absolute, positioned above the video container) */}
              <div className={`w-full flex items-center justify-between p-3 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-md border border-zinc-200/50 dark:border-zinc-800/40 shadow-sm z-10 transition-all duration-300 ${
                isMaximized ? "rounded-none px-6 py-4" : "rounded-xl mb-3"
              }`}>
                <div className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-semibold text-zinc-900 dark:text-white">Viewing Desk: {activePartnerId}</span>
                  <button
                    onClick={() => setIsControlActive(!isControlActive)}
                    className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                      isControlActive
                        ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30"
                        : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                    }`}
                  >
                    {isControlActive ? "Control Active (Esc to Exit)" : "Click to Control"}
                  </button>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-[11px] font-mono text-zinc-650 dark:text-zinc-300">{formatTime(connectionTime)}</span>
                  
                  {/* Maximize / Minimize View Toggle */}
                  <button
                    onClick={async () => {
                      setIsMaximized(!isMaximized);
                      await toggleTauriMaximize();
                    }}
                    title={isMaximized ? "Restore Layout" : "Maximize View (Theater Mode)"}
                    className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white rounded-lg transition-colors cursor-pointer"
                  >
                    {isMaximized ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9h6m0 0v6m0-6L9 15M4 18V6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                      </svg>
                    )}
                  </button>

                  {/* Native Fullscreen Mode Toggle */}
                  <button
                    onClick={async () => {
                      const success = await toggleTauriFullscreen();
                      if (success === null) {
                        const container = remoteVideoRef.current?.parentElement;
                        if (container) {
                          if (document.fullscreenElement) {
                            document.exitFullscreen();
                          } else {
                            container.requestFullscreen().catch((err) => {
                              console.error("Error attempting to enable full-screen mode:", err);
                            });
                          }
                        }
                      }
                    }}
                    title="Toggle Fullscreen Mode"
                    className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white rounded-lg transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 3h6m0 0v6m0-6L14 10M9 21H3m0 0v-6m0 6l7-7" />
                    </svg>
                  </button>

                  <button
                    onClick={handleDisconnect}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold uppercase tracking-wider cursor-pointer transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              </div>

              <div className={`w-full bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800/50 shadow-2xl relative group flex flex-col overflow-hidden ${
                isMaximized ? "rounded-none flex-grow h-0 border-none" : "rounded-2xl h-[70vh]"
              }`}>
                {/* Scrollable Viewport Wrapper */}
                <div className="w-full flex-grow overflow-auto flex justify-center items-center bg-black">
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onResize={handleVideoResize}
                    onContextMenu={(e) => e.preventDefault()}
                    onMouseMove={(e) => handleVideoMouseEvent(e, "mousemove")}
                    onMouseDown={(e) => handleVideoMouseEvent(e, "mousedown")}
                    onMouseUp={(e) => handleVideoMouseEvent(e, "mouseup")}
                    style={
                      scaleMode === "fit"
                        ? { width: "100%", height: "100%", objectFit: "contain" }
                        : (() => {
                            const multiplier = parseFloat(scaleMode) / 100;
                            const w = videoDims.width > 0 ? videoDims.width * multiplier : 1920 * multiplier;
                            const h = videoDims.height > 0 ? videoDims.height * multiplier : 1080 * multiplier;
                            return {
                              width: `${w}px`,
                              height: `${h}px`,
                              minWidth: `${w}px`,
                              minHeight: `${h}px`,
                              objectFit: "fill",
                            };
                          })()
                    }
                    className={`bg-black outline-none transition-all duration-200 ${
                      isControlActive
                        ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-zinc-900"
                        : "hover:ring-1 hover:ring-zinc-700"
                    }`}
                  />
                </div>

                {/* Apple-style bottom-right size picker */}
                <div className="absolute bottom-4 right-4 flex items-center bg-zinc-950/75 backdrop-blur-md border border-zinc-800/40 rounded-lg p-0.5 shadow-lg z-20 opacity-30 hover:opacity-100 group-hover:opacity-100 transition-opacity duration-300 text-[10px] font-semibold text-zinc-300">
                  {(["fit", "50%", "75%", "100%", "125%", "150%"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setScaleMode(mode)}
                      className={`px-2 py-0.5 rounded-md transition-all cursor-pointer ${
                        scaleMode === mode
                          ? "bg-white/20 text-white shadow-sm font-bold"
                          : "hover:text-white"
                      }`}
                    >
                      {mode === "fit" ? "Fit" : mode}
                    </button>
                  ))}
                </div>

              </div>
            </div>
          ) : (
            /* HOST / SHARER STATE CARD */
            <div className="w-full max-w-md mx-auto bg-white/50 dark:bg-zinc-900/50 backdrop-blur-lg border border-zinc-200/50 dark:border-zinc-800/50 rounded-2xl p-6 shadow-sm flex flex-col items-center">
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 dark:bg-emerald-500/5 border border-emerald-500/20 rounded-full mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">Sharing Screen</span>
              </div>
              
              <h2 className="text-base font-bold mb-1 text-center">Your Screen is Shared</h2>
              <p className="text-zinc-500 dark:text-zinc-400 text-xs text-center mb-6">
                Desk <span className="font-mono font-semibold">{activePartnerId}</span> is viewing your screen.
              </p>

              <div className="w-full space-y-2.5 mb-6 bg-zinc-100/40 dark:bg-zinc-950/40 border border-zinc-200/50 dark:border-zinc-800/50 rounded-xl p-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-zinc-400 dark:text-zinc-500 font-medium">Viewer Desk</span>
                  <span className="font-mono font-semibold">{activePartnerId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400 dark:text-zinc-500 font-medium">Elapsed Time</span>
                  <span className="font-mono font-semibold">{formatTime(connectionTime)}</span>
                </div>
                <div className="flex justify-between border-t border-zinc-200/50 dark:border-zinc-800/50 pt-2.5">
                  <span className="text-zinc-400 dark:text-zinc-500 font-medium">Connection Type</span>
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">P2P (WebRTC)</span>
                </div>
              </div>

              <button
                onClick={handleDisconnect}
                className="w-full h-10 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-all cursor-pointer shadow-sm"
              >
                Stop Sharing Screen
              </button>
            </div>
          )
        ) : (
          /* IDLE DASHBOARD GRID */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
            
            {/* PANEL 1: HOST SETTINGS */}
            <div className="bg-white/50 dark:bg-zinc-900/50 backdrop-blur-lg border border-zinc-200/50 dark:border-zinc-800/50 rounded-2xl p-6 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Screen Access</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                </div>
                
                <h2 className="text-base font-bold mb-1">Host Desk</h2>
                <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-6 leading-relaxed">
                  Provide this ID to your partner to authorize remote access to your device.
                </p>

                {isEditingId ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        maxLength={6}
                        value={customIdInput}
                        onChange={(e) => setCustomIdInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        className="flex-grow h-11 text-center font-mono text-lg tracking-widest bg-zinc-100/50 dark:bg-zinc-950/50 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 transition-all text-zinc-900 dark:text-zinc-50"
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setIsEditingId(false)}
                        className="px-3.5 py-1.5 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-semibold cursor-pointer transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          const val = customIdInput.trim();
                          if (val.length !== 6 || !/^\d{6}$/.test(val)) {
                            alert("Desk ID must be exactly 6 digits.");
                            return;
                          }
                          setMyId(val);
                          setIsEditingId(false);
                        }}
                        className="px-3.5 py-1.5 bg-zinc-900 hover:bg-indigo-600 text-white dark:bg-zinc-50 dark:hover:bg-zinc-200 dark:text-zinc-950 rounded-xl text-xs font-semibold cursor-pointer transition-all shadow-sm"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between bg-zinc-100/50 dark:bg-zinc-950/50 border border-zinc-200/50 dark:border-zinc-800/50 rounded-xl px-4 py-3 font-mono text-xl tracking-wider select-all font-semibold">
                    <span>{myId}</span>
                    <div className="flex gap-3">
                      <button 
                        onClick={copyToClipboard} 
                        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors text-xs flex items-center gap-1 font-sans font-medium tracking-normal select-none cursor-pointer"
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <button 
                        onClick={() => {
                          setCustomIdInput(myId);
                          setIsEditingId(true);
                        }} 
                        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors text-xs flex items-center gap-1 font-sans font-medium tracking-normal select-none cursor-pointer"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                )}

                {/* macOS Assistant instructions helper */}
                {isTauriApp && (
                  <div className="mt-4 p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/40 dark:border-indigo-900/30 rounded-xl text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-400 flex flex-col gap-1.5">
                    <span className="font-semibold flex items-center gap-1.5 text-indigo-800 dark:text-indigo-300">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      macOS Input Assistant Mode
                    </span>
                    <span>
                      Screen capture is disabled inside this Tauri container. To share this machine's screen:
                    </span>
                    <ol className="list-decimal pl-4 space-y-0.5 text-indigo-650 dark:text-indigo-400/90">
                      <li>Open Chrome/Safari at <code className="bg-indigo-100/50 dark:bg-indigo-900/40 px-1 py-0.5 rounded font-mono text-indigo-800 dark:text-indigo-300">http://localhost:1420</code>.</li>
                      <li>Edit this app's Desk ID to match the web browser's generated ID.</li>
                      <li>Accept the connection request on your web browser.</li>
                    </ol>
                  </div>
                )}
              </div>
              
              <div className="mt-8 text-[10px] text-zinc-400 dark:text-zinc-500 text-center sm:text-left">
                Security: End-to-end encrypted signals.
              </div>
            </div>

            {/* PANEL 2: REMOTE CONTROL */}
            <div className="bg-white/50 dark:bg-zinc-900/50 backdrop-blur-lg border border-zinc-200/50 dark:border-zinc-800/50 rounded-2xl p-6 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Remote Control</span>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">Outgoing</span>
                </div>
                
                <h2 className="text-base font-bold mb-1">Control Partner</h2>
                <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-6 leading-relaxed">
                  Enter your partner's ID to establish an encrypted remote session.
                </p>

                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="partner-id-input" className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider pl-0.5">
                      Partner ID
                    </label>
                    <input
                      id="partner-id-input"
                      type="text"
                      maxLength={6}
                      value={partnerIdInput}
                      onChange={(e) => setPartnerIdInput(e.target.value.replace(/\D/g, ""))}
                      placeholder="000000"
                      className="w-full h-11 text-center font-mono text-lg tracking-widest bg-zinc-100/50 dark:bg-zinc-950/50 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 transition-all text-zinc-900 dark:text-zinc-50"
                    />
                  </div>
                  
                  <button
                    onClick={handleConnect}
                    disabled={partnerIdInput.length !== 6}
                    className="w-full h-11 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-50 dark:hover:bg-zinc-200 dark:text-zinc-950 rounded-xl font-medium text-xs transition-all disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                  >
                    Connect
                  </button>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* FOOTER */}
      {!(status === "connected" && isCaller && isMaximized) && (
        <footer className="px-6 py-5 max-w-4xl mx-auto w-full flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-zinc-200/40 dark:border-zinc-800/40 text-[10px] text-zinc-400 dark:text-zinc-500">
          <p>&copy; {new Date().getFullYear()} ControlDesk Ai. All Rights Reserved.</p>
          <div className="flex gap-4">
            <a href="#" className="hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors">Documentation</a>
            <a href="#" className="hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors">Privacy Policy</a>
          </div>
        </footer>
      )}

      {/* --- MODALS --- */}

      {/* 1. CONNECTING STATE OVERLAY */}
      {status === "connecting" && (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800/50 max-w-sm w-full rounded-2xl p-6 shadow-2xl flex flex-col items-center">
            
            <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-700 border-t-zinc-900 dark:border-t-zinc-100 rounded-full animate-spin mb-4" />
            
            <h3 className="text-sm font-semibold mb-1 text-zinc-900 dark:text-zinc-50">Connecting...</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center mb-5 leading-relaxed">
              Sending connection offer to <span className="font-mono font-medium text-zinc-900 dark:text-zinc-50">{activePartnerId}</span>
            </p>

            <button
              onClick={handleCancelConnect}
              className="w-full py-2 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 2. INCOMING CONNECTION REQUEST */}
      {status === "incoming" && (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800/50 max-w-sm w-full rounded-2xl p-6 shadow-2xl flex flex-col items-center">
            
            <h3 className="text-sm font-semibold mb-2 text-zinc-900 dark:text-zinc-50">Incoming Connection</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center mb-5 leading-relaxed">
              Desk <span className="font-mono font-medium text-zinc-900 dark:text-zinc-50">{activePartnerId}</span> wants to connect and view your screen.
            </p>

            <div className="grid grid-cols-2 gap-2 w-full">
              <button
                onClick={handleReject}
                className="py-2 h-9 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer"
              >
                Decline
              </button>
              <button
                onClick={handleAccept}
                className="py-2 h-9 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-50 dark:hover:bg-zinc-200 dark:text-zinc-950 rounded-xl text-xs font-medium transition-all cursor-pointer shadow-sm"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. REJECTED / DECLINED CONNECTION */}
      {status === "rejected" && (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800/50 max-w-sm w-full rounded-2xl p-6 shadow-2xl flex flex-col items-center">
            
            <h3 className="text-sm font-semibold mb-2 text-red-600 dark:text-red-400">Connection Declined</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center mb-5 leading-relaxed">
              Your request to connect to Desk <span className="font-mono font-medium">{activePartnerId}</span> was declined.
            </p>

            <button
              onClick={() => {
                setStatus("idle");
                setActivePartnerId("");
              }}
              className="w-full py-2 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
