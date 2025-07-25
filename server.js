// server.js – DJ Auto-mix (unique random tracks from playlist 1g39kHQqy4XHxGGftDiUWb)
// Ne joue jamais deux fois le même titre. Lorsqu'il ne reste plus
// de morceaux inédits, on laisse la file se vider : pas de remplissage forcé.

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
const SOURCE_PLAYLIST     = '1g39kHQqy4XHxGGftDiUWb'; // playlist MUSIQUES
const TARGET_QUEUE_LENGTH = 6;                        // file idéale (mais pas obligatoire)

// ----- États -----
let priorityQueue = [];               // [{ uri,name,artists,image,auto }]
const playedTracks = new Set();       // trackId déjà joués (pour éviter les doublons)
let totalTracksInPlaylist = null;     // récupéré une fois pour accélérer

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
setInterval(refreshAccessToken, 50 * 60 * 1000);

/* ------------------------------------------------------------------
   Utils : piocher des titres aléatoires inédits dans la playlist
   ----------------------------------------------------------------*/
async function fetchRandomUniqueTracks(limit = 3) {
  if (limit <= 0) return [];

  const headers = { Authorization: 'Bearer ' + access_token };

  // Récupère le total de titres une seule fois
  if (totalTracksInPlaylist === null) {
    const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${SOURCE_PLAYLIST}?fields=tracks(total)&market=FR`, { headers });
    if (!metaRes.ok) return [];
    totalTracksInPlaylist = (await metaRes.json()).tracks.total;
  }

  // S'il n'y a plus de titres inédits disponibles, retourne []
  if (playedTracks.size >= totalTracksInPlaylist) return [];

  const results = [];
  const triedOffsets = new Set();
  const maxAttempts = Math.min(totalTracksInPlaylist * 2, 500); // sécurité boucle infinie

  for (let attempts = 0; attempts < maxAttempts && results.length < limit; attempts++) {
    const offset = Math.floor(Math.random() * totalTracksInPlaylist);
    if (triedOffsets.has(offset)) continue;
    triedOffsets.add(offset);

    const itemRes = await fetch(`https://api.spotify.com/v1/playlists/${SOURCE_PLAYLIST}/tracks?limit=1&offset=${offset}&market=FR`, { headers });
    if (!itemRes.ok) continue;
    const item = (await itemRes.json()).items?.[0];
    if (!item?.track) continue;

    const trackId = item.track.id;
    if (playedTracks.has(trackId)) continue;                    // déjà joué
    if (priorityQueue.some(t => t.uri === item.track.uri)) continue; // déjà dans la queue

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

  // Tente de compléter avec des titres inédits, mais accepte une file plus courte
  if (missing > 0) {
    const randoms = await fetchRandomUniqueTracks(missing);
    priorityQueue.push(...randoms);
  }

  if (forcePlay && priorityQueue.length) {
    await playNextFromQueue();
  }
}

async function playNextFromQueue() {
  const track = priorityQueue.shift();
  if (!track) return;

  const trackId = track.uri.split(':').pop();
  playedTracks.add(trackId);

  await fetch('https://api.spotify.com/v1/me/player/play', {
    method : 'PUT',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ uris: [track.uri] })
  });
  console.log('▶️ Now playing', track.name, '–', track.artists);
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

  const trackId = uri.split(':').pop();
  if (playedTracks.has(trackId) || priorityQueue.some(t => t.uri === uri)) {
    return res.status(409).json({ error: 'Ce morceau a déjà été joué ou est déjà programmé.' });
  }

  // Infos du titre invité
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
  const track    = await trackRes.json();
  if (track.error) return res.status(500).json({ error: 'Unable to fetch track' });

  const trackInfo = { uri, name: track.name, artists: track.artists.map(a => a.name).join(', '), image: track.album.images?.[0]?.url || '', auto: false };
  priorityQueue.push(trackInfo);

  // Tentative de complétion (mais pas de doublons, donc peut être partiel)
  const missing  = TARGET_QUEUE_LENGTH - priorityQueue.length;
  const autoFill = await fetchRandomUniqueTracks(missing);
  priorityQueue.push(...autoFill);

  res.json({ message: 'Track added + auto-fill', track: trackInfo, auto: autoFill });
});

app.post('/play-priority', async (_req, res) => {
  if (!priorityQueue.length) return res.status(400).json({ error: 'Queue empty' });
  await playNextFromQueue();

  // Remplir si possible (sans doublons)
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const autoTracks = await fetchRandomUniqueTracks(missing);
    priorityQueue.push(...autoTracks);
  }
  res.json({ message: 'Playing next track (unique ensured)' });
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
