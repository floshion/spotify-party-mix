import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;

let access_token = null;
let refresh_token = null;
let priorityQueue = []; 
let lastSeedTrack = null; 
let lastSeedInfo = { title: "Inconnu", artist: "" };

// --- Auth Spotify ---
app.get('/login', (req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirect_uri,
      client_id: client_id,
      client_secret: client_secret
    })
  });

  const data = await response.json();
  access_token = data.access_token;
  refresh_token = data.refresh_token;

  if (!access_token) return res.status(500).send("Impossible d'obtenir un token Spotify.");

  await initSeedTrack();
  res.redirect('/player.html');
});

app.get('/token', async (req, res) => {
  if (!refresh_token) return res.status(401).json({ error: 'Not authenticated' });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh_token,
      client_id: client_id,
      client_secret: client_secret
    })
  });

  const data = await response.json();
  if (data.error) return res.status(500).json({ error: 'Spotify token refresh failed', details: data });

  access_token = data.access_token;
  res.json({ access_token });
});

// --- Récupère le morceau en cours comme seed ---
async function initSeedTrack() {
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });
    if (res.status === 200) {
      const data = await res.json();
      if (data && data.item) {
        lastSeedTrack = data.item.id;
        lastSeedInfo = { title: data.item.name, artist: data.item.artists.map(a => a.name).join(', ') };
        console.log("Seed mis à jour :", lastSeedInfo.title);
      }
    }
  } catch (e) {
    console.error("Erreur lors de l'init du seed :", e);
  }
}

// --- Ajout musique prioritaire ---
app.post('/add-priority-track', async (req, res) => {
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: "No URI provided" });

  const trackId = uri.split(":").pop();
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { 'Authorization': 'Bearer ' + access_token }
  });
  const track = await trackRes.json();

  if (track.error) return res.status(500).json({ error: "Impossible de récupérer les infos du morceau" });

  const trackInfo = {
    uri: uri,
    name: track.name,
    artists: track.artists.map(a => a.name).join(', '),
    image: track.album.images[0]?.url || '',
    auto: false
  };
  priorityQueue.push(trackInfo);
  lastSeedTrack = track.id;
  lastSeedInfo = { title: track.name, artist: track.artists.map(a => a.name).join(', ') };
  res.json({ message: "Track added to priority queue", track: trackInfo });
});

// --- Lecture musique prioritaire ---
app.post('/play-priority', async (req, res) => {
  if (priorityQueue.length === 0) return res.status(400).json({ error: "Priority queue is empty" });
  const track = priorityQueue.shift();
  lastSeedTrack = track.uri.split(":").pop();
  lastSeedInfo = { title: track.name, artist: track.artists };
  await fetch('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [track.uri] })
  });
  res.json({ message: "Playing priority track", track });
});

// --- Voir la file ---
app.get('/priority-queue', (req, res) => {
  res.json({ queue: priorityQueue });
});

// --- DEBUG : renvoie le seed actuel ---
app.get('/debug-seed', (req, res) => {
  res.json({ seed: lastSeedTrack, title: lastSeedInfo.title, artist: lastSeedInfo.artist });
});

// --- Forcer DJ Auto ---
app.post('/force-auto-fill', async (req, res) => {
  await autoFillQueue(true);
  res.json({ message: "Auto-fill forcé" });
});

// --- Auto-fill queue ---
async function autoFillQueue(forcePlay = false) {
  try {
    if (!lastSeedTrack) {
      await initSeedTrack();
      if (!lastSeedTrack) {
        console.log("⚠️ Pas de seed disponible pour recommandations.");
        return;
      }
    }

    if (priorityQueue.length === 0) {
      const url = `https://api.spotify.com/v1/recommendations?limit=3&market=FR&seed_tracks=${lastSeedTrack}`;
      console.log("🎯 Requête recommandations :", url);

      const recRes = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + access_token }
      });

      if (!recRes.ok) {
        const errText = await recRes.text();
        console.error(`❌ Erreur Spotify (${recRes.status}) : ${errText}`);
        return;
      }

      let recData;
      try {
        recData = await recRes.json();
      } catch (err) {
        console.error("❌ Impossible de parser la réponse recommandations :", err);
        const rawText = await recRes.text();
        console.log("Réponse brute :", rawText);
        return;
      }

      if (!recData.tracks || recData.tracks.length === 0) {
        console.log("⚠️ Aucune reco trouvée → fallback Top 50 France");
        const playlistRes = await fetch('https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/tracks?limit=3', {
          headers: { 'Authorization': 'Bearer ' + access_token }
        });
        const playlistData = await playlistRes.json();
        recData.tracks = playlistData.items.map(item => item.track);
      }

      if (recData.tracks && recData.tracks.length > 0) {
        const newTracks = recData.tracks.map(track => ({
          uri: track.uri,
          name: track.name,
          artists: track.artists.map(a => a.name).join(', '),
          image: track.album.images[0]?.url || '',
          auto: true
        }));
        priorityQueue.push(...newTracks);
        console.log("✅ Auto-fill : ajout de recommandations");
      }
    }

    const playingRes = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });
    const playingData = await playingRes.json();
    if ((!playingData.is_playing || forcePlay) && priorityQueue.length > 0) {
      const firstTrack = priorityQueue.shift();
      lastSeedTrack = firstTrack.uri.split(":").pop();
      lastSeedInfo = { title: firstTrack.name, artist: firstTrack.artists };
      await fetch('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [firstTrack.uri] })
      });
      console.log("▶️ Lecture auto démarrée :", firstTrack.name);
    }
  } catch (err) {
    console.error("❌ Erreur autoFillQueue:", err);
  }
}

// Vérification toutes les 5s
setInterval(autoFillQueue, 5000);

// --- Fichiers statiques ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
