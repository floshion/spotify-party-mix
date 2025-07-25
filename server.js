// server.js
// DJ Auto-mix v4 – maintient 6 morceaux uniques (anti-doublons multi-albums)

import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import path    from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const client_id     = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri  = process.env.REDIRECT_URI;
let   access_token  = null;
let   refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null;

const FALLBACK_PLAYLIST   = '37i9dQZF1DXcBWIGoYBM5M';
const TARGET_QUEUE_LENGTH = 6;

let priorityQueue = [];
let lastSeedTrack = null;
let lastSeedInfo  = null;

async function refreshAccessToken() {
  if (!refresh_token) return;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
    },
    body   : new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
  });
  const data = await res.json();
  if (data.access_token) {
    access_token = data.access_token;
    console.log('🔄 Nouveau access_token généré');
  } else console.error('❌ Refresh token KO :', data);
}
await refreshAccessToken();
setInterval(refreshAccessToken, 50 * 60 * 1000);

async function validateTrack(id) {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
  return res.ok;
}

async function fetchSimilarTracks(trackId, limit = 3) {
  if (limit <= 0) return [];
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
  if (!trackRes.ok) return [];
  const trackData = await trackRes.json();
  const artistId  = trackData.artists?.[0]?.id;
  if (!artistId) return [];

  const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers: { Authorization: 'Bearer ' + access_token } });
  const artistData = await artistRes.json();
  const genres     = artistData.genres?.slice(0, 3) || [];

  let pool = [];
  for (const g of genres) {
    const q = encodeURIComponent(`genre:"${g}" NOT tag:new`);
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&market=FR&limit=40`, { headers: { Authorization: 'Bearer ' + access_token } });
    const { tracks } = await searchRes.json();
    pool.push(...(tracks?.items || []));
  }
  if (pool.length === 0) {
    const topRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
    const { tracks } = await topRes.json();
    pool = tracks || [];
  }

  // Déduplication avancée : titre + artistes (évite multi-albums)
  const uniques = {};
  pool.forEach(t => {
    const key = `${t.name.toLowerCase()}-${t.artists.map(a => a.name.toLowerCase()).join(',')}`;
    if (!uniques[key]) uniques[key] = t;
  });
  const candidates = Object.values(uniques)
    .filter(t => t.id !== trackId)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);

  return candidates.map(t => ({
    uri    : t.uri,
    name   : t.name,
    artists: t.artists.map(a => a.name).join(', '),
    image  : t.album.images?.[0]?.url || '',
    auto   : true
  }));
}

async function initSeedTrack() {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { Authorization: 'Bearer ' + access_token } });
  if (res.status === 200) {
    const data = await res.json();
    if (data?.item) {
      lastSeedTrack = data.item.id;
      lastSeedInfo  = { title: data.item.name, artist: data.item.artists.map(a => a.name).join(', ') };
      console.log('🎵 Seed initial :', lastSeedInfo.title);
    }
  }
}

async function autoFillQueue(forcePlay = false) {
  await refreshAccessToken();
  if (!lastSeedTrack) await initSeedTrack();
  if (!lastSeedTrack) return;

  if (!(await validateTrack(lastSeedTrack))) {
    const plRes = await fetch(`https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=1&market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
    const plData = await plRes.json();
    if (plData.items?.length) {
      lastSeedTrack = plData.items[0].track.id;
      lastSeedInfo  = { title: plData.items[0].track.name, artist: plData.items[0].track.artists.map(a => a.name).join(', ') };
    }
  }

  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const newTracks = await fetchSimilarTracks(lastSeedTrack, missing);
    if (newTracks.length) {
      priorityQueue.push(...newTracks);
    } else {
      const plRes = await fetch(`https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=${missing}&market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
      const plData = await plRes.json();
      plData.items?.slice(0, missing).forEach(item => {
        priorityQueue.push({
          uri    : item.track.uri,
          name   : item.track.name,
          artists: item.track.artists.map(a => a.name).join(', '),
          image  : item.track.album.images?.[0]?.url || '',
          auto   : true
        });
      });
    }
  }

  if (forcePlay && priorityQueue.length) {
    const track = priorityQueue.shift();
    await fetch('https://api.spotify.com/v1/me/player/play', {
      method : 'PUT',
      headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ uris: [track.uri] })
    });
    lastSeedTrack = track.uri.split(':').pop();
    lastSeedInfo  = { title: track.name, artist: track.artists };
  }
}

// Routes Auth
app.get('/login', (_req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  res.redirect('https://accounts.spotify.com/authorize' + `?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scope)}`);
});
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri, client_id, client_secret })
  });
  const data = await tokenRes.json();
  access_token  = data.access_token;
  refresh_token = data.refresh_token;
  res.redirect('/');
});
app.get('/token', (_req, res) => res.json({ access_token }));

// Routes queue
app.post('/add-priority-track', async (req, res) => {
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: 'No URI provided' });

  priorityQueue = priorityQueue.filter(t => !t.auto);
  const trackId = uri.split(':').pop();
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: 'Bearer ' + access_token } });
  const trackData = await trackRes.json();
  if (trackData.error) return res.status(500).json({ error: 'Unable to fetch track' });

  const trackInfo = { uri, name: trackData.name, artists: trackData.artists.map(a => a.name).join(', '), image: trackData.album.images?.[0]?.url || '', auto: false };
  priorityQueue.push(trackInfo);
  lastSeedTrack = trackId;
  lastSeedInfo  = { title: trackData.name, artist: trackInfo.artists };

  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  const autoTracks = await fetchSimilarTracks(trackId, missing);
  priorityQueue.push(...autoTracks);

  res.json({ message: 'Track added + auto-fill', track: trackInfo, auto: autoTracks });
});

app.post('/play-priority', async (_req, res) => {
  if (!priorityQueue.length) return res.status(400).json({ error: 'Queue vide' });
  const track = priorityQueue.shift();
  lastSeedTrack = track.uri.split(':').pop();
  lastSeedInfo  = { title: track.name, artist: track.artists };
  await fetch('https://api.spotify.com/v1/me/player/play', {
    method : 'PUT',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ uris: [track.uri] })
  });
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const autoTracks = await fetchSimilarTracks(lastSeedTrack, missing);
    priorityQueue.push(...autoTracks);
  }
  res.json({ message: 'Playing next track', track });
});

app.get('/priority-queue', (_req, res) => res.json({ queue: priorityQueue }));

// Static
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));
app.get('/', (_req, res) => res.redirect('/player.html'));
app.get('/guest', (_req, res) => res.redirect('/guest.html'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
setInterval(() => autoFillQueue(false), 20 * 1000);
