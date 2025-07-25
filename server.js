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
let priorityQueue = []; // [{ uri, name, artists, image }]

// --- Authentification Spotify ---
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

// --- File prioritaire enrichie ---
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
    image: track.album.images[0]?.url || ''
  };
  priorityQueue.push(trackInfo);
  res.json({ message: "Track added to priority queue", track: trackInfo });
});

app.get('/priority-queue', (req, res) => {
  res.json({ queue: priorityQueue });
});

app.post('/play-priority', async (req, res) => {
  if (priorityQueue.length === 0) return res.status(400).json({ error: "Priority queue is empty" });
  const track = priorityQueue.shift();
  await fetch('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [track.uri] })
  });
  res.json({ message: "Playing priority track", track });
});

// --- Fichiers statiques ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
