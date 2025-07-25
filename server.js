// server.js – DJ Auto-mix
// -------------------------------------------------------------
// • Pioche aléatoire dans la playlist « MUSIQUES » (1g39kHQqy4XHxGGftDiUWb)
// • Ne rejoue jamais un titre déjà diffusé
// • Les morceaux ajoutés manuellement (invités) sont prioritaires
// • Si tous les titres ont été joués, la file peut être plus courte que 6
// -------------------------------------------------------------

import express from "express";
import dotenv  from "dotenv";
import path    from "path";
import { fileURLToPath } from "url";

// -----------------------------------------------------------------------------
// Initialisation
// -----------------------------------------------------------------------------
dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;

// Spotify API credentials (gardés en variables d'env pour plus de sûreté)
const client_id     = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri  = process.env.REDIRECT_URI || "http://localhost:3000/callback";
let   access_token  = null;
let   refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null;

// DJ paramètres
const PLAYLIST_ID          = "1g39kHQqy4XHxGGftDiUWb"; // playlist MUSIQUES
const TARGET_QUEUE_LENGTH  = 6;                        // taille idéale

// État runtime
let priorityQueue  = [];                // [{ uri, name, artists, image, auto }]
const playedTracks = new Set();         // IDs déjà joués
let playlistTotal  = null;              // nb total de titres (fetch 1x)

// -----------------------------------------------------------------------------
// Helpers Spotify
// -----------------------------------------------------------------------------
async function refreshAccessToken() {
  if (!refresh_token) return;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method : "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${client_id}:${client_secret}`).toString("base64")
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token })
  });
  const data = await res.json();
  if (data.access_token) {
    access_token = data.access_token;
    console.log("🔄  Token Spotify rafraîchi");
  } else {
    console.error("❌  Refresh token error", data);
  }
}

// Premier token + refresh périodique (50 min)
await refreshAccessToken();
setInterval(refreshAccessToken, 50 * 60 * 1000);

// -----------------------------------------------------------------------------
// Tirage aléatoire de titres inédits dans la playlist
// -----------------------------------------------------------------------------
async function fetchRandomUniqueTracks(limit = 3) {
  if (limit <= 0) return [];
  if (!access_token) return [];

  const headers = { Authorization: "Bearer " + access_token };

  // Récupère le total une seule fois
  if (playlistTotal === null) {
    const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=tracks(total)&market=FR`, { headers });
    if (!metaRes.ok) return [];
    playlistTotal = (await metaRes.json()).tracks.total;
  }

  // Tous les titres ont déjà été joués → rien à piocher
  if (playedTracks.size >= playlistTotal) return [];

  const results    = [];
  const attempted  = new Set();
  const maxTrials  = Math.min(playlistTotal * 2, 500); // sécurité

  for (let i = 0; i < maxTrials && results.length < limit; i++) {
    const offset = Math.floor(Math.random() * playlistTotal);
    if (attempted.has(offset)) continue;
    attempted.add(offset);

    const itemRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?limit=1&offset=${offset}&market=FR`, { headers });
    if (!itemRes.ok) continue;
    const item = (await itemRes.json()).items?.[0];
    if (!item?.track) continue;

    const trackId = item.track.id;
    if (playedTracks.has(trackId)) continue;                       // déjà joué
    if (priorityQueue.some(t => t.uri === item.track.uri)) continue; // déjà programmé

    results.push({
      uri    : item.track.uri,
      name   : item.track.name,
      artists: item.track.artists.map(a => a.name).join(", "),
      image  : item.track.album.images?.[0]?.url || "",
      auto   : true
    });
  }
  return results;
}

// -----------------------------------------------------------------------------
// File d'attente & lecture
// -----------------------------------------------------------------------------
async function playTrack(track) {
  if (!track) return;
  const trackId = track.uri.split(":").pop();
  playedTracks.add(trackId);

  await fetch("https://api.spotify.com/v1/me/player/play", {
    method : "PUT",
    headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json" },
    body   : JSON.stringify({ uris: [track.uri] })
  });
  console.log("▶️  Playing", track.name, "–", track.artists);
}

async function autoFillQueue() {
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing <= 0) return;

  const newAutos = await fetchRandomUniqueTracks(missing);
  priorityQueue.push(...newAutos);
}

// -----------------------------------------------------------------------------
// Express routes
// -----------------------------------------------------------------------------
app.use(express.json());

// OAuth
app.get("/login", (_req, res) => {
  const scope = "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state";
  const url =
    "https://accounts.spotify.com/authorize" +
    `?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method : "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body   : new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri, client_id, client_secret })
  });
  const data = await tokenRes.json();
  access_token  = data.access_token;
  refresh_token = data.refresh_token;
  console.log("✅  OAuth completed");
  res.redirect("/");
});

// Token pour le front
app.get("/token", (_req, res) => res.json({ access_token }));

// Liste de la file
app.get("/priority-queue", (_req, res) => res.json({ queue: priorityQueue }));

// Ajout d'un morceau manuel (URI Spotify) → priorité
app.post("/add-priority-track", async (req, res) => {
  const uri = req.query.uri || req.body.uri;
  if (!uri) return res.status(400).json({ error: "No URI provided" });

  const trackId = uri.split(":").pop();
  if (playedTracks.has(trackId)) return res.status(409).json({ error: "Track already played" });
  if (priorityQueue.some(t => t.uri === uri)) return res.status(409).json({ error: "Track already queued" });

  // Fetch track info
  const headers = { Authorization: "Bearer " + access_token };
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}?market=FR`, { headers });
  const track = await trackRes.json();
  if (track.error) return res.status(500).json({ error: "Spotify track fetch failed" });

  // Retire tous les autos pour que les manuels passent en premier
  priorityQueue = priorityQueue.filter(t => !t.auto);

  const trackInfo = {
    uri,
    name   : track.name,
    artists: track.artists.map(a => a.name).join(", "),
    image  : track.album.images?.[0]?.url || "",
    auto   : false
  };
  priorityQueue.push(trackInfo);

  // Complète la file (autos) sans doublons
  await autoFillQueue();

  // Si rien ne joue ou si le titre actuel est auto, on peut jouer immédiatement
  // Ici, on fait simple : si la file ne contenait aucun manuel avant (queue.length === 1), on lance.
  if (priorityQueue.length === 1) await playTrack(priorityQueue.shift());

  return res.json({ message: "Track added", track: trackInfo, queue: priorityQueue });
});

// Lecture explicite du prochain titre prioritaire
app.post("/play-priority", async (_req, res) => {
  if (!priorityQueue.length) {
    await autoFillQueue();
    if (!priorityQueue.length) return res.status(400).json({ error: "Queue empty" });
  }

  const next = priorityQueue.shift();
  await playTrack(next);
  await autoFillQueue();
  res.json({ message: "Now playing", track: next });
});

// -----------------------------------------------------------------------------
// Fichiers statiques
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "static")));
app.get("/",    (_req, res) => res.redirect("/player.html"));
app.get("/guest",(_req, res) => res.redirect("/guest.html"));

// -----------------------------------------------------------------------------
// Lancement
// -----------------------------------------------------------------------------
app.listen(PORT, () => console.log(`🚀  Server ready on port ${PORT}`));

// Premier remplissage + refresh périodique
await autoFillQueue();
setInterval(autoFillQueue, 20 * 1000);
