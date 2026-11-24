"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "stream_viewer_token";

type StreamItem = {
  id: string | number;
  label?: string;
  resolution?: string;
  status?: string;
  created_at?: string;
};

export default function Page() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [gateError, setGateError] = useState("");

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY));
    } catch {}
    setReady(true);
  }, []);

  if (!ready) return null;

  if (!token) {
    return (
      <form
        className="panel gate"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          try {
            localStorage.setItem(TOKEN_KEY, t);
          } catch {}
          setGateError("");
          setToken(t);
        }}
      >
        <strong>Private viewer</strong>
        <input
          type="password"
          placeholder="Access token"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
        <button type="submit">Unlock</button>
        {gateError && <div className="error">{gateError}</div>}
      </form>
    );
  }

  return (
    <Viewer
      token={token}
      onAuthFail={() => {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {}
        setGateError("Token rejected");
        setToken(null);
      }}
      onLogout={() => {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {}
        setToken(null);
      }}
    />
  );
}

function Viewer({
  token,
  onAuthFail,
  onLogout,
}: {
  token: string;
  onAuthFail: () => void;
  onLogout: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [items, setItems] = useState<StreamItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState("IDLE");
  const [status, setStatus] = useState("Select a stream on the right to play");

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(API_BASE + path, {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        onAuthFail();
        throw new Error("Unauthorized");
      }
      return res;
    },
    [token, onAuthFail]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("Loading stream list...");
      try {
        const res = await api("/api/streams");
        const data = await res.json();
        if (cancelled) return;
        const list: StreamItem[] = data.items || [];
        setItems(list);
        setStatus(list.length ? "Select a stream to play" : "No streams found");
      } catch (err) {
        if (!cancelled) setStatus("Request error: " + err);
      }
    })();
    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
    };
  }, [api]);

  function playProxiedM3u8(childUrl: string, referer: string) {
    const video = videoRef.current;
    if (!video) return;
    const qs = `url=${encodeURIComponent(childUrl)}&ref=${encodeURIComponent(referer)}`;
    const proxied = `${API_BASE}/proxy?${qs}`;

    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Every playlist / segment request carries the token as a header.
        xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${token}`),
      });
      hlsRef.current = hls;
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus("Playing stream");
        video.play().catch(() => setStatus("Ready — click play to start"));
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setStatus("Playback error: " + data.details);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS (Safari/iOS) cannot set headers, so the token goes in the query string.
      video.src = `${proxied}&t=${encodeURIComponent(token)}`;
      video.play().catch(() => {});
    } else {
      setStatus("HLS is not supported in this browser.");
    }
  }

  async function selectStream(item: StreamItem) {
    const id = String(item.id);
    setActiveId(id);
    setActiveLabel(item.label || item.resolution || "STREAM");
    setStatus(`Resolving stream ${id}...`);
    try {
      const res = await api(`/api/streams/${encodeURIComponent(id)}/resolve`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("Resolve failed: " + (data.error || res.status));
        return;
      }
      setStatus("Loading playlist...");
      playProxiedM3u8(data.child_url, data.page_url);
    } catch (err) {
      setStatus("Request error: " + err);
    }
  }

  return (
    <div className="layout">
      <div className="panel">
        <video ref={videoRef} controls autoPlay playsInline />
        <div className="player-bar">
          <span>{status}</span>
          <span className="badge">{activeLabel}</span>
        </div>
      </div>

      <div className="panel">
        <div className="sidebar-header">
          <span>Streams</span>
          <span className="sub">
            {items.length} items ·{" "}
            <button className="link-btn" onClick={onLogout}>
              lock
            </button>
          </span>
        </div>
        <div className="stream-list">
          {items.map((item, idx) => (
            <button
              key={String(item.id)}
              className={"stream-item" + (activeId === String(item.id) ? " active" : "")}
              onClick={() => selectStream(item)}
            >
              <div className="item-top">
                <strong>
                  #{idx + 1} · {item.resolution || "unknown"}
                </strong>
                <span className="badge">{item.label || "N/A"}</span>
              </div>
              <div className="sub">id: {String(item.id)}</div>
              <div className="sub">
                status: {item.status || "unknown"} · {item.created_at || ""}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
