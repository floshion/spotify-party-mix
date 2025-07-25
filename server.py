#!/usr/bin/env python3
# Simple Spotify DJ server
#
# This server manages a shared music queue for a party. Guests can search
# the Spotify catalogue using the client‑credentials flow and add tracks
# to the queue without needing a Spotify account. The host logs in via
# the Spotify Web Playback SDK from the admin page to control playback
# on their own Spotify Premium account.
#
# Features implemented:
# - Search the Spotify catalogue (tracks only) via the client‑credentials flow
# - Maintain an in‑memory queue of proposed tracks with an approval flag
# - Simple REST API for guests and admin actions (add track, list queue,
#   approve/refuse tracks, skip to next track)
# - Serve static HTML/JS files for the admin and guest interfaces
#
# Limitations:
# - Crossfade transitions are handled by the user's Spotify settings. The API
#   does not expose direct control over crossfade length, so the host should
#   enable crossfade in their Spotify settings (e.g. 6 s) for smoother
#   transitions. Future versions could implement client‑side audio mixing
#   using the Web Audio API with track previews, but this requires more
#   development time.
# - The queue and state live in memory; if the server restarts the queue is
#   lost. A persistent database (e.g. Redis or SQLite) would be needed for
#   production use.

import base64
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Spotify credentials (replace with your own client ID and secret).
# In a production environment these should be stored in environment
# variables and not committed to source control. We embed them here
# because Render will set them as environment variables when deploying.
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "c785d51978c7481fb05c6781cea3e9fa")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "6896b635e1f94593b78cb26bef981fac")

# Scopes requested for client‑credentials flow (search and audio features
# only). The client‑credentials flow does not permit playback control.
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search"
SPOTIFY_AUDIO_FEATURES_URL = "https://api.spotify.com/v1/audio-features"

# Global state
access_token = None
token_expires_at = 0.0
queue_lock = threading.Lock()
music_queue: list[dict] = []  # Each item: {"id": str, "title": str, "artist": str, "approved": bool, "proposed_by": str}
current_track: dict | None = None


def fetch_access_token() -> None:
    """Fetch a fresh access token using the client credentials flow.

    This function updates the global access_token and token_expires_at
    variables. It will raise an exception if the request fails.
    """
    global access_token, token_expires_at
    auth_header = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        SPOTIFY_TOKEN_URL,
        data=data,
        headers={"Authorization": f"Basic {auth_header}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read().decode())
        access_token = body.get("access_token")
        expires_in = body.get("expires_in", 3600)
        token_expires_at = time.time() + expires_in - 60  # Refresh one minute before expiry
        # print(f"Fetched new token (expires in {expires_in}s)")


def ensure_token() -> str:
    """Ensure we have a valid access token, refreshing if necessary.
    Returns the current token."""
    global access_token
    if not access_token or time.time() >= token_expires_at:
        fetch_access_token()
    return access_token


def spotify_search(query: str, limit: int = 10) -> list[dict]:
    """Search Spotify tracks by query and return a list of simplified track dicts.

    Each dict has keys: id, title, artist, uri, duration_ms.
    """
    token = ensure_token()
    params = urllib.parse.urlencode({
        "q": query,
        "type": "track",
        "limit": str(limit),
    })
    url = f"{SPOTIFY_SEARCH_URL}?{params}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            tracks = data.get("tracks", {}).get("items", [])
            results: list[dict] = []
            for item in tracks:
                track_info = {
                    "id": item.get("id"),
                    "title": item.get("name"),
                    "artist": ", ".join([a.get("name") for a in item.get("artists", [])]),
                    "uri": item.get("uri"),
                    "duration_ms": item.get("duration_ms"),
                }
                results.append(track_info)
            return results
    except Exception as e:
        print(f"Search error: {e}")
        return []


def get_audio_features(track_id: str) -> dict | None:
    """Fetch tempo and key for a given track ID.

    Returns a dict with tempo and key if available, or None on failure.
    """
    token = ensure_token()
    url = f"{SPOTIFY_AUDIO_FEATURES_URL}/{track_id}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            return {
                "tempo": data.get("tempo"),
                "key": data.get("key"),
                "mode": data.get("mode"),
            }
    except Exception as e:
        print(f"Audio features error: {e}")
        return None


