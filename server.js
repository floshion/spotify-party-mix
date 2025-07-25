// server.js
// -----------------------------------------------------------------------------
// DJ Auto‑mix v2 – compatible avec les API Spotify encore ouvertes (juillet 2025)
// -----------------------------------------------------------------------------

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// -----------------------------------------------------------------------------
// Config & variables globales
// -----------------------------------------------------------------------------
const app  = express();
const PORT = process.env.PORT || 3000;

const client_id       = process.env.SPOTIFY_CLIENT_ID;
const client_secret   = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri    = process.env.REDIRECT_URI;
let   access_token    = null;
let   refresh_token   = process.env.SPOTIFY_REFRESH_TOKEN || null;

const FALLBACK_PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M"; // Top 50 France

let priorityQueue = [];   // [{ uri, name, artists, image, auto }]
let lastSeedTrack = null; // id Spotify
let lastSeedInfo  = null; // { title, artist }

// -----------------------------------------------------------------------------
// Auth Spotify
// -----------------------------------------------------------------------------
async function refreshAccessToken() {
  if (!refresh_token) return;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method : "POST",
    headers: {
      "Content-Type" : "application/x-www-form-urlencoded",
      "Authorization":
        "Basic " + Buffer.from(`${client_id}:${client_secret}`).toString("base64"),
    },
    body   : new URLSearchParams({
      grant_type   : "refresh_token",
      refresh_token,
    }),
  });
  const data = await res.json();

  if (data.access_token) {
    access_token = data.access_token;
    console.log("🔄 Nouveau access_token généré");
  } else {
    console.error("❌ Échec du refresh token :", data);
  }
}
// refresh toutes les 50 mn
// démarrage immédiat puis refresh toutes les 50 minutes
refreshAccessToken();
setInterval(refreshAccessToken, 50 * 60 * 1000);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function validateTrack(id) {
  const url = `https://api.spotify.com/v1/tracks/${id}?market=FR`;
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + access_token },
  });
  return res.ok;
}

// ► NOUVEAU : génère 3 titres « similaires » sans /recommendations
async function fetchSimilarTracks(trackId, limit = 3) {
  // 1) détails du morceau (pour récupérer l’artiste + genres seed)
  const trackRes = await fetch(
    `https://api.spotify.com/v1/tracks/${trackId}?market=FR`,
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  if (!trackRes.ok) return [];
  const trackData = await trackRes.json();
  const artistId  = trackData.artists?.[0]?.id;
  if (!artistId) return [];

  // 2) genres de l’artiste pour identifier le « style » du morceau
  const artistRes = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}`,
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  const artistData = await artistRes.json();
  const genres     = artistData.genres?.slice(0, 3) || []; // on garde jusqu’à 3 genres pour plus de variété

  let pool = [];

  // 3A) recherche par genre : on veut élargir aux artistes du même style, pas uniquement le même artiste
  for (const g of genres) {
    const q = encodeURIComponent(`genre:"${g}" NOT tag:new`);
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${q}&type=track&market=FR&limit=30`,
      { headers: { Authorization: 'Bearer ' + access_token } }
    );
    const { tracks } = await searchRes.json();
    pool.push(...(tracks?.items || []));
  }

  // 3B) si aucun résultat sur les genres → fallback top‑tracks de l’artiste
  if (pool.length === 0) {
    const topRes = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=FR`,
      { headers: { Authorization: 'Bearer ' + access_token } }
    );
    const { tracks } = await topRes.json();
    pool = tracks || [];
  }

  // 4) déduplication, exclusion du seed et de l’artiste seed pour varier
  const uniques = {};
  pool.forEach(t => { uniques[t.id] = t; });
  const candidates = Object.values(uniques)
    .filter(t => t.id !== trackId) // on exclut seulement le seed pour garantir >= 3 résultats
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);

  // 5) format queue
  return candidates.map(t => ({
    uri    : t.uri,
    name   : t.name,
    artists: t.artists.map(a => a.name).join(', '),
    image  : t.album.images?.[0]?.url || '',
    auto   : true
  }));
}

// -----------------------------------------------------------------------------
// Init seed (si rien ne joue)
// -----------------------------------------------------------------------------
async function initSeedTrack() {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: "Bearer " + access_token },
  });
  if (res.status === 200) {
    const data = await res.json();
    if (data?.item) {
      lastSeedTrack = data.item.id;
      lastSeedInfo = {
        title: data.item.name,
        artist: data.item.artists.map((a) => a.name).join(", "),
      };
      console.log("🎵 Seed initial :", lastSeedInfo.title);
    }
  }
}

// -----------------------------------------------------------------------------
// Auto‑fill queue
// -----------------------------------------------------------------------------
async function autoFillQueue(forcePlay = false) {
  await refreshAccessToken();
  if (!lastSeedTrack) await initSeedTrack();
  if (!lastSeedTrack) {
    console.log("⚠️  Pas de seed dispo");
    return;
  }

  // Vérifie que la seed est valide ; sinon on prend le 1er titre Top 50
  const isValid = await validateTrack(lastSeedTrack);
  if (!isValid) {
    const plRes = await fetch(
      `https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=1&market=FR`,
      { headers: { Authorization: "Bearer " + access_token } },
    );
    const plData = await plRes.json();
    if (plData.items?.length) {
      lastSeedTrack = plData.items[0].track.id;
      lastSeedInfo = {
        title: plData.items[0].track.name,
        artist: plData.items[0].track.artists.map((a) => a.name).join(", "),
      };
    }
  }

  // ► Remplacement de l’appel /recommendations interdit
  if (priorityQueue.length === 0) {
    const newTracks = await fetchSimilarTracks(lastSeedTrack);
    if (newTracks.length) {
      priorityQueue.push(...newTracks);
      console.log("✅ Auto‑fill : 3 titres similaires ajoutés");
    } else {
      console.log("⚠️  Pas de titres similaires trouvés → fallback Top 50");
      const plRes = await fetch(
        `https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=3&market=FR`,
        { headers: { Authorization: "Bearer " + access_token } },
      );
      const plData = await plRes.json();
      plData.items?.forEach((item) => {
        priorityQueue.push({
          uri: item.track.uri,
          name: item.track.name,
          artists: item.track.artists.map((a) => a.name).join(", "),
          image: item.track.album.images?.[0]?.url || "",
          auto: true,
        });
      });
    }
  }

  // Force lecture immédiate (bouton « forcer DJ auto »)
  if (forcePlay && priorityQueue.length) {
    const track = priorityQueue.shift();

    await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [track.uri] }),
    });

    lastSeedTrack = track.uri.split(":").pop();
    lastSeedInfo = { title: track.name, artist: track.artists };
  }
}

// -----------------------------------------------------------------------------
// Routes Spotify Auth
// -----------------------------------------------------------------------------
app.get("/login", (_req, res) => {
  const scope =
    "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state";
  const authUrl =
    "https://accounts.spotify.com/authorize" +
    `?client_id=${client_id}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  if (!code) return res.status(400).send("No code");
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri,
      client_id,
      client_secret,
    }),
  });
  const data = await tokenRes.json();
  access_token = data.access_token;
  refresh_token = data.refresh_token;
  res.redirect("/");
});

