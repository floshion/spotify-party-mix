// ===========================
// server.js (version complète)
// ===========================
// Ajouts :
// - /ext/current-features : récupère features du morceau courant (tempo, key, mode)
// - /ext/suggest : propose 3–4 titres compatibles en s'appuyant sur Last.fm + filtrage BPM/clé
// - Analyse pluggable :
//      * Par défaut via Spotify Audio Features (simple, gratuit, stable)
//      * Fallback facultatif via SongBPM (gratuit) si SPOTIFY_FEATURES_DISABLED=true
// - Aucune dépendance au preview_url
// - Conserve toutes tes routes existantes (playlist, add/skip, photos, sessions…)

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import JSZipPkg from 'jszip';
const JSZip = JSZipPkg?.default || JSZipPkg;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ====== ENV ======
const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  REDIRECT_URI,
  PORT,
  PLAYER_PASSWORD,
  PASSWORD,
  LASTFM_API_KEY,      // requis pour les recos gratuites
  SONGBPM_API_KEY,     // optionnel (fallback si on désactive les features Spotify)
  SPOTIFY_FEATURES_DISABLED, // si "true" => on utilise SongBPM au lieu de /audio-features
} = process.env;

const TARGET_QUEUE_LENGTH = 6;

// ====== ÉTAT MÉMOIRE (conserve ta logique) ======
let sessionKey = null;
let sessionName = null;
let sessions = {}; // key -> { name, display, status }
let priorityQueue = [];
let playedTracks = {}; // trackId -> { lastPlayedAt, guest }

// ====== UTILS SPOTIFY ======
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: SPOTIFY_REFRESH_TOKEN,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function getCurrentlyPlaying(accessToken) {
  const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error('currently-playing failed');
  const j = await r.json();
  if (!j?.item) return null;
  return {
    id: j.item.id,
    name: j.item.name,
    artists: j.item.artists?.map(a => a.name).join(', '),
    duration_ms: j.item.duration_ms,
    uri: j.item.uri,
    album: j.item.album?.name || '',
  };
}

async function spotifySearchTrack(accessToken, q, limit = 1) {
  const sp = new URLSearchParams({ q, type: 'track', limit: String(limit) });
  const r = await fetch(`https://api.spotify.com/v1/search?${sp.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return j?.tracks?.items || [];
}

async function spotifyAudioFeatures(accessToken, trackId) {
  const r = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j; // { tempo, key, mode, energy, danceability, ... }
}

// ====== FALLBACK GRATUIT : SongBPM ======
// https://songbpm.com/api (clé gratuite nécessaire)
// NB: Qualité variable, utile si tu veux VRAIMENT éviter /audio-features Spotify.
async function songBpmFeatures(artist, title) {
  if (!SONGBPM_API_KEY) return null;
  try {
    const p = new URLSearchParams({ api_key: SONGBPM_API_KEY, type: 'both', lookup: `${artist} ${title}` });
    const r = await fetch(`https://api.getsongbpm.com/search/?${p.toString()}`);
    if (!r.ok) return null;
    const j = await r.json();
    const song = j?.search?.[0];
    if (!song) return null;
    const tempo = song?.tempo ? parseFloat(song.tempo) : null;
    // Pas de mode fiable ; key souvent au format "C#m" → on normalise
    const key = (song?.key || '').toUpperCase();
    return { tempo, key, mode: null };
  } catch { return null; }
}

// ====== ANALYSEUR DE FEATURES UNIFIÉ ======
async function getTrackFeaturesUnified({ accessToken, trackId, artist, title }) {
  if (String(SPOTIFY_FEATURES_DISABLED).toLowerCase() === 'true') {
    // Pas d'audio-features Spotify → fallback SongBPM par nom/artist
    return await songBpmFeatures(artist || '', title || '');
  } else {
    // Par défaut, on utilise /audio-features (gratuit, stable)
    const f = await spotifyAudioFeatures(accessToken, trackId);
    if (!f) return null;
    // Map vers structure commune
    const keyNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const keyText = (f.key >= 0 && f.key <= 11) ? keyNames[f.key] + (f.mode === 1 ? '' : 'm') : null;
    return { tempo: f.tempo ?? null, key: keyText, mode: f.mode };
  }
}