class DJRequestHandler(SimpleHTTPRequestHandler):
    """Custom request handler for the party DJ server."""

    # Serve files from the 'static' directory by default
    def translate_path(self, path: str) -> str:
        # Override to serve static files from app/static
        # root_dir is the directory containing this script
        root_dir = os.path.dirname(os.path.abspath(__file__))
        # If the path starts with /api, we keep it for API handling
        if path.startswith("/api"):
            return super().translate_path(path)
        # Otherwise, serve from static directory
        static_dir = os.path.join(root_dir, "static")
        # Remove leading '/'
        rel_path = path.lstrip("/")
        fs_path = os.path.join(static_dir, rel_path)
        return fs_path

    def end_headers(self):
        # Allow CORS for all origins (for simplicity). In production, restrict origins.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        # Respond to CORS preflight
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.handle_api_get()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.handle_api_post()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def parse_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b""
            return json.loads(body.decode()) if body else {}
        except Exception:
            return {}

    def handle_api_get(self):
        """Handle GET requests to /api endpoints."""
        global music_queue, current_track
        # /api/search?q=...
        if self.path.startswith("/api/search"):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
            results = spotify_search(query) if query else []
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(results).encode())
        # /api/queue
        elif self.path.startswith("/api/queue"):
            with queue_lock:
                resp = [dict(item) for item in music_queue]
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode())
        # /api/current
        elif self.path.startswith("/api/current"):
            with queue_lock:
                now = current_track
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(now or {}).encode())
        # /api/audio_features?id=...
        elif self.path.startswith("/api/audio_features"):
            parsed = urllib.parse.urlparse(self.path)
            track_id = urllib.parse.parse_qs(parsed.query).get("id", [""])[0]
            features = get_audio_features(track_id) if track_id else None
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(features or {}).encode())
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint")

    def handle_api_post(self):
        """Handle POST requests to /api endpoints."""
        global music_queue, current_track
        if self.path.startswith("/api/add"):
            data = self.parse_json_body()
            track_id = data.get("id")
            title = data.get("title")
            artist = data.get("artist")
            proposer = data.get("proposed_by", "guest")
            if track_id and title:
                with queue_lock:
                    # Avoid duplicates (by track ID)
                    exists = any(item["id"] == track_id for item in music_queue)
                    if not exists:
                        music_queue.append({
                            "id": track_id,
                            "title": title,
                            "artist": artist,
                            "approved": True,  # In V1 all proposals are auto‑approved; admin can refuse later
                            "proposed_by": proposer,
                        })
                        # If no current track, start immediately
                        if current_track is None:
                            current_track = music_queue.pop(0)
                self.send_response(HTTPStatus.CREATED)
                self.end_headers()
            else:
                self.send_error(HTTPStatus.BAD_REQUEST, "Missing track details")
        elif self.path.startswith("/api/admin/approve"):
            data = self.parse_json_body()
            track_id = data.get("id")
            if track_id:
                with queue_lock:
                    for item in music_queue:
                        if item["id"] == track_id:
                            item["approved"] = True
                            break
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
            else:
                self.send_error(HTTPStatus.BAD_REQUEST, "Missing track ID")
        elif self.path.startswith("/api/admin/remove"):
            data = self.parse_json_body()
            track_id = data.get("id")
            if track_id:
                with queue_lock:
                    music_queue = [item for item in music_queue if item["id"] != track_id]
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
            else:
                self.send_error(HTTPStatus.BAD_REQUEST, "Missing track ID")
        elif self.path.startswith("/api/admin/next"):
            # Skip to the next approved track in the queue
            with queue_lock:
                if music_queue:
                    current_track = music_queue.pop(0)
                else:
                    current_track = None
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint")


def load_default_playlists() -> None:
    """Preload the queue with a few tracks from default themes.

    This function searches for generic playlists and adds the first few
    results to the queue. It runs once at server startup.
    """
    themes = [
        "Hits populaires 2025",
        "Électro chill",
        "Funk groove",
    ]
    for theme in themes:
        results = spotify_search(theme, limit=5)
        for track in results:
            with queue_lock:
                # Prevent duplicates
                if any(item["id"] == track["id"] for item in music_queue):
                    continue
                music_queue.append({
                    "id": track["id"],
                    "title": track["title"],
                    "artist": track["artist"],
                    "approved": True,
                    "proposed_by": "default",
                })


def run_server(host: str = "0.0.0.0", port: int = 3000) -> None:
    """Run the threading HTTP server.

    The port can be overridden by the PORT environment variable. If the
    specified port is already in use, the server will try the next
    sequential port until it finds an available one.
    """
    # Override port from environment if provided (useful on Render)
    port = int(os.environ.get("PORT", port))
    # Preload some music into the queue (non‑blocking failure)
    try:
        print("Fetching default playlist tracks...")
        load_default_playlists()
    except Exception as e:
        print(f"Could not load default playlists: {e}")
    # Attempt to bind the server; if the port is in use, increment
    while True:
        try:
            server = ThreadingHTTPServer((host, port), DJRequestHandler)
            break
        except OSError as e:
            if e.errno == 98:  # Address already in use
                print(f"Port {port} in use, trying {port+1}")
                port += 1
                continue
            else:
                raise
    print(f"Server listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()