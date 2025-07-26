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

const GETSONGBPM_KEY = "cca3a69eea0a43b88586829baaa0409e";

let priorityQueue = [];                  
let playedTracks  = new Set();

/* ---------- Auth Spotify ---------- */
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

/* ---------- Utils ---------- */
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

/* ---------- GetSongBPM API ---------- */
async function getTrackFeaturesFromGSBPM(title){
  try {
    const url = `https://api.getsongbpm.com/song/?api_key=${GETSONGBPM_KEY}&name=${encodeURIComponent(title)}`;
    const r = await fetch(url);
    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error("GSBPM non JSON. Status:", r.status, "URL:", url);
      console.error("Response text:", await r.text());
      return null;
    }
    const data = await r.json();
    if (data && data.search && data.search.length > 0){
      return {
        bpm: parseFloat(data.search[0].tempo) || 0,
        key: data.search[0].key || '',
        id: data.search[0].id
      };
    }
  } catch(e){ console.error("GSBPM Error:", e); }
  return null;
}

function scoreSimilarity(a, b){
  const bpmDiff = Math.abs((a?.bpm||0) - (b?.bpm||0));
  const keyDiff = (a?.key && b?.key && a.key===b.key) ? 0 : 5;
  return bpmDiff*2 + keyDiff;
}

/* ---------- Routes ---------- */
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

/* ---------- Suggestions harmonisées ---------- */
app.get('/suggest', async (req,res)=>{
  const query = req.query.q;
  if(!query) return res.status(400).json({error:'No query'});
  try {
    const current = await fetch('https://api.spotify.com/v1/me/player/currently-playing',
      {headers:{Authorization:'Bearer '+access_token}}).then(r=>r.json());
    const currentTitle = current?.item?.name + ' ' + current?.item?.artists?.map(a=>a.name).join(' ');
    if(!currentTitle) return res.status(400).json({error:'No current track'});
    const currentFeat = await getTrackFeaturesFromGSBPM(currentTitle);

    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10&market=FR`,
      {headers:{Authorization:'Bearer '+access_token}}).then(r=>r.json());
    const candidates = searchRes.tracks?.items || [];

    const scored = [];
    for(const tr of candidates){
      const feat = await getTrackFeaturesFromGSBPM(tr.name + ' ' + tr.artists.map(a=>a.name).join(' '));
      if(!feat) continue;
      const score = scoreSimilarity(currentFeat, feat);
      scored.push({
        uri: tr.uri,
        name: tr.name,
        artists: tr.artists.map(a=>a.name).join(', '),
        image: tr.album.images?.[0]?.url || '',
        score
      });
    }

    const top = scored.sort((a,b)=>a.score - b.score).slice(0,3);
    res.json({suggestions:top});
  } catch(e){
    console.error(e);
    res.status(500).json({error:'Server error'});
  }
});

/* ---------- Télécommande ---------- */
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

app.post('/skip', async (_req, res) => {
  const next = await fetch('http://localhost:'+PORT+'/next-track').then(r=>r.json());
  if (!next.track) return res.status(400).json({error:'No track'});

  const info = await fetch('https://api.spotify.com/v1/me/player',
    {headers:{Authorization:'Bearer '+access_token}}).then(r=>r.json());
  const deviceId = info?.device?.id;
  if(!deviceId) return res.status(500).json({error:'No active device'});

  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,{
    method:'PUT',
    headers:{Authorization:'Bearer '+access_token,'Content-Type':'application/json'},
    body:JSON.stringify({uris:[next.track.uri]})
  });

  res.json(next);
});

/* ---------- Static / boot ---------- */
const __filename=fileURLToPath(import.meta.url);
const __dirname =path.dirname(__filename);
app.use(express.static(path.join(__dirname,'static')));
app.get('/',     (_q,res)=>res.redirect('/player.html'));
app.get('/guest',(_q,res)=>res.redirect('/guest.html'));
app.get('/display',(_q,res)=>res.redirect('/display.html'));
app.get('/remote', (_q,res)=>res.redirect('/remote.html'));

app.listen(PORT,()=>console.log(`🚀 Server sur ${PORT}`));
setInterval(()=>autoFillQueue(),20*1000);