// ====== AUTH BASIQUE pour / et /player.html ======
if (PLAYER_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/player.html') {
      const auth = req.headers.authorization || '';
      const token = auth.split(' ')[1] || '';
      const [user, pass] = Buffer.from(token || '', 'base64').toString().split(':');
      if (pass === PLAYER_PASSWORD) return next();
      res.set('WWW-Authenticate', 'Basic realm="Spotify Party Mix"');
      return res.status(401).send('Auth required');
    }
    next();
  });
}

// ====== STATIQUE ======
app.use(express.static(path.join(__dirname, 'static')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'static', 'player.html')));
app.get('/guest', (req, res) => res.redirect('/guest.html'));
app.get('/display', (req, res) => res.redirect('/display.html'));
app.get('/remote', (req, res) => res.redirect('/remote.html'));
app.get('/test-recos', (req, res) => res.sendFile(path.join(__dirname, 'static', 'test-recos.html')));

// ====== (Place ici TOUTES TES ROUTES EXISTANTES inchangées) ======
// ... playlists, add-priority-track, remove, next-track, toggle-play, skip, photos/albums, sessions, etc.

// =====================================================================
// NOUVEAU : FEATURES DU MORCEAU EN COURS
// =====================================================================
app.get('/ext/current-features', async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const track = await getCurrentlyPlaying(accessToken);
    if (!track) return res.json({ playing: false });

    const features = await getTrackFeaturesUnified({
      accessToken,
      trackId: track.id,
      artist: track.artists?.split(',')[0] || '',
      title: track.name,
    });

    return res.json({
      playing: true,
      track,
      features, // { tempo, key, mode }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// NOUVEAU : SUGGESTIONS COMPATIBLES (3–4)
// =====================================================================
app.get('/ext/suggest', async (req, res) => {
  const { name = '', artists = '', limit: limitStr = '4' } = req.query;
  const limit = Math.min(parseInt(limitStr || '4', 10) || 4, 6);

  try {
    if (!LASTFM_API_KEY) {
      return res.status(400).json({ error: 'LASTFM_API_KEY manquante' });
    }

    const accessToken = await getAccessToken();

    // 1) Récup features du morceau courant (pour cible)
    //    → on repart depuis currently playing pour être sûr
    const current = await getCurrentlyPlaying(accessToken);
    if (!current) return res.json([]);
    const target = await getTrackFeaturesUnified({
      accessToken,
      trackId: current.id,
      artist: (current.artists || '').split(',')[0],
      title: current.name,
    });

    // 2) Candidats via Last.fm (similaires)
    const artist = (artists || current.artists || '').split(',')[0].trim();
    const params = new URLSearchParams({
      method: 'track.getSimilar',
      track: name || current.name,
      artist,
      api_key: LASTFM_API_KEY,
      format: 'json',
      limit: '25',
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
    const j = r.ok ? await r.json() : {};
    const sims = j?.similartracks?.track || [];

    // 3) Pour chaque candidat :
    //    - Trouver un ID Spotify
    //    - Obtenir ses features (Spotify ou SongBPM)
    //    - Calculer une distance
    const results = [];
    for (const t of sims) {
      if (results.length >= limit * 3) break; // on évalue plus large puis on triera
      const tName = t?.name;
      const tArtist = Array.isArray(t?.artist) ? t.artist[0]?.name : t?.artist?.name;
      if (!tName || !tArtist) continue;

      const items = await spotifySearchTrack(accessToken, `track:${tName} artist:${tArtist}`, 1);
      const tr = items?.[0];
      if (!tr) continue;

      const f = await getTrackFeaturesUnified({
        accessToken,
        trackId: tr.id,
        artist: tArtist,
        title: tName,
      });
      if (!f || !target) continue;

      const dist = compatibilityDistance(target, f);
      results.push({
        name: tr.name,
        artist: tr.artists?.map(a => a.name).join(', '),
        uri: tr.uri,
        preview_url: tr.preview_url,
        reason: reasonText(target, f),
        dist,
      });
    }

    // 4) Trier par distance croissante et renvoyer top N
    results.sort((a, b) => a.dist - b.dist);
    res.json(results.slice(0, limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function compatibilityDistance(a, b) {
  // a,b: { tempo, key, mode }
  let d = 0;
  if (isFinite(a.tempo) && isFinite(b.tempo)) {
    // autorise 2x / 0.5x (normalisation club)
    const tempos = [b.tempo, b.tempo * 2, b.tempo / 2];
    const dt = Math.min(...tempos.map(x => Math.abs(a.tempo - x)));
    d += dt / 2; // pondération
  } else {
    d += 50; // pénalité si on n'a pas les tempos
  }
  if (a.key && b.key) {
    d += keyDistance(a.key, b.key);
  } else {
    d += 5;
  }
  return d;
}

function keyDistance(k1, k2) {
  // très simple : 0 si identiques, 1 si relative (Am/C), 2 si quinte (Camelot voisins), 4 sinon
  const mapIdx = {
    'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'F':5,'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11
  };
  const minor1 = /m$/i.test(k1), minor2 = /m$/i.test(k2);
  const n1 = mapIdx[k1.replace('m','').toUpperCase()] ?? null;
  const n2 = mapIdx[k2.replace('m','').toUpperCase()] ?? null;
  if (n1==null || n2==null) return 3;
  if (n1 === n2 && minor1 === minor2) return 0;
  // relative majeur/mineur
  if (n1 === n2 && minor1 !== minor2) return 1;
  const fifth = Math.min((12 + n1 - n2) % 12, (12 + n2 - n1) % 12);
  if (fifth === 7) return 2; // triton dur
  if (fifth === 5) return 2; // quarte
  if (fifth === 1 || fifth === 11) return 2; // quinte proche
  return 4;
}

function reasonText(target, cand) {
  const parts = [];
  if (isFinite(target.tempo) && isFinite(cand.tempo)) {
    const ratios = [cand.tempo, cand.tempo*2, cand.tempo/2].map(x => Math.abs(target.tempo - x));
    const best = Math.min(...ratios);
    parts.push(`tempo ~${Math.round(target.tempo)} (Δ≈${Math.round(best)})`);
  }
  if (target.key && cand.key) parts.push(`clé ${target.key} ↔ ${cand.key}`);
  return parts.length ? parts.join(' • ') : 'Similaire';
}

const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`Server running on ${listenPort}`);
});


/* ==============================================
static/test-recos.html (ajoute ce fichier à /static)
============================================== */

/*
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Test Recos Compatibles</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .row { display:flex; gap:12px; flex-wrap: wrap; }
    .pill { display:inline-block; padding:4px 8px; border-radius:9999px; border:1px solid #ccc; margin-right:6px; }
    .list li { margin: 8px 0; }
    button { padding:8px 12px; border-radius:10px; border:1px solid #ccc; cursor:pointer; }
  </style>
</head>
<body>
  <h1>Test recommandations compatibles</h1>

  <div class="card">
    <h2>Morceau en cours</h2>
    <div id="now">—</div>
  </div>

  <div class="card">
    <h2>Caractéristiques ciblées</h2>
    <div class="row">
      <div class="pill"><b>BPM :</b> <span id="bpm">—</span></div>
      <div class="pill"><b>Clé :</b> <span id="key">—</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Suggestions (3–4)</h2>
    <ul id="sugs" class="list"></ul>
  </div>

  <script type="module">
    async function loadAll() {
      const now = await (await fetch('/ext/current-features')).json();
      const nowEl = document.getElementById('now');
      const bpmEl = document.getElementById('bpm');
      const keyEl = document.getElementById('key');
      const sugsEl = document.getElementById('sugs');

      if (!now.playing) {
        nowEl.textContent = 'Aucune lecture en cours';
        return;
      }

      nowEl.textContent = `${now.track.name} — ${now.track.artists}`;
      bpmEl.textContent = now?.features?.tempo ? Math.round(now.features.tempo) : '—';
      keyEl.textContent = now?.features?.key || '—';

      const p = new URLSearchParams({ name: now.track.name, artists: now.track.artists, limit: '4' });
      const sugs = await (await fetch('/ext/suggest?' + p.toString())).json();

      sugsEl.innerHTML = '';
      if (!Array.isArray(sugs) || sugs.length === 0) {
        sugsEl.innerHTML = '<li>Aucune suggestion</li>';
        return;
      }

      sugs.forEach(it => {
        const li = document.createElement('li');
        li.innerHTML = `<b>${it.name}</b> — ${it.artist}<br><small>${it.reason}</small>`;
        li.style.cursor = 'pointer';
        li.onclick = () => window.open(`https://open.spotify.com/track/${(it.uri||'').split(':').pop()}`,'_blank');
        sugsEl.appendChild(li);
      });
    }

    loadAll();
  </script>
</body>
</html>
*/
