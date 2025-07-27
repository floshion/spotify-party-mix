import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import path    from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs/promises';
// Importation de JSZip une seule fois.  Si la bibliothèque n’est pas
// disponible dans l’environnement, l’import échouera au lancement du
// serveur, évitant de créer des erreurs dynamiques lors de la
// génération des archives.  JSZip est une dépendance transitive de
// pptxgenjs et est disponible dans node_modules.
import JSZipPkg from 'jszip';
const JSZip = JSZipPkg?.default || JSZipPkg;

/* ------------------------------------------------------------------------
 * Ajout du support JSON volumineux et gestion des photos
 *
 * L'application originale gérait uniquement les requêtes Spotify et les
 * interactions de la file d'attente. Pour permettre aux invités de
 * partager des photos pendant la soirée, nous activons d'abord le
 * parseur JSON intégré d'Express afin de recevoir des objets contenant
 * des données base64. La limite est volontairement élevée (20 MB) pour
 * autoriser l’envoi de clichés issus des appareils modernes.
 */

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// Active l’analyse JSON pour accepter des payload volumineux (images en base64).
app.use(express.json({ limit: '20mb' }));

/* ------------------------------------------------------------------
 * Gestion des séances et des photos
 *
 * Lorsque l’administrateur lance une nouvelle soirée, il peut fournir un
 * nom personnalisé. Ce nom est utilisé pour organiser les photos prises
 * par les invités dans un répertoire dédié. Chaque séance est
 * identifiée par une clé unique (sessionKey) et un nom (sessionName).
 */
// Nom convivial de la soirée courante. Par défaut vide jusqu’à ce qu’une
// nouvelle session soit lancée. Le nom n’est pas nécessairement unique
// mais sert à identifier les albums dans l’interface admin.
let sessionName = '';

// -----------------------------------------------------------------------------
// Gestion de l’état des soirées
//
// Chaque soirée est identifiée par une clé de session (sessionKey) et un
// identifiant de dossier (sessionName).  Afin de savoir si une soirée est
// toujours active ou si elle a été terminée, on maintient ci‑dessous une
// structure de données persistante en mémoire.  La clé de cette carte est la
// clé de session générée lors du lancement de la soirée et la valeur est
// l’objet contenant le slug de la soirée et son statut.
//
// Exemple :
// {
//   'abcd1234': { name: 'soiree-2025-07-27-20h15', display: 'Soirée 2025‑07‑27 20h15', status: 'active' },
//   'efgh5678': { name: 'anniv-jean', display: 'Anniv Jean', status: 'terminated' }
// }
//
// Ce tableau permet de répondre à l’endpoint /session-status et de bloquer
// certaines actions lorsqu’une session est terminée (ex : ajout de morceau ou
// upload de photo).
const sessions = {};

/**
 * Transforme un libellé libre en identifiant de dossier.  Remplace les
 * caractères non alphanumériques par des tirets et met tout en
 * minuscules.  Par exemple « Soirée d’Été » devient « soiree-d-ete ».  Ce
 * slug est utilisé à la fois pour le nom de dossier côté serveur et
 * l’identifiant d’album dans les URLs.
 * @param {string} str
 */
function slugify(str) {
  return (str || '')
    .toString()
    .normalize('NFD')               // décompose les accents
    .replace(/\p{Diacritic}/gu, '') // supprime les diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')    // remplace tout sauf alphanumériques
    .replace(/^-+|-+$/g, '');       // supprime les tirets en début/fin
}

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

// Mise en cache des caractéristiques audio des titres de chaque playlist.
// La clé est l’ID de la playlist et la valeur est un tableau d’objets
// contenant : { uri, name, artists, image, tempo, key, mode }.  Cette
// structure permet de générer des suggestions basées sur le tempo et la
// tonalité sans dépendre des recommandations Spotify qui peuvent être
// bloquées.  Les données sont recalculées à chaque changement de
// playlist via cachePlaylistFeatures().
const playlistFeatures = {};

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

