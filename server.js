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
const redirect_uri  = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
let   access_token  = null;
let   refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null;

const SOURCE_PLAYLIST      = '1g39kHQqy4XHxGGftDiUWb';
const TARGET_QUEUE_LENGTH  = 6;

let priorityQueue = [];     
let playedTracks  = new Set(); 
let lastPlaylistTotal = 0; 

/* ------------------------------------------------------------------
   Auth helpers
------------------------------------------------------------------ */
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
   Utils : tracks
------------------------------------------------------------------ */
function purgeQueue() {
  priorityQueue = priorityQueue.filter(track => !playedTracks.has(track.uri));
}

function deduplicateQueue() {
  const seen = new Set();
  priorityQueue = priorityQueue.filter(track => {
    if (seen.has(track.uri)) return false;
    seen.add(track.uri);
    return true;
  });
}

async function fetchRandomTracksFromPlaylist (playlistId, limit = 3) {
  if (limit <= 0) return [];
  const headers = { Authorization: 'Bearer ' + access_token };

  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=tracks(total)&market=FR`, { headers });
  if (!metaRes.ok) return [];
  const total = (await metaRes.json()).tracks.total;

  if (playedTracks.size >= total) {
    console.log("⚠️ Tous les morceaux disponibles ont été joués.");
    return [];
  }

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

    if (playedTracks.has(item.track.uri)) continue;

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

async function autoFillQueue () {
  purgeQueue();
  deduplicateQueue();
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if (missing > 0) {
    const randoms = await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, missing);
    priorityQueue.push(...randoms);
    deduplicateQueue();
  }
}

/* ------------------------------------------------------------------
   Polling : détecter la fin et enchaîner
------------------------------------------------------------------ */
async function pollCurrentTrack() {
  if (!access_token) return;
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (res.status === 204) return;
    if (!res.ok) return;
    const data = await res.json();

    const currentUri = data?.item?.uri;
    if (currentUri && !playedTracks.has(currentUri)) {
      playedTracks.add(currentUri);
      console.log('🎵 Ajouté aux joués:', data.item.name);
      purgeQueue();
      deduplicateQueue();
      await autoFillQueue();
    }

    // Si rien ne joue, on enchaîne automatiquement
    if (!data.is_playing) {
        if (priorityQueue.length > 0) {
            // Lire le prochain prioritaire
            const track = priorityQueue.shift();
            playedTracks.add(track.uri);
            await fetch('https://api.spotify.com/v1/me/player/play', {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ uris: [track.uri] })
            });
            console.log('▶️ Lecture du titre prioritaire suivant:', track.name);
        } else {
            // Reprendre la playlist principale
            await fetch('https://api.spotify.com/v1/me/player/play', {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ context_uri: `spotify:playlist:${SOURCE_PLAYLIST}` })
            });
            console.log('🔄 Reprise de la playlist principale');
        }
    }
  } catch (e) {
    console.error('Erreur poll track:', e.message);
  }
}
setInterval(pollCurrentTrack, 5000);

/* ------------------------------------------------------------------
   Auth routes
------------------------------------------------------------------ */
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
------------------------------------------------------------------ */
app.post('/add-priority-track', async (req, res) => {
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: 'No URI provided' });

  if (playedTracks.has(uri)) {
    return res.status(400).json({ error: 'Track already played' });
  }

  const trackId  = uri.split(':').pop();
  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}?market=FR`, { headers: { Authorization: 'Bearer ' + access_token } });
  const track    = await trackRes.json();

  const trackInfo = { uri, name: track.name, artists: track.artists.map(a => a.name).join(', '), image: track.album.images?.[0]?.url || '', auto: false };
  priorityQueue.push(trackInfo);

  await autoFillQueue();
  res.json({ message: 'Track added', track: trackInfo });
});

app.post('/play-priority', async (_req, res) => {
  if (!priorityQueue.length) return res.status(400).json({ error: 'Queue empty' });
  const track = priorityQueue.shift();
  playedTracks.add(track.uri);
  await fetch('https://api.spotify.com/v1/me/player/play', {
    method : 'PUT',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ uris: [track.uri] })
  });
  console.log('▶️ Lecture du titre prioritaire:', track.name);
  await autoFillQueue();
  res.json({ message: 'Playing priority track', track });
});

app.get('/priority-queue', (_req, res) => res.json({ queue: priorityQueue }));
app.get('/played-tracks', (_req, res) => res.json({ played: Array.from(playedTracks) }));

/* ------------------------------------------------------------------
   Static files
------------------------------------------------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));
app.get('/',    (_req, res) => res.redirect('/player.html'));
app.get('/guest',(_req, res) => res.redirect('/guest.html'));
app.get('/display', (_req, res) => res.redirect('/display.html'));

app.listen(PORT, () => console.log(`🚀 Server ready on port ${PORT}`));
setInterval(() => autoFillQueue(), 20 * 1000);
