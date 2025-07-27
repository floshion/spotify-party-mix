import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import path    from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const client_id     = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri  = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
let   access_token  = null;
let   refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null;

// Playlist source used to auto‑fill the queue.  This value is mutable and can
// be set via the /set-playlist route.  It defaults to Florent’s party mix
// playlist.
let SOURCE_PLAYLIST     = '1g39kHQqy4XHxGGftDiUWb';
const TARGET_QUEUE_LENGTH = 6;

let priorityQueue = [];                  // [{ uri,name,artists,image,auto }]
// Instead of a plain Set, maintain a map of played track URIs to an object
// containing the timestamp of when the track finished playing and the name
// of the guest who queued it.  This allows us to expire a track after a
// configurable period (two hours) and to display who played it when
// rejecting a new request.
// Example structure: { uri1: { ts: 1690000000000, guest: 'Alice' }, … }
let playedTracks  = new Map();

// Génère une clé de session aléatoire à chaque démarrage du serveur.
// Cette clé est utilisée pour créer une URL unique pour la page invité
// (via le QR code). Les invités doivent fournir cette clé lorsqu’ils
// ajoutent un morceau, empêchant ainsi les personnes ayant un ancien lien
// de continuer à interagir avec la playlist.
// La clé de session détermine l’URL d’invitation utilisée par les invités.  Elle
// est générée à chaque démarrage, mais peut aussi être régénérée via
// l’endpoint /reset-session pour démarrer une nouvelle soirée.
let sessionKey = crypto.randomBytes(4).toString('hex');

/* ---------- Auth ---------------------------------------------------------------- */
async function refreshAccessToken () {
  if (!refresh_token) return;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers:{
      'Content-Type':'application/x-www-form-urlencoded',
      'Authorization':'Basic '+Buffer.from(`${client_id}:${client_secret}`).toString('base64')
    },
    body:new URLSearchParams({ grant_type:'refresh_token', refresh_token })
  });
  const d = await r.json();
  if (d.access_token){ access_token=d.access_token; console.log('🔄 token refresh'); }
}
await refreshAccessToken();
setInterval(refreshAccessToken, 50*60*1000);

/* ---------- Session Key --------------------------------------------------------- */
// Renvoie la clé de session actuelle. Le frontend récupère cette clé
// pour générer une URL de participation unique dans le QR code. Sans cette clé,
// l’ajout de morceaux sera refusé.
app.get('/session-key', (_req, res) => {
  res.json({ key: sessionKey });
});

/* ---------- Utils ---------------------------------------------------------------- */
// Remove from the priority queue any track that is still considered “played”
// (i.e. its two‑hour cooldown hasn’t expired).  If the cooldown has
// expired, remove the entry from the playedTracks map so that the track
// becomes eligible again.
function purgeQueue(){
  const now = Date.now();
  priorityQueue = priorityQueue.filter(t => {
    const info = playedTracks.get(t.uri);
    // If the track has not been played or has expired, keep it in the queue
    if (!info) return true;
    if ((now - info.ts) >= 2 * 60 * 60 * 1000) {
      // Remove expired played entry
      playedTracks.delete(t.uri);
      return true;
    }
    // Otherwise it’s still blocked: drop from queue
    return false;
  });
}
function deduplicateQueue(){
  const seen=new Set();
  priorityQueue = priorityQueue.filter(t=>{
    if (seen.has(t.uri)) return false;
    seen.add(t.uri);
    return true;
  });
}

