// server.js – DJ Auto-mix (random tracks from playlist 1g39kHQqy4XHxGGftDiUWb)
// Version simplifiée : la file d’attente est complétée exclusivement avec des titres
// aléatoires issus de la playlist personnelle « MUSIQUES  ».

import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import path    from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ----- Spotify credentials (gardés en variables d’environnement) -----
const client_id     = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri  = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
let   access_token  = null;
let   refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null;

// ----- Paramètres DJ -----
const SOURCE_PLAYLIST      = '1g39kHQqy4XHxGGftDiUWb';   // <-- ID de la playlist MUSIQUES
const TARGET_QUEUE_LENGTH  = 6;                          // taille désirée de la file

let priorityQueue = [];                                  // [{ uri,name,artists,image,auto }]

/* ------------------------------------------------------------------
   Auth helpers
   ----------------------------------------------------------------*/
async function refreshAccessToken () {
  if (!refresh_token) return;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method  : 'POST',
    headers : {
      'Content-Type' : 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
    },
    body    : new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
  });
  const data = await res.json();
  if (data.access_token) {
    access_token = data.access_token;
    console.log('🔄 Nouveau access_token');
  } else console.error('❌ Refresh KO :', data);
}
await refreshAccessToken();
setInterval(refreshAccessToken, 50 * 60 * 1000); // rafraîchit toutes les 50 min

/* ------------------------------------------------------------------
   Utils : piocher des titres aléatoires dans une playlist
   ----------------------------------------------------------------*/
async function fetchRandomTracksFromPlaylist (playlistId, limit = 3) {
  if (limit <= 0) return [];
  const headers = { Authorization: 'Bearer ' + access_token };

  // 1) total de titres
  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=tracks(total)&market=FR`, { headers });
  if (!metaRes.ok) return [];
  const total = (await metaRes.json()).tracks.total;

  const taken   = new Set();
  const results = [];

  while (results.length < limit && taken.size < total) {
    const offset = Math.floor(Math.random() * total);
    if (taken.has(offset)) continue;
    taken.add(offset);

    const itemRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=1&offset=${offset}&market=FR`, { headers });
    if (!itemRes.ok) continue;
    const item = (await itemRes.json()).items?.[0];
    if (!item?.track) continue;

    results.push({
      uri    : item.track.uri,
      name   : item.track.name,
      artists: item.track.artists.map(a => a.name).join(', '),
      image  : item.track.album.images?.[0]?.url || '',
      auto   : true
    });
  }
  return results;
}

/* ------------------------------------------------------------------
   Queue management
   ----------------------------------------------------------------*/
async function autoFillQueue (forcePlay = false) {
  await refreshAccessToken();
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const randoms = await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, missing);
    priorityQueue.push(...randoms);
  }

  // Lecture immédiate si demandé
  if (forcePlay && priorityQueue.length) {
    const track = priorityQueue.shift();
    await fetch('https://api.spotify.com/v1/me/player/play', {
      method : 'PUT',
      headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ uris: [track.uri] })
    });
    console.log('▶️ Now playing', track.name, '–', track.artists);
  }
}

/* ------------------------------------------------------------------
   Auth routes
   ----------------------------------------------------------------*/
app.get('/login', (_req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const url = 'https://accounts.spotify.com/authorize' +
    `?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
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

app.get('/token',  (_req, res) => res.json({ access_token }));
app.get('/config', (_req, res) => res.json({ source_playlist: SOURCE_PLAYLIST }));

/* ------------------------------------------------------------------
   Priority queue routes
   ----------------------------------------------------------------*/
app.post('/add-priority-track', async (req, res) => {
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: 'No URI provided' });

  // On purge les autos pour éviter l’inflation
  priorityQueue = priorityQueue.filter(t => !t.auto);

  // Infos du titre invité
  const trackId  = uri.split(':').pop();
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
  const track    = await trackRes.json();

  const trackInfo = { uri, name: track.name, artists: track.artists.map(a => a.name).join(', '), image: track.album.images?.[0]?.url || '', auto: false };
  priorityQueue.push(trackInfo);

  // Compléter
  const missing  = TARGET_QUEUE_LENGTH - priorityQueue.length;
  const autoFill = await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, missing);
  priorityQueue.push(...autoFill);

  res.json({ message: 'Track added + auto-fill', track: trackInfo, auto: autoFill });
});

app.post('/play-priority', async (_req, res) => {
  if (!priorityQueue.length) return res.status(400).json({ error: 'Queue empty' });
  const track = priorityQueue.shift();
  await fetch('https://api.spotify.com/v1/me/player/play', {
    method : 'PUT',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ uris: [track.uri] })
  });
  console.log('▶️ Now playing', track.name, '–', track.artists);

  // Remplir à nouveau
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const autoTracks = await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, missing);
    priorityQueue.push(...autoTracks);
  }
  res.json({ message: 'Playing next track', track });
});

app.get('/priority-queue', (_req, res) => res.json({ queue: priorityQueue }));

/* ------------------------------------------------------------------
   Static files
   ----------------------------------------------------------------*/
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));
app.get('/',    (_req, res) => res.redirect('/player.html'));
app.get('/guest',(_req, res) => res.redirect('/guest.html'));

/* ------------------------------------------------------------------
   Boot
   ----------------------------------------------------------------*/
app.listen(PORT, () => console.log(`🚀 Server ready on port ${PORT}`));
setInterval(() => autoFillQueue(false), 20 * 1000);
