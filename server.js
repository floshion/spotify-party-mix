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
let refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null; // PERMANENT

let priorityQueue = []; 
let lastSeedTrack = null; 
let lastSeedInfo = { title: "Inconnu", artist: "" };

const FALLBACK_PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M"; // Top 50 France

// --- Rafraîchissement permanent du token ---
async function refreshAccessToken() {
    if (!refresh_token) {
        console.log("❌ Aucun refresh_token disponible. Connecte-toi via /login pour le récupérer.");
        return;
    }
    try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refresh_token,
                client_id: client_id,
                client_secret: client_secret
            })
        });
        const data = await res.json();
        if (data.access_token) {
            access_token = data.access_token;
            console.log("🔄 Nouveau token Spotify généré");
        } else {
            console.error("❌ Échec du refresh token :", data);
        }
    } catch (err) {
        console.error("❌ Erreur lors du refresh token :", err);
    }
}

// Rafraîchir le token toutes les 50 minutes
setInterval(refreshAccessToken, 50 * 60 * 1000);

// --- Auth Spotify (1ère fois uniquement) ---
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

    console.log("🎉 Connexion réussie !");
    console.log("👉 COPIE CE REFRESH TOKEN DANS RENDER :", refresh_token);

    res.send("Connexion réussie ! Va coller le refresh_token dans Render (SPOTIFY_REFRESH_TOKEN), puis redéploie.");
});

// --- Vérifie si un track est valide ---
async function validateTrack(trackId) {
    const url = `https://api.spotify.com/v1/tracks/${trackId}?market=FR`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + access_token } });
    return res.ok;
}

// --- Récupère le morceau en cours comme seed ---
async function initSeedTrack() {
    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': 'Bearer ' + access_token }
        });
        if (res.status === 200) {
            const data = await res.json();
            if (data && data.item) {
                lastSeedTrack = data.item.id;
                lastSeedInfo = { title: data.item.name, artist: data.item.artists.map(a => a.name).join(', ') };
                console.log("Seed mis à jour :", lastSeedInfo.title);
            }
        }
    } catch (e) {
        console.error("Erreur lors de l'init du seed :", e);
    }
}

// --- Auto-fill queue ---
async function autoFillQueue(forcePlay = false) {
    try {
        await refreshAccessToken(); // Toujours rafraîchir avant
        if (!lastSeedTrack) {
            await initSeedTrack();
            if (!lastSeedTrack) {
                console.log("⚠️ Pas de seed disponible pour recommandations.");
                return;
            }
        }

        const isValid = await validateTrack(lastSeedTrack);
        if (!isValid) {
            console.log(`⚠️ Seed ${lastSeedTrack} invalide → fallback vers Top 50 France`);
            const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=1&market=FR`, {
                headers: { 'Authorization': 'Bearer ' + access_token }
            });
            const playlistData = await playlistRes.json();
            if (playlistData.items && playlistData.items.length > 0) {
                lastSeedTrack = playlistData.items[0].track.id;
                lastSeedInfo = { title: playlistData.items[0].track.name, artist: playlistData.items[0].track.artists.map(a => a.name).join(', ') };
                console.log("🎵 Nouveau seed choisi :", lastSeedInfo.title);
            } else {
                console.log("❌ Impossible de trouver un seed de fallback.");
                return;
            }
        }

        if (priorityQueue.length === 0) {
            const url = `https://api.spotify.com/v1/recommendations?limit=3&market=FR&seed_tracks=${lastSeedTrack}`;
            console.log("🎯 Requête recommandations avec seed :", lastSeedInfo.title, `(${lastSeedTrack})`);
            const recRes = await fetch(url, { headers: { 'Authorization': 'Bearer ' + access_token } });

            if (!recRes.ok) {
                const errText = await recRes.text();
                console.error(`❌ Erreur Spotify (${recRes.status}) : ${errText}`);
                console.log("➡️ Fallback : ajout direct depuis Top 50 France");
                const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=3`, {
                    headers: { 'Authorization': 'Bearer ' + access_token }
                });
                const playlistData = await playlistRes.json();
                if (playlistData.items) {
                    priorityQueue.push(...playlistData.items.map(item => ({
                        uri: item.track.uri,
                        name: item.track.name,
                        artists: item.track.artists.map(a => a.name).join(', '),
                        image: item.track.album.images[0]?.url || '',
                        auto: true
                    })));
                }
                return;
            }

            const recData = await recRes.json();
            if (recData.tracks && recData.tracks.length > 0) {
                const newTracks = recData.tracks.map(track => ({
                    uri: track.uri,
                    name: track.name,
                    artists: track.artists.map(a => a.name).join(', '),
                    image: track.album.images[0]?.url || '',
                    auto: true
                }));
                priorityQueue.push(...newTracks);
                console.log("✅ Auto-fill : ajout de recommandations");
            }
        }

        const playingRes = await fetch('https://api.spotify.com/v1/me/player', {
            headers: { 'Authorization': 'Bearer ' + access_token }
        });
        const playingData = await playingRes.json();
        if ((!playingData.is_playing || forcePlay) && priorityQueue.length > 0) {
            const firstTrack = priorityQueue.shift();
            lastSeedTrack = firstTrack.uri.split(":").pop();
            lastSeedInfo = { title: firstTrack.name, artist: firstTrack.artists };
            await fetch('https://api.spotify.com/v1/me/player/play', {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: [firstTrack.uri] })
            });
            console.log("▶️ Lecture auto démarrée :", firstTrack.name);
        }
    } catch (err) {
        console.error("❌ Erreur autoFillQueue:", err);
    }
}

// Vérification toutes les 5s
setInterval(autoFillQueue, 5000);

// --- Fichiers statiques ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'static')));

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await refreshAccessToken(); // Rafraîchit dès le démarrage
});