async function fetchRandomTracksFromPlaylist(id, limit=3){
  if(limit<=0) return [];
  const h={Authorization:'Bearer '+access_token};
  const meta = await (await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=tracks(total)&market=FR`,{headers:h})).json();
  const total = meta.tracks.total;

  const out=[], taken=new Set();
  while(out.length<limit && taken.size<total){
    const offset=Math.floor(Math.random()*total);
    if(taken.has(offset)) continue;
    taken.add(offset);
    const item = (await (await fetch(
      `https://api.spotify.com/v1/playlists/${id}/tracks?limit=1&offset=${offset}&market=FR`,{headers:h})
    ).json()).items?.[0];
    if(!item?.track) continue;
    // Skip tracks that are still blocked from a previous play
    const info = playedTracks.get(item.track.uri);
    if (info && (Date.now() - info.ts) < 2 * 60 * 60 * 1000) continue;
    out.push({
      uri:    item.track.uri,
      name:   item.track.name,
      artists:item.track.artists.map(a => a.name).join(', '),
      image:  item.track.album.images?.[0]?.url || '',
      auto:   true,
      // Les morceaux auto n’ont pas d’invité spécifique ; ce champ sert
      // d’indicateur lors de l’affichage et du calcul des limites
      guest:  'Auto'
    });
  }
  return out;
}

async function autoFillQueue(){
  purgeQueue(); deduplicateQueue();
  const missing = TARGET_QUEUE_LENGTH - priorityQueue.length;
  if(missing>0){
    const randoms = await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, missing);
    priorityQueue.push(...randoms);
    deduplicateQueue();
  }
}

/* ---------- Routes principales --------------------------------------------------- */
app.get('/token', (_q,res)=>res.json({access_token}));

app.post('/add-priority-track', async (req,res)=>{
  const uri = req.query.uri;
  if (!uri) return res.status(400).json({ error: 'No URI' });
  // Refuse si le morceau a déjà été joué et que son délai de blocage de 2h n’est pas expiré
  const playedInfo = playedTracks.get(uri);
  if (playedInfo) {
    const elapsed = Date.now() - playedInfo.ts;
    if (elapsed < 2 * 60 * 60 * 1000) {
      const remainingMin = Math.ceil((2 * 60 * 60 * 1000 - elapsed) / 60000);
      return res.status(400).json({
        error: 'Track already played',
        by: playedInfo.guest,
        remainingMinutes: remainingMin,
        playedAt: playedInfo.ts
      });
    }
    // Si expiré, supprime l’entrée pour permettre la ré‑ajout
    playedTracks.delete(uri);
  }

  // Vérifie que la clé de session envoyée par l’invité correspond bien
  const providedKey = req.query.key;
  // Toute requête d’ajout doit comporter la clé de session. Sans cette clé,
  // ou si elle ne correspond pas à la clé courante, l’ajout est refusé.
  if (providedKey !== sessionKey) {
    return res.status(400).json({ error: 'Invalid session key' });
  }
  // Nom de l’invité ; par défaut « Invité » si non fourni
  const guestName = req.query.guest || 'Invité';
  // Compte les morceaux consécutifs ajoutés par cet invité en début de file (ordre de lecture).
  // Comme les morceaux invités sont toujours insérés avant les morceaux auto, on analyse
  // la file depuis le début : si les deux premiers morceaux appartiennent déjà au même
  // invité, un troisième ajout est refusé.
  let consecutive = 0;
  for (let i = 0; i < priorityQueue.length; i++) {
    const t = priorityQueue[i];
    // On arrête dès qu'on tombe sur un morceau auto ou un autre invité
    if (t.auto) break;
    if (t.guest === guestName) {
      consecutive++;
    } else {
      break;
    }
  }
  if (consecutive >= 2) {
    return res.status(400).json({ error: 'Limit per guest reached' });
  }

  const id = uri.split(':').pop();
  const track = await (await fetch(`https://api.spotify.com/v1/tracks/${id}?market=FR`,
    {headers:{Authorization:'Bearer '+access_token}})).json();

  const tInfo = {
    uri,
    name: track.name,
    artists: track.artists.map(a => a.name).join(', '),
    image: track.album.images?.[0]?.url || '',
    auto: false,
    guest: guestName
  };

  // On insère avant le premier "auto" (invités groupés devant les autos)
  const firstAutoIndex = priorityQueue.findIndex(t => t.auto);
  if (firstAutoIndex === -1) {
    priorityQueue.push(tInfo);
  } else {
    priorityQueue.splice(firstAutoIndex, 0, tInfo);
  }

  await autoFillQueue();
  res.json({message:'Track added', track:tInfo});
});