app.get("/token", (_req, res) => res.json({ access_token }));

// -----------------------------------------------------------------------------
// API queue (invités + player)
// -----------------------------------------------------------------------------
app.post("/add-priority-track", async (req, res) => {
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: 'No URI provided' });

  // ► Purge les anciens "auto" AVANT d'ajouter le nouveau titre
  priorityQueue = priorityQueue.filter(t => !t.auto);

  const trackId = uri.split(':').pop();
  const trackRes = await fetch(
    `https://api.spotify.com/v1/tracks/${trackId}`,
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  const trackData = await trackRes.json();
  if (trackData.error) return res.status(500).json({ error: 'Impossible de récupérer le morceau' });

  const trackInfo = {
    uri,
    name   : trackData.name,
    artists: trackData.artists.map(a => a.name).join(', '),
    image  : trackData.album.images?.[0]?.url || '',
    auto   : false
  };
  priorityQueue.push(trackInfo); // le morceau invité est joué en priorité

  // ► Met à jour la seed
  lastSeedTrack = trackId;
  lastSeedInfo  = { title: trackData.name, artist: trackInfo.artists };

  // ► Génére immédiatement 3 titres du même STYLE et les ajoute après celui de l'invité
  const autoTracks = await fetchSimilarTracks(trackId, 3);
  priorityQueue.push(...autoTracks);

  res.json({
    message: 'Track added + auto-fill done',
    track  : trackInfo,
    auto   : autoTracks
  });
});


app.post("/play-priority", async (_req, res) => {
  if (!priorityQueue.length) return res.status(400).json({ error: "Priority queue is empty" });

  const track = priorityQueue.shift();
  lastSeedTrack = track.uri.split(":" ).pop();
  lastSeedInfo  = { title: track.name, artist: track.artists };

  await fetch("https://api.spotify.com/v1/me/player/play", {
    method : "PUT",
    headers: {
      Authorization : "Bearer " + access_token,
      "Content-Type": "application/json",
    },
    body   : JSON.stringify({ uris: [track.uri] }),
  });
  res.json({ message: "Playing priority track", track });
});

app.post("/force-auto-fill", async (_req, res) => {
  await autoFillQueue(true);
  res.json({ message: "Auto-fill forcé" });
});

app.get("/priority-queue", (_req, res) => res.json({ queue: priorityQueue }));
app.get("/debug-seed",    (_req, res) => res.json({ seed  : lastSeedInfo || {} }));

// -----------------------------------------------------------------------------
// Static files (player.html, guest.html…)
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// On sert tout le dossier /static
app.use(express.static(path.join(__dirname, "static")));

// Redirection racine → player.html
app.get("/", (_req, res) => res.redirect("/player.html"));

// URL courte pour la page invité
app.get("/guest", (_req, res) => res.redirect("/guest.html"));

// -----------------------------------------------------------------------------
// Lancement serveur + boucle auto-fill
// -----------------------------------------------------------------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
setInterval(() => autoFillQueue(false), 20 * 1000);
