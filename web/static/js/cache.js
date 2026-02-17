const CACHE_NAME = 'listen-together-audio-v1';

class AudioCache {
    async get(url) {
        try {
            const cache = await caches.open(CACHE_NAME);
            const response = await cache.match(url);
            return response ? await response.arrayBuffer() : null;
        } catch { return null; }
    }

    async put(url, arrayBuffer) {
        try {
            const cache = await caches.open(CACHE_NAME);
            const response = new Response(arrayBuffer, {
                headers: { 'Content-Type': 'audio/mp4' }
            });
            await cache.put(url, response);
        } catch (e) { console.warn('Cache put failed:', e); }
    }

    async clear() {
        try { await caches.delete(CACHE_NAME); } catch {}
    }
}

window.audioCache = new AudioCache();