app.get('/priority-queue', (_q,res)=>res.json({queue:priorityQueue}));

// Indique si une session est active c’est‑à‑dire si la file d’attente ou
// l’historique contient déjà des morceaux.  Cela permet au frontend
// d’avertir l’admin qu’une soirée est en cours et de proposer de la
// réinitialiser.
app.get('/session-active', (_req, res) => {
  const active = (playedTracks.size > 0) || (priorityQueue.length > 0);
  res.json({ active });
});

app.get('/next-track', async (_q,res)=>{
  if(priorityQueue.length===0){
    priorityQueue.push(...await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST,1));
  }
  const next = priorityQueue.shift();
  if(!next) return res.status(400).json({error:'No track'});
  // Marque le morceau comme joué avec un horodatage et le nom de l’invité
  playedTracks.set(next.uri, { ts: Date.now(), guest: next.guest || next.guestName || '' });
  await autoFillQueue();
  res.json({track:next});
});

/* ---------- Playlists & Session management --------------------------------------- */

// Liste les playlists de l’utilisateur connecté (admin) afin de permettre
// au DJ de choisir la source de la playlist automatique.  Retourne un tableau
// d’objets avec id, name et éventuellement image.
app.get('/playlists', async (_req, res) => {
  try {
    const h = { Authorization: 'Bearer ' + access_token };
    // Récupère les playlists de l’utilisateur (jusqu’à 50 pour éviter de
    // multiplier les requêtes).  On ne gère pas ici la pagination car
    // l’interface est destinée à un usage personnel.
    const d = await (await fetch('https://api.spotify.com/v1/me/playlists?limit=50', { headers: h })).json();
    const lists = (d.items || []).map(p => ({
      id: p.id,
      name: p.name,
      image: p.images?.[0]?.url || ''
    }));
    res.json({ playlists: lists });
  } catch (e) {
    console.error('Failed to fetch playlists', e);
    res.status(500).json({ error: 'Unable to fetch playlists' });
  }
});

// Change la playlist utilisée pour l’auto‑remplissage.  La nouvelle ID est
// fournie via le paramètre de requête “id”.  Lorsque la playlist est changée,
// on purge la file d’attente, on efface les morceaux joués et on remplit
// automatiquement la file avec le nouvel ensemble de morceaux.
app.post('/set-playlist', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  // Met à jour la playlist source pour l’auto‑remplissage sans perdre les
  // morceaux ajoutés par les invités.  On ne vide plus totalement
  // priorityQueue ni l’historique des morceaux joués : les invités doivent
  // conserver la priorité sur la nouvelle playlist et les morceaux déjà
  // joués restent bloqués pendant la fenêtre de 2 heures.
  SOURCE_PLAYLIST = id;
  // Filtre la file d’attente pour ne conserver que les morceaux ajoutés
  // manuellement (auto=false).  Les morceaux automatiques seront
  // remplacés par ceux de la nouvelle playlist via autoFillQueue().
  priorityQueue = priorityQueue.filter(t => !t.auto);
  try {
    await autoFillQueue();
    res.json({ message: 'Playlist changed', playlist: id });
  } catch (e) {
    console.error('Erreur lors du changement de playlist', e);
    res.status(500).json({ error: 'Failed to change playlist' });
  }
});

