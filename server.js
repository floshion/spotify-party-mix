if (!recRes.ok) {
    console.error(`❌ Erreur Spotify (${recRes.status}) → fallback Top 50`);
    const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${FALLBACK_PLAYLIST}/tracks?limit=3&market=FR`, {
        headers: { 'Authorization': 'Bearer ' + access_token }
    });
    const playlistData = await playlistRes.json();
    if (playlistData.items && playlistData.items.length > 0) {
        const fallbackTracks = playlistData.items.map(item => ({
            uri: item.track.uri,
            name: item.track.name,
            artists: item.track.artists.map(a => a.name).join(', '),
            image: item.track.album.images[0]?.url || '',
            auto: true
        }));
        priorityQueue.push(...fallbackTracks);
        lastSeedTrack = playlistData.items[0].track.id;
        lastSeedInfo = { title: playlistData.items[0].track.name, artist: playlistData.items[0].track.artists.map(a => a.name).join(', ') };
        console.log(`➡️ Fallback : ${fallbackTracks.length} morceaux ajoutés depuis Top 50. Nouveau seed : ${lastSeedInfo.title}`);

        // Si rien ne joue, on démarre direct
        const playingRes = await fetch('https://api.spotify.com/v1/me/player', {
            headers: { 'Authorization': 'Bearer ' + access_token }
        });
        const playingData = await playingRes.json();
        if ((!playingData.is_playing || forcePlay) && priorityQueue.length > 0) {
            const firstTrack = priorityQueue.shift();
            await fetch('https://api.spotify.com/v1/me/player/play', {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: [firstTrack.uri] })
            });
            console.log("▶️ Lecture fallback démarrée :", firstTrack.name);
        }
    } else {
        console.log("❌ Fallback échoué : impossible de récupérer la playlist.");
    }
    return;
}
