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
let refresh_token = null;

// Redirige vers Spotify pour login
app.get('/login', (req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scope)}`;
  console.log("Redirection vers Spotify :", authUrl);
  res.redirect(authUrl);
});

// Callback Spotify → échange le code contre token
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  console.log("Code reçu de Spotify :", code);

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
  console.log("Réponse échange code/token :", data);

  access_token = data.access_token;
  refresh_token = data.refresh_token;

  if (!access_token) {
    return res.status(500).send("Impossible d'obtenir un token Spotify.");
  }

  res.redirect('/static/player.html');
});

// Fournit un access_token actualisé
app.get('/token', async (req, res) => {
  if (!refresh_token) {
    console.log("Pas de refresh_token enregistré.");
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh_token,
      client_id: client_id,
      client_secret: client_secret
    })
  });

  const data = await response.json();
  console.log("Réponse Spotify refresh_token :", data);
  if (data.error) {
    return res.status(500).json({ error: 'Spotify token refresh failed', details: data });
  }

  access_token = data.access_token;
  res.json({ access_token });
});

// Servir les fichiers statiques
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/static', express.static(path.join(__dirname, 'static')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
