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

const SOURCE_PLAYLIST     = '1g39kHQqy4XHxGGftDiUWb';
const TARGET_QUEUE_LENGTH = 6;

let priorityQueue = [];                  // [{ uri,name,artists,image,auto }]
let playedTracks  = new Set();

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

/* ---------- Utils ---------------------------------------------------------------- */
function purgeQueue(){ priorityQueue = priorityQueue.filter(t=>!playedTracks.has(t.uri)); }
function deduplicateQueue(){
  const seen=new Set();
  priorityQueue = priorityQueue.filter(t=>{ if(seen.has(t.uri)) return false; seen.add(t.uri); return true;});
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
    if(playedTracks.has(item.track.uri)) continue;
    out.push({
      uri:item.track.uri,
      name:item.track.name,
      artists:item.track.artists.map(a=>a.name).join(', '),
      image:item.track.album.images?.[0]?.url||'',
      auto:true
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
  const uri=req.query.uri;
  if(!uri) return res.status(400).json({error:'No URI'});
  if(playedTracks.has(uri)) return res.status(400).json({error:'Track already played'});

  const id = uri.split(':').pop();
  const track = await (await fetch(`https://api.spotify.com/v1/tracks/${id}?market=FR`,
    {headers:{Authorization:'Bearer '+access_token}})).json();

  const tInfo={ uri, name:track.name, artists:track.artists.map(a=>a.name).join(', '),
                image:track.album.images?.[0]?.url||'', auto:false };

  // -- on retire les autos, on met le titre en tête
  priorityQueue = priorityQueue.filter(t=>!t.auto);
  priorityQueue.unshift(tInfo);

  await autoFillQueue();
  res.json({message:'Track added', track:tInfo});
});

app.get('/priority-queue', (_q,res)=>res.json({queue:priorityQueue}));

app.get('/next-track', async (_q,res)=>{
  if(priorityQueue.length===0){
    priorityQueue.push(...await fetchRandomTracksFromPlaylist(SOURCE_PLAYLIST,1));
  }
  const next = priorityQueue.shift();
  if(!next) return res.status(400).json({error:'No track'});
  playedTracks.add(next.uri);
  await autoFillQueue();
  res.json({track:next});
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
