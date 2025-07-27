import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs/promises';
import JSZipPkg from 'jszip';
const JSZip = JSZipPkg?.default || JSZipPkg;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'static')));

let sessions = {}; // { sessionKey: { name, photos: [], status: 'active'|'terminated' } }
let currentSession = null;

// Spotify
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
let accessToken = null;
let refreshToken = null;

// ====== Spotify Helpers ======
async function getAccessToken() {
    if (accessToken) return accessToken;
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') },
        body: new URLSearchParams({ grant_type: 'client_credentials' })
    });
    const data = await tokenResponse.json();
    accessToken = data.access_token;
    return accessToken;
}

async function resetSpotifyPlayer() {
    const token = await getAccessToken();
    // Ici on pourrait relancer une playlist par défaut
    await fetch('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [] }) // vide la queue
    }).catch(() => { });
}

// ====== Sessions ======
function createNewSession(name = "Nouvelle soirée") {
    const key = crypto.randomBytes(4).toString('hex');
    sessions[key] = { name, photos: [], status: 'active' };
    currentSession = key;
    return key;
}

function endSession() {
    if (currentSession && sessions[currentSession]) {
        sessions[currentSession].status = 'terminated';
        currentSession = null;
    }
}

// ====== API ======

// Créer une nouvelle soirée
app.post('/new-session', async (req, res) => {
    const { name } = req.body;
    endSession();
    const newKey = createNewSession(name || "Nouvelle soirée");
    await resetSpotifyPlayer();
    res.json({ sessionKey: newKey });
});

// Terminer la soirée actuelle
app.post('/end-session', (req, res) => {
    endSession();
    res.json({ success: true });
});

// Vérifier état d'une soirée
app.get('/session-status/:key', (req, res) => {
    const { key } = req.params;
    if (!sessions[key]) return res.status(404).json({ error: "Session introuvable" });
    const sess = sessions[key];
    res.json({ status: sess.status, photos: sess.photos });
});

// Ajouter une photo
app.post('/upload-photo', async (req, res) => {
    if (!currentSession) return res.status(400).json({ error: "Pas de session active" });
    const { image } = req.body;
    const filename = `photo_${Date.now()}.png`;
    const dir = path.join(__dirname, 'photos', currentSession);
    await fs.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    const buffer = Buffer.from(image.split(',')[1], 'base64');
    await fs.writeFile(filepath, buffer);
    sessions[currentSession].photos.push(`/photos/${currentSession}/${filename}`);
    res.json({ success: true, url: `/photos/${currentSession}/${filename}` });
});

// Servir les photos
app.use('/photos', express.static(path.join(__dirname, 'photos')));

// Pages HTML
app.get('/guest', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'guest.html'));
});
app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'player.html'));
});

app.listen(PORT, () => console.log(`🚀 Server sur ${PORT}`));