/* ---------- Recommandations basées sur le morceau en cours --------------- */
// Fournit une liste de morceaux recommandés qui s’accordent avec le morceau
// actuellement en cours de lecture.  Cette route utilise l’API Spotify pour
// récupérer le morceau en cours (seed) puis des recommandations basées sur
// ce morceau.  Elle renvoie jusqu’à 4 morceaux avec leur URI, nom,
// artistes et pochette.  Si aucun titre n’est en cours, elle renvoie un
// tableau vide.
app.get('/recommendations', async (_req, res) => {
  try {
    // Récupère le morceau actuellement en lecture sur le compte Spotify
    const now = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!now.ok) {
      return res.json({ tracks: [] });
    }
    const json = await now.json();
    if (!json || !json.item) {
      return res.json({ tracks: [] });
    }
    const seedId = json.item.id;
    // Utilise l’endpoint recommendations de Spotify pour récupérer des titres
    // similaires.  On passe le morceau en seed, limite 4, marché FR.
    const rec = await fetch(`https://api.spotify.com/v1/recommendations?seed_tracks=${seedId}&limit=4&market=FR`, {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    const recJson = await rec.json();
    const tracks = (recJson.tracks || []).map(t => ({
      uri:    t.uri,
      name:   t.name,
      artists: t.artists.map(a => a.name).join(', '),
      image:  t.album.images?.[0]?.url || ''
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('Erreur lors de la récupération des recommandations', err);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Démarre une nouvelle soirée.  Génère une nouvelle sessionKey, vide la
// file d’attente et la liste des morceaux joués, puis remplit la file avec
// des titres de la playlist courante.  Retourne la nouvelle clé.
app.post('/reset-session', async (_req, res) => {
  sessionKey    = crypto.randomBytes(4).toString('hex');
  priorityQueue = [];
  playedTracks  = new Map();
  try {
    await autoFillQueue();
    res.json({ message: 'Session reset', key: sessionKey });
  } catch (e) {
    console.error('Erreur lors de la réinitialisation de session', e);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

/* ---------- Télécommande --------------------------------------------------------- */

/* ⏯ Play / Pause (toggle) */
app.post('/toggle-play', async (_req, res) => {
  const st = await fetch('https://api.spotify.com/v1/me/player',
                         { headers:{Authorization:'Bearer '+access_token} })
                    .then(r => r.json());

  const path = st.is_playing
      ? 'https://api.spotify.com/v1/me/player/pause'
      : 'https://api.spotify.com/v1/me/player/play';

  await fetch(path, { method:'PUT',
                      headers:{Authorization:'Bearer '+access_token} });

  res.json({ playing: !st.is_playing });
});

/* ⏭ Passer au prochain morceau dans l’ordre de la file */
app.post('/skip', async (_req, res) => {
  // 1. on récupère le prochain titre
  const next = await fetch('http://localhost:'+PORT+'/next-track').then(r=>r.json());
  if (!next.track) return res.status(400).json({error:'No track'});

  // 2. on trouve le device actif (Web Playback)
  const info = await fetch('https://api.spotify.com/v1/me/player',
    {headers:{Authorization:'Bearer '+access_token}}).then(r=>r.json());
  const deviceId = info?.device?.id;
  if(!deviceId) return res.status(500).json({error:'No active device'});

  // 3. on lance le morceau immédiatement
  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,{
    method:'PUT',
    headers:{Authorization:'Bearer '+access_token,'Content-Type':'application/json'},
    body:JSON.stringify({uris:[next.track.uri]})
  });

  res.json(next);
});

/* ---------- Static / boot -------------------------------------------------------- */
const __filename=fileURLToPath(import.meta.url);
const __dirname =path.dirname(__filename);
app.use(express.static(path.join(__dirname,'static')));
app.get('/',     (_q,res)=>res.redirect('/player.html'));
app.get('/guest',(_q,res)=>res.redirect('/guest.html'));
app.get('/display',(_q,res)=>res.redirect('/display.html'));
app.get('/remote', (_q,res)=>res.redirect('/remote.html'));

app.listen(PORT,()=>console.log(`🚀 Server sur ${PORT}`));
setInterval(()=>autoFillQueue(),20*1000);
