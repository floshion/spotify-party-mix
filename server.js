import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";

// ──────────────────────────────────────────────────────────────────────────────
//  ENV & BASICS
// ──────────────────────────────────────────────────────────────────────────────
dotenv.config();

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  DEFAULT_PLAYLIST_ID,
  PORT = 10000,
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  throw new Error("✖️  Missing Spotify credentials in .env file");
}

const app = express();
app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────────────────────────────────────
//  SPOTIFY AUTH  
// ──────────────────────────────────────────────────────────────────────────────
let accessToken;
let tokenExpiresAt = 0;

async function refreshAccessToken() {
  const basic = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Cannot refresh token (${res.status}): ${txt}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // renew 1 min early
  console.log("🔄  token refresh");
}

async function ensureToken() {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    await refreshAccessToken();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  RATE-LIMIT HANDLING
// ──────────────────────────────────────────────────────────────────────────────
const limiter = new Bottleneck({
  minTime: 1000, // 1 req/s max
  reservoir: 95,
  reservoirRefreshAmount: 95,
  reservoirRefreshInterval: 30 * 1000, // 30 s window
});

async function spotifyFetch(url, options = {}, retries = 3) {
  await ensureToken();

  const res = await limiter.schedule(() =>
    fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    })
  );

  if (res.status === 429) {
    const retryAfter =
      parseInt(res.headers.get("Retry-After") || "1", 10) * 1000;
    if (retries > 0) {
      console.warn(`Rate-limited, retry in ${retryAfter / 1000}s…`);
      await new Promise((r) => setTimeout(r, retryAfter));
      return spotifyFetch(url, options, retries - 1);
    }
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Spotify ${res.status}: ${txt}`);
  }

  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────────
//  PLAYLIST HELPERS
// ──────────────────────────────────────────────────────────────────────────────
async function getPlaylistTracks(playlistId) {
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  const items = [];

  while (url) {
    const data = await spotifyFetch(url);
    items.push(...data.items);
    url = data.next;
  }

  return items;
}

function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
//  IN-MEMORY QUEUE & AUTO-FILL
// ──────────────────────────────────────────────────────────────────────────────
const queue = [];

async function autoFillQueue(playlistId, desiredLength = 20) {
  if (!playlistId) return;
  if (queue.length >= desiredLength) return;

  try {
    const tracks = await getPlaylistTracks(playlistId);
    const picks = sample(tracks, desiredLength - queue.length);
    queue.push(...picks.map((p) => p.track));
    console.log(`Queue refilled → ${queue.length} tracks`);
  } catch (err) {
    console.error("autoFillQueue error:", err.message);
  }
}

setInterval(() => autoFillQueue(DEFAULT_PLAYLIST_ID), 15 * 1000);

// ──────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("Spotify Party Mix – up"));

app.get("/queue", (_, res) => res.json({ queue }));

app.post("/next", (_, res) => {
  const track = queue.shift();
  res.json({ track });
});

app.get("/random-tracks", async (req, res) => {
  try {
    const playlistId = req.query.playlistId || DEFAULT_PLAYLIST_ID;
    const amount = parseInt(req.query.amount || "10", 10);

    if (!playlistId) {
      return res.status(400).json({ error: "playlistId is required" });
    }

    const items = await getPlaylistTracks(playlistId);
    res.json({ tracks: sample(items, amount).map((i) => i.track) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
//  START
// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Server sur ${PORT}`);
});