// Précharge les caractéristiques audio de la playlist source au démarrage
// afin de permettre des suggestions dès la première ouverture.  Sans cet
// appel, playlistFeatures[SOURCE_PLAYLIST] resterait vide jusqu’à ce que
// l’utilisateur change manuellement de playlist via l’interface.
cachePlaylistFeatures(SOURCE_PLAYLIST).catch(e => {
  console.warn('Impossible de précharger les caractéristiques de la playlist', e);
});

/* ---------- Session Key --------------------------------------------------------- */
// Renvoie la clé de session actuelle. Le frontend récupère cette clé
// pour générer une URL de participation unique dans le QR code. Sans cette clé,
// l’ajout de morceaux sera refusé.
app.get('/session-key', (_req, res) => {
  res.json({ key: sessionKey });
});

// Renvoie à la fois la clé et le nom de la session courante.  Ce point
// d’entrée est utilisé par le frontend pour connaître le nom de l’album
// auquel associer les photos et pour savoir si une session est active.
app.get('/session-info', (_req, res) => {
  res.json({ key: sessionKey, name: sessionName });
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

// Met en cache les caractéristiques audio de la playlist spécifiée.  Pour
// chaque morceau de la playlist (limité à 100), on récupère son tempo,
// sa tonalité (key) et son mode via l’API audio‑features de Spotify.  Ces
// informations sont utilisées pour proposer des suggestions basées sur
// l’enchaînement (BPM, tonalité) plutôt que sur les recommandations Spotify.
async function cachePlaylistFeatures(playlistId) {
  try {
    const h = { Authorization: 'Bearer ' + access_token };
    let tracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(track(id,uri,name,artists(name),album(images(url)))),next&market=FR`;
    // Récupère jusqu’à 100 titres de la playlist
    while (url && tracks.length < 100) {
      const d = await (await fetch(url, { headers: h })).json();
      (d.items || []).forEach(item => {
        const tr = item.track;
        if (!tr || !tr.id) return;
        tracks.push({
          id: tr.id,
          uri: tr.uri,
          name: tr.name,
          artists: tr.artists.map(a => a.name).join(', '),
          image: tr.album.images?.[0]?.url || ''
        });
      });
      url = d.next;
      if (!url) break;
    }
    if (tracks.length === 0) {
      playlistFeatures[playlistId] = [];
      return;
    }
    // Découpe en paquets de 100 IDs (API limite 100).
    const ids = tracks.map(t => t.id).join(',');
    const featRes = await fetch(`https://api.spotify.com/v1/audio-features?ids=${ids}`, { headers: h });
    const featJson = await featRes.json();
    const features = featJson.audio_features || [];
    const enriched = tracks.map((t, idx) => {
      const f = features[idx] || {};
      return {
        uri: t.uri,
        name: t.name,
        artists: t.artists,
        image: t.image,
        tempo: f.tempo || 0,
        key: f.key,
        mode: f.mode
      };
    });
    playlistFeatures[playlistId] = enriched;
  } catch (e) {
    console.error('cachePlaylistFeatures erreur', e);
    playlistFeatures[playlistId] = [];
  }
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

  // Empêche l’ajout de morceaux lorsque la soirée est terminée.  On
  // vérifie l’état stocké dans l’objet sessions.  Si la clé courante a
  // un statut non actif, on refuse l’opération.
  const sessionInfo = sessions[sessionKey];
  if (sessionInfo && sessionInfo.status !== 'active') {
    return res.status(400).json({ error: 'Session terminated' });
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

// Renvoie la file d’attente prioritaire.  Si la session en cours est
// terminée, retourne un tableau vide afin que le frontend n’affiche plus
// les morceaux à venir.
app.get('/priority-queue', (_req, res) => {
  const info = sessions[sessionKey];
  if (info && info.status !== 'active') {
    return res.json({ queue: [] });
  }
  res.json({ queue: priorityQueue });
});

// Permet de supprimer un morceau de la file d'attente prioritaire.  La suppression
// s'effectue sur la première occurrence du titre correspondant à l'URI fournie.
// Si le morceau est trouvé et supprimé, la file est ensuite complétée avec
// d'éventuels titres automatiques pour respecter la longueur cible.  La route
// retourne le morceau supprimé afin que le frontend puisse éventuellement
// l'utiliser pour des notifications.
app.post('/remove-priority-track', async (req, res) => {
  const uri = req.query.uri;
  if (!uri) {
    return res.status(400).json({ error: 'No URI' });
  }
  // Trouve la première occurrence du morceau dans la file
  const idx = priorityQueue.findIndex(t => t.uri === uri);
  if (idx === -1) {
    return res.status(404).json({ error: 'Track not found' });
  }
  const [removed] = priorityQueue.splice(idx, 1);
  try {
    await autoFillQueue();
  } catch (e) {
    console.error('Erreur lors du remplissage automatique après suppression', e);
  }
  return res.json({ message: 'Track removed', track: removed });
});

// Indique si une session est active c’est‑à‑dire si la file d’attente ou
// l’historique contient déjà des morceaux.  Cela permet au frontend
// d’avertir l’admin qu’une soirée est en cours et de proposer de la
// réinitialiser.
app.get('/session-active', (_req, res) => {
  // Si la session est marquée comme terminée, on renvoie false même si la file
  // d’attente contient encore des morceaux.
  const info   = sessions[sessionKey];
  let active = (playedTracks.size > 0) || (priorityQueue.length > 0);
  if (info && info.status !== 'active') {
    active = false;
  }
  res.json({ active });
});

app.get('/next-track', async (_q,res)=>{
  // Si la session est terminée, ne propose plus de nouveau morceau
  const info = sessions[sessionKey];
  if (info && info.status !== 'active') {
    return res.status(400).json({ error: 'Session terminated' });
  }
  if (priorityQueue.length === 0) {
    priorityQueue.push(...await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST, 1));
  }
  const next = priorityQueue.shift();
  if (!next) return res.status(400).json({ error: 'No track' });
  // Marque le morceau comme joué avec un horodatage et le nom de l’invité
  playedTracks.set(next.uri, { ts: Date.now(), guest: next.guest || next.guestName || '' });
  await autoFillQueue();
  res.json({ track: next });
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
    // Met en cache les caractéristiques audio pour permettre des suggestions
    await cachePlaylistFeatures(id);
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
    const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!nowRes.ok) {
      return res.json({ tracks: [] });
    }
    const nowJson = await nowRes.json();
    if (!nowJson || !nowJson.item) {
      return res.json({ tracks: [] });
    }
    const seedId = nowJson.item.id;
    // Récupère les caractéristiques audio (tempo, key, mode) du morceau en cours
    const featRes = await fetch(`https://api.spotify.com/v1/audio-features/${seedId}`, {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!featRes.ok) {
      return res.json({ tracks: [] });
    }
    const featJson = await featRes.json();
    const currentTempo = featJson.tempo || 0;
    const currentKey   = featJson.key;
    const currentMode  = featJson.mode;
    const features = playlistFeatures[SOURCE_PLAYLIST] || [];
    if (!features.length) {
      return res.json({ tracks: [] });
    }
    // Sélectionne des candidats qui ne sont pas déjà le morceau en cours et
    // qui ne sont pas bloqués (joués récemment).  On filtre également les
    // titres encore présents dans la file d’attente pour éviter les doublons.
    const candidates = features.filter(item => {
      const id = item.uri.split(':').pop();
      if (id === seedId) return false;
      // ignore les morceaux déjà lus et encore bloqués
      const playedInfo = playedTracks.get(item.uri);
      if (playedInfo && (Date.now() - playedInfo.ts) < 2 * 60 * 60 * 1000) return false;
      // ignore les morceaux déjà dans la file d’attente
      if (priorityQueue.some(t => t.uri === item.uri)) return false;
      return true;
    });
    // Calcule une distance simple basée sur la différence de tempo et le
    // changement de tonalité/mode.  Un changement de tonalité ou de mode est
    // pénalisé afin de favoriser les enchaînements harmonieux.
    function distance(item) {
      const tempoDiff = Math.abs((item.tempo || 0) - currentTempo);
      const keyPenalty  = (item.key === currentKey) ? 0 : 50;
      const modePenalty = (item.mode === currentMode) ? 0 : 25;
      return tempoDiff + keyPenalty + modePenalty;
    }
    candidates.sort((a, b) => distance(a) - distance(b));
    const selected = candidates.slice(0, 4).map(t => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      image: t.image
    }));
    res.json({ tracks: selected });
  } catch (err) {
    console.error('Erreur lors de la récupération des recommandations', err);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

/* ---------- Suggestions basées sur les résultats de recherche ---------- */
// Compare les morceaux proposés par l’utilisateur (via l’input de recherche)
// au morceau actuellement en cours pour identifier ceux qui s’enchaîneront
// harmonieusement.  Le client transmet une liste d’identifiants Spotify
// (paramètre ids) séparés par des virgules.  Le serveur récupère les
// caractéristiques audio du morceau en cours et celles de chaque ID fourni,
// calcule une distance basée sur le tempo et la tonalité, puis renvoie
// l’ordre des IDs triés du plus proche au plus éloigné.  Aucun appel
// supplémentaire à l’API de recommandations Spotify n’est nécessaire.
app.get('/suggest-similar', async (req, res) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) return res.json({ ids: [] });
    // Nettoie et limite le nombre d’IDs à traiter pour éviter les abus
    const ids = idsParam.split(',').map(id => id.trim()).filter(Boolean).slice(0, 50);
    if (ids.length === 0) return res.json({ ids: [] });
    // Récupère le morceau actuellement en lecture
    const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!nowRes.ok) return res.json({ ids: [] });
    const nowJson = await nowRes.json();
    if (!nowJson || !nowJson.item) return res.json({ ids: [] });
    const seedId = nowJson.item.id;
    // Caractéristiques du morceau en cours
    const featSeedRes = await fetch(`https://api.spotify.com/v1/audio-features/${seedId}`, {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!featSeedRes.ok) return res.json({ ids: [] });
    const seedFeat = await featSeedRes.json();
    const seedTempo = seedFeat.tempo || 0;
    const seedKey   = seedFeat.key;
    const seedMode  = seedFeat.mode;
    // Récupère les features des morceaux proposés via l’API audio-features en un seul appel
    const idsString = ids.join(',');
    const featRes = await fetch(`https://api.spotify.com/v1/audio-features?ids=${idsString}`, {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    if (!featRes.ok) return res.json({ ids: [] });
    const featJson = await featRes.json();
    const features = featJson.audio_features || [];
    // Calcule la distance pour chaque ID
    const scored = ids.map((id, index) => {
      const f = features[index] || {};
      const tempoDiff = Math.abs((f.tempo || 0) - seedTempo);
      const keyPenalty  = (f.key === seedKey) ? 0 : 50;
      const modePenalty = (f.mode === seedMode) ? 0 : 25;
      const score = tempoDiff + keyPenalty + modePenalty;
      return { id, score };
    });
    scored.sort((a, b) => a.score - b.score);
    // Renvoie la liste triée des IDs du plus proche au plus éloigné
    const orderedIds = scored.map(s => s.id);
    res.json({ ids: orderedIds });
  } catch (e) {
    console.error('Erreur suggestion similaire', e);
    res.status(500).json({ ids: [] });
  }
});

// Démarre une nouvelle soirée.  Génère une nouvelle sessionKey, vide la
// file d’attente et la liste des morceaux joués, puis remplit la file avec
// des titres de la playlist courante.  Retourne la nouvelle clé.
app.post('/reset-session', async (req, res) => {
  // Une nouvelle session démarre : on régénère une clé, vide la file
  // d’attente et l’historique, puis remplit à nouveau la file à partir
  // de la playlist courante.  Le nom de séance peut être fourni via
  // `?name=`. S’il est absent, on génère un libellé générique basé sur
  // l’horodatage.
  // À l’ouverture d’une nouvelle session via cette route, on marque
  // l’ancienne clé comme terminée dans l’objet sessions.  Cela permet de
  // savoir que les invités ne doivent plus interagir avec cette session.
  const previousKey  = sessionKey;
  const previousName = sessionName;
  if (previousKey) {
    const prev = sessions[previousKey] || {};
    prev.status = 'terminated';
    // Conserve le nom et le libellé existants si disponible
    prev.name   = prev.name || previousName;
    sessions[previousKey] = prev;
  }

  // Génère une nouvelle clé de session et réinitialise les files
  sessionKey    = crypto.randomBytes(4).toString('hex');
  priorityQueue = [];
  playedTracks  = new Map();

  // Détermination du nom de la nouvelle soirée
  const rawName   = req.query.name || '';
  let usedRawName = rawName;
  if (rawName && rawName.trim()) {
    sessionName = slugify(rawName.trim());
    usedRawName = rawName.trim();
  } else {
    // Nom par défaut basé sur la date (ex : 2025-07-27-20h15)
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const generated = `Soirée ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
    usedRawName = generated;
    sessionName = slugify(generated);
  }

  // Inscrit cette nouvelle session comme active dans la carte sessions
  sessions[sessionKey] = { name: sessionName, display: usedRawName, status: 'active' };

  try {
    // Création du dossier de la soirée pour les photos
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'photos', sessionName);
    await fs.mkdir(dir, { recursive: true });
    // Stocke le nom original pour un affichage convivial dans l’interface
    await fs.writeFile(path.join(dir, 'name.txt'), usedRawName, 'utf8');
  } catch (e) {
    console.warn('Impossible de créer le dossier des photos', e);
  }
  try {
    await autoFillQueue();
    res.json({ message: 'Session reset', key: sessionKey, name: sessionName });
  } catch (e) {
    console.error('Erreur lors de la réinitialisation de session', e);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

/* ------------------------------------------------------------------
 * Terminer une soirée
 *
 * Cette route permet à l’admin de marquer la session courante comme
 * terminée.  Aucune nouvelle musique ou photo ne peut être ajoutée
 * lorsque la session est terminée.  La clé et le nom de session sont
 * conservés pour permettre aux invités de consulter l’album de photos via
 * /session-status et /photos.  Si aucune session n’est active, la route
 * renvoie une erreur.
 */
app.post('/end-session', (req, res) => {
  if (!sessionKey || !sessions[sessionKey]) {
    return res.status(400).json({ error: 'No active session' });
  }
  sessions[sessionKey].status = 'terminated';
  res.json({ message: 'Session ended', key: sessionKey, name: sessions[sessionKey].name });
});

/* ------------------------------------------------------------------
 * Obtenir le statut d’une soirée
 *
 * GET /session-status/:key
 *
 * Permet à un client (invité ou admin) de vérifier si une soirée
 * identifiée par sa clé de session est active ou terminée.  Lorsque
 * l’état est "terminated", la réponse contient également la liste
 * d’URLs des photos de cette soirée afin d’afficher l’album.
 */
app.get('/session-status/:key', async (req, res) => {
  const key = req.params.key;
  const info = sessions[key];
  // Si on ne trouve pas la session, on renvoie 404 pour éviter de
  // divulguer des informations erronées.
  if (!info) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const status = info.status || 'terminated';
  if (status !== 'active') {
    // Récupère les photos associées au slug de la soirée
    const albumDir = path.join(photosDir, info.name);
    try {
      const files = await fs.readdir(albumDir);
      const photos = (files || []).filter(f => f !== 'name.txt').map(f => `/photos/${encodeURIComponent(info.name)}/${encodeURIComponent(f)}`);
      return res.json({ status: 'terminated', photos });
    } catch {
      // Si aucune photo n’est trouvée (dossier supprimé), retourner un tableau vide
      return res.json({ status: 'terminated', photos: [] });
    }
  }
  res.json({ status: 'active' });
});

// -------------------------------------------------------------------------
// Démarre une nouvelle soirée et réinitialise également le lecteur Spotify.
// Cette route combine la logique de /reset-session (changement de clé,
// nettoyage de la file et marquage de l’ancienne soirée comme terminée) avec
// l’arrêt du lecteur et le démarrage du premier titre de la nouvelle
// playlist.  L’admin peut fournir un nom personnalisé via ?name=.
app.post('/new-session', async (req, res) => {
  try {
    // On commence par marquer l’ancienne session comme terminée et créer la
    // nouvelle.  Ceci reprend la logique de /reset-session ci‑dessus.
    const previousKey  = sessionKey;
    const previousName = sessionName;
    if (previousKey) {
      const prev = sessions[previousKey] || {};
      prev.status = 'terminated';
      prev.name   = prev.name || previousName;
      sessions[previousKey] = prev;
    }
    sessionKey    = crypto.randomBytes(4).toString('hex');
    priorityQueue = [];
    playedTracks  = new Map();
    const rawName   = req.query.name || '';
    let usedRawName = rawName;
    if (rawName && rawName.trim()) {
      sessionName = slugify(rawName.trim());
      usedRawName = rawName.trim();
    } else {
      const d = new Date();
      const pad = (n) => n.toString().padStart(2, '0');
      const generated = `Soirée ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
      usedRawName = generated;
      sessionName = slugify(generated);
    }
    sessions[sessionKey] = { name: sessionName, display: usedRawName, status: 'active' };
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'photos', sessionName);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'name.txt'), usedRawName, 'utf8');
    } catch (e) {
      console.warn('Impossible de créer le dossier des photos', e);
    }
    await autoFillQueue();
    // Pause le lecteur Spotify pour éviter que l’ancien morceau continue
    try {
      await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers: { Authorization: 'Bearer ' + access_token } });
    } catch (e) {
      // Ignorer si aucun lecteur actif
    }
    // Tente de démarrer la lecture du premier titre de la nouvelle file
    try {
      // Récupère le prochain morceau via l’API interne
      const nextRes = await fetch(`http://localhost:${PORT}/next-track`);
      const nextJson = await nextRes.json();
      const tr = nextJson.track;
      if (tr) {
        const info = await fetch('https://api.spotify.com/v1/me/player', { headers: { Authorization: 'Bearer ' + access_token } }).then(r => r.json());
        const deviceId = info?.device?.id;
        if (deviceId) {
          await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: [tr.uri] })
          });
        }
      }
    } catch (e) {
      console.warn('Impossible de redémarrer le lecteur', e);
    }
    res.json({ message: 'Session reset', key: sessionKey, name: sessionName });
  } catch (e) {
    console.error('Erreur lors du démarrage de la nouvelle session', e);
    res.status(500).json({ error: 'Failed to start new session' });
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

/* ------------------------------------------------------------------
 * Upload et gestion des photos
 *
 * Les invités peuvent envoyer des clichés directement depuis leur
 * smartphone via la page guest.  Les images sont reçues sous forme de
 * chaînes base64 (data:URI), décodées et stockées dans un répertoire
 * associé à la session courante (sessionName).  L’admin peut ensuite
 * consulter, télécharger ou supprimer les albums via l’interface DJ.
 */

// Expose le dossier des photos en lecture pour permettre aux navigateurs
// d’afficher les clichés sans passer par un serveur dynamique.  Le
// chemin virtuel /photos reflète les sous‑répertoires créés lors des
// sessions.  Exemple : /photos/soiree-2025-07-27-20h15/1722059800000.png
const photosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'photos');
app.use('/photos', express.static(photosDir));

