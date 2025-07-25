import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "static")));
app.use(express.json());

let accessToken = null;
let refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

let priorityQueue = [];
let currentPlaylist = null;

async function refreshAccessToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const data = await res.json();
  accessToken = data.access_token;
  console.log("🔄 Nouveau access_token généré");
}
await refreshAccessToken();
setInterval(refreshAccessToken, 50 * 60 * 1000);

app.get("/token", (req, res) => res.json({ access_token: accessToken }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "static", "player.html")));
app.get("/guest", (req, res) => res.sendFile(path.join(__dirname, "static", "guest.html")));

app.get("/priority-queue", (req, res) => res.json({ queue: priorityQueue }));

app.post("/add-priority-track", async (req, res) => {
  const trackUri = req.query.uri;
  if (!trackUri) return res.status(400).json({ error: "Missing uri" });
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackUri.split(":").pop()}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const track = await trackRes.json();
  priorityQueue.push({
    uri: track.uri,
    name: track.name,
    artists: track.artists.map(a => a.name).join(", "),
    image: track.album.images[0]?.url
  });
  console.log("🎵 Ajouté à la file prioritaire:", track.name);
  res.json({ success: true });
});

// Définir la playlist
app.post("/set-playlist", (req, res) => {
  currentPlaylist = req.body.uri;
  console.log("🎶 Playlist de fond définie:", currentPlaylist);
  res.json({ success: true });
});

// Lire le prochain morceau (priorité ou playlist)
async function autoFillPlayback() {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (res.status !== 200) return;
  const data = await res.json();
  if (!data || !data.item) return;

  const progress = data.progress_ms;
  const duration = data.item.duration_ms;
  if (progress >= duration - 2000) {
    if (priorityQueue.length > 0) {
      console.log("▶️ Lecture d'un titre prioritaire");
      await playNextPriority();
    } else if (currentPlaylist) {
      console.log("⏯ Retour à la playlist");
      await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ context_uri: currentPlaylist })
      });
    }
  }
}

async function playNextPriority() {
  const nextTrack = priorityQueue.shift();
  await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: [nextTrack.uri] })
  });
}

setInterval(autoFillPlayback, 5000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