// Permet aux invités d’envoyer une image.  Le corps de la requête doit
// contenir la propriété `image` (data URI) et la propriété `key` (clé
// de session). Si l’image ou la clé sont manquantes ou invalides, la
// requête est rejetée.  Les images sont nommées en fonction de l’horodatage
// actuel afin d’éviter les collisions.
app.post('/upload-photo', async (req, res) => {
  try {
    const { image, key } = req.body || {};
    if (!image || !key) {
      return res.status(400).json({ error: 'Missing image or key' });
    }
    // Vérifie que la session demandée correspond à la session courante
    if (key !== sessionKey) {
      return res.status(403).json({ error: 'Invalid session key' });
    }
    if (!sessionName) {
      return res.status(400).json({ error: 'No active session' });
    }
    // Interdit l’envoi de photos si la session est terminée
    const sessionInfo = sessions[sessionKey];
    if (sessionInfo && sessionInfo.status !== 'active') {
      return res.status(400).json({ error: 'Session terminated' });
    }
    // Analyse du Data URI
    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    const ext = match[1];
    const data = match[2];
    const buffer = Buffer.from(data, 'base64');
    // Création du dossier si nécessaire
    const albumDir = path.join(photosDir, sessionName);
    await fs.mkdir(albumDir, { recursive: true });
    const fileName = `${Date.now()}.${ext}`;
    await fs.writeFile(path.join(albumDir, fileName), buffer);
    res.json({ message: 'Photo saved', file: fileName });
  } catch (e) {
    console.error('Erreur upload-photo', e);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

// Fournit la liste des photos pour un album donné.  Si aucun nom n’est
// fourni via le paramètre de requête `name`, on renvoie les photos de
// la session en cours.  Retourne un tableau d’URLs relatives prêtes à
// être utilisées dans des balises <img>.
app.get('/photos-list', async (req, res) => {
  let name = req.query.name;
  // Par défaut, retourner les photos de la session actuelle
  if (!name) name = sessionName;
  if (!name) return res.json({ photos: [] });
  const albumDir = path.join(photosDir, name);
  try {
    const files = await fs.readdir(albumDir);
    // Exclut le fichier de métadonnées
    const filtered = files.filter(f => f !== 'name.txt');
    const urls  = filtered.map(f => `/photos/${encodeURIComponent(name)}/${encodeURIComponent(f)}`);
    res.json({ photos: urls });
  } catch (e) {
    // Si le dossier n’existe pas, retourner un tableau vide
    res.json({ photos: [] });
  }
});

// Liste tous les albums disponibles sur le serveur.  Chaque entrée
// contient le nom du répertoire (slug) et le nombre de photos qu’il
// contient.  Cette route est utilisée par l’interface admin pour
// proposer le téléchargement ou la suppression de séances terminées.
app.get('/albums', async (_req, res) => {
  try {
    const dirs = await fs.readdir(photosDir);
    const albums = [];
    for (const d of dirs) {
      try {
        const stat = await fs.stat(path.join(photosDir, d));
        if (stat.isDirectory()) {
        const files = await fs.readdir(path.join(photosDir, d));
        // Lecture du nom convivial si disponible
        let display = d;
        try {
          const meta = await fs.readFile(path.join(photosDir, d, 'name.txt'), 'utf8');
          display = meta.toString().trim() || d;
        } catch {
          // pas de nom.txt, on garde le slug
        }
        // Exclure le fichier name.txt du comptage des photos
        const count = files.filter(f => f !== 'name.txt').length;
        albums.push({ name: d, display, count });
        }
      } catch {
        // ignore anything that cannot be read
      }
    }
    res.json({ albums });
  } catch (e) {
    console.error('Erreur lors de la liste des albums', e);
    res.status(500).json({ error: 'Failed to list albums' });
  }
});

// Génère un fichier ZIP contenant toutes les photos d’un album.  Le ZIP
// est créé à la volée à l’aide de la bibliothèque JSZip (présente dans
// node_modules) et transmis directement au client.  La route renvoie
// 404 si l’album n’existe pas.
app.get('/album/:name/zip', async (req, res) => {
  const name = req.params.name;
  const albumDir = path.join(photosDir, name);
  try {
    const stat = await fs.stat(albumDir);
    if (!stat.isDirectory()) throw new Error('Not a directory');
  } catch {
    return res.status(404).json({ error: 'Album not found' });
  }
  try {
    const zip = new JSZip();
    const files = await fs.readdir(albumDir);
    for (const f of files) {
      // Ne pas inclure le fichier de métadonnées dans l’archive
      if (f === 'name.txt') continue;
      const data = await fs.readFile(path.join(albumDir, f));
      zip.file(f, data);
    }
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.send(content);
  } catch (e) {
    console.error('Erreur lors de la création du ZIP', e);
    res.status(500).json({ error: 'Failed to create zip' });
  }
});

// Supprime un album et toutes les photos qu’il contient.  Cette action est
// irréversible et doit être déclenchée uniquement par l’admin via
// l’interface DJ.  Après suppression, la liste des albums sera mise à
// jour côté client.
app.delete('/album/:name', async (req, res) => {
  const name = req.params.name;
  const albumDir = path.join(photosDir, name);
  try {
    await fs.rm(albumDir, { recursive: true, force: true });
    res.json({ message: 'Album deleted' });
  } catch (e) {
    console.error('Erreur lors de la suppression de l’album', e);
    res.status(500).json({ error: 'Failed to delete album' });
  }
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
