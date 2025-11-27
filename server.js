// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

// Servir frontend
app.use(express.static('public'));

// ---- Caché en memoria (TTL en ms) ----
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 5; // 5 minutos

function setCache(key, value) {
    cache.set(key, { value, ts: Date.now() });
}
function getCache(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return e.value;
}

// -------------------------------------------------
// Intento RÁPIDO: descargar HTML y buscar .m3u8 (cheerio)
// -------------------------------------------------
async function tryFastExtract(pageUrl) {
    try {
        const resp = await axios.get(pageUrl, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
            },
            timeout: 15000
        });

        const $ = cheerio.load(resp.data);

        // Buscar en scripts donde suele aparecer "file":"https...m3u8"
        const scripts = $('script').map((i, el) => $(el).html()).get();
        for (let s of scripts) {
            if (!s) continue;
            // ejemplo: file":"https:\/\/...\/manifest.m3u8?token=...
            const m = s.match(/file"\s*:\s*"(https?:\\\/\\\/.*?m3u8[^"]*)"/);
            if (m && m[1]) {
                let url = m[1].replace(/\\\//g, '/');
                return url;
            }
            // otra variante sin escapes
            const m2 = s.match(/file"\s*:\s*"(https?:\/\/.*?m3u8[^"]*)"/);
            if (m2 && m2[1]) return m2[1];
        }

        // A veces hay un objeto dentro del HTML con "sources": [{"file":"...m3u8"}]
        const html = resp.data;
        const m3 = html.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/);
        if (m3 && m3[1]) return m3[1];

        return null;
    } catch (e) {
        return null;
    }
}

// -------------------------------------------------
// Fallback: usar Puppeteer para esperar el JS y capturar .m3u8
// -------------------------------------------------
async function tryPuppeteerExtract(pageUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
        });

        const page = await browser.newPage();
        let found = null;

        page.on('response', (response) => {
            try {
                const u = response.url();
                if (!found && u.includes('.m3u8')) {
                    found = u;
                }
            } catch (e) {}
        });

        await page.goto(pageUrl, { waitUntil: ['load', 'networkidle2'], timeout: 45000 });
        // dejar un corto tiempo para que los XHR aparezcan
        await new Promise(r => setTimeout(r, 3000));

        await browser.close();
        return found;
    } catch (err) {
        try { if (browser) await browser.close(); } catch(_) {}
        return null;
    }
}

// -------------------------------------------------
// Ruta /stream -> obtiene .m3u8 (cache -> fast -> puppeteer) y proxya
// -------------------------------------------------
app.get('/stream', async (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl) return res.status(400).send('Falta ?url=');

    // Normalizar clave de caché
    const cacheKey = pageUrl;

    // 1) Cache
    const cached = getCache(cacheKey);
    if (cached) {
        console.log('[CACHE] Usando .m3u8 cacheado para', pageUrl);
        try {
            const proxied = await axios({
                url: cached,
                method: 'GET',
                responseType: 'stream',
                headers: { 'Referer': pageUrl, 'User-Agent': 'Mozilla/5.0' },
                timeout: 20000
            });
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return proxied.data.pipe(res);
        } catch (e) {
            // si falla la descarga del cached url, borrar cache y continuar
            cache.delete(cacheKey);
            console.log('[CACHE] Falló descarga del cached .m3u8, borrando cache');
        }
    }

    // 2) Intento rápido
    console.log('[FAST] Intentando extraer rápido:', pageUrl);
    let m3u8 = await tryFastExtract(pageUrl);

    // 3) Fallback a Puppeteer si no obtuvo resultado
    if (!m3u8) {
        console.log('[FALLBACK] No obtuvo con método rápido. Intentando Puppeteer...');
        m3u8 = await tryPuppeteerExtract(pageUrl);
    }

    if (!m3u8) {
        return res.status(500).send('No se pudo obtener el stream (.m3u8)');
    }

    // Guardar en cache el m3u8 para próximas peticiones
    setCache(cacheKey, m3u8);
    console.log('[OK] .m3u8 obtenido y cacheado:', m3u8);

    // Proxyar el .m3u8 (puede ser que el m3u8 contenga rutas relativas a la que también se necesitan proxyar)
    try {
        const proxied = await axios({
            url: m3u8,
            method: 'GET',
            responseType: 'stream',
            headers: { 'Referer': pageUrl, 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        proxied.data.pipe(res);
    } catch (e) {
        console.error('Error proxying m3u8:', e.message);
        res.status(500).send('Error al descargar el .m3u8 remoto');
    }
});

// -------------------------------------------------
// Ruta /embed -> devuelve el player Netflix-dark embebible
// -------------------------------------------------
app.get('/embed', (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl) return res.status(400).send('Falta ?url=');

    const encoded = encodeURIComponent(pageUrl);

    res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Player - Netflix Dark</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>
    :root{
        --bg:#141414; --panel: rgba(20,20,20,0.9); --accent:#e50914; --muted:#9a9a9a;
    }
    html,body { height:100%; margin:0; background:var(--bg); color:#fff; font-family: Arial, Helvetica, sans-serif; }
    .player-wrap { width:100%; height:100vh; display:flex; align-items:center; justify-content:center; position:relative; background:#000; }
    video { width:100%; height:100%; object-fit:cover; background:black; }
    .controls {
        position:absolute; left:0; right:0; bottom:0; padding:16px; box-sizing:border-box;
        display:flex; flex-direction:column; gap:8px; background:linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 100%);
        transition:opacity .2s; opacity:1;
    }
    .bar { display:flex; align-items:center; gap:10px; }
    .btn { background:transparent; border:0; color:#fff; font-size:16px; cursor:pointer; padding:8px; }
    .big-btn { width:48px; height:48px; border-radius:50%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; }
    .progress {
        -webkit-appearance:none; appearance:none; width:100%;
        height:6px; background:rgba(255,255,255,0.12); border-radius:4px; cursor:pointer;
    }
    .progress::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px rgba(229,9,20,0.15); }
    .right { margin-left:auto; display:flex; gap:8px; align-items:center; }
    .small { font-size:13px; color:var(--muted); }
    .center-play { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; align-items:center; justify-content:center; }
    .center-play .big { width:96px; height:96px; border-radius:12px; background:linear-gradient(180deg, rgba(0,0,0,0.6), rgba(0,0,0,0.4)); display:flex; align-items:center; justify-content:center; font-size:36px; border:2px solid rgba(255,255,255,0.06); cursor:pointer; }
    .overlay-title { position:absolute; left:24px; top:24px; font-weight:700; font-size:18px; text-shadow:0 2px 8px rgba(0,0,0,0.7); }
</style>
</head>
<body>
<div class="player-wrap" id="wrap">
    <div class="overlay-title">Reproductor - Tema oscuro (Netflix style)</div>
    <video id="v" playsinline webkit-playsinline></video>

    <div class="center-play" id="center">
        <div class="big" id="centerBtn">►</div>
    </div>

    <div class="controls" id="controls">
        <input type="range" id="progress" class="progress" min="0" max="100" value="0">
        <div class="bar">
            <button class="btn big-btn" id="playBtn">►</button>
            <button class="btn" id="back10">⏪ 10s</button>
            <button class="btn" id="fwd10">10s ⏩</button>
            <div class="small" id="time">0:00 / 0:00</div>

            <div class="right">
                <select id="speed" class="btn small">
                    <option value="0.5">0.5x</option>
                    <option value="0.75">0.75x</option>
                    <option value="1" selected>1x</option>
                    <option value="1.25">1.25x</option>
                    <option value="1.5">1.5x</option>
                    <option value="2">2x</option>
                </select>

                <input id="volume" type="range" min="0" max="1" step="0.01" value="1" style="width:90px;">
                <button class="btn" id="fs">⛶</button>
            </div>
        </div>
    </div>
</div>

<script>
const encoded = '${encoded}';
const streamUrl = '/stream?url=' + encoded;

const video = document.getElementById('v');
const playBtn = document.getElementById('playBtn');
const centerBtn = document.getElementById('centerBtn');
const controls = document.getElementById('controls');
const progress = document.getElementById('progress');
const timeLabel = document.getElementById('time');
const back10 = document.getElementById('back10');
const fwd10 = document.getElementById('fwd10');
const speed = document.getElementById('speed');
const volume = document.getElementById('volume');
const fsBtn = document.getElementById('fs');
const center = document.getElementById('center');
let hideTimer = null;

function humanTime(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2,'0');
    return m + ':' + sec;
}

if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function() {
        // nothing
    });
} else {
    video.src = streamUrl;
}

function showControls() {
    controls.style.opacity = '1';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(()=> { controls.style.opacity = '0'; }, 3500);
}

document.body.addEventListener('mousemove', showControls);
document.body.addEventListener('touchstart', showControls);

video.addEventListener('timeupdate', () => {
    const pct = (video.currentTime / video.duration) * 100 || 0;
    progress.value = pct;
    timeLabel.textContent = humanTime(video.currentTime) + ' / ' + humanTime(video.duration);
});

progress.addEventListener('input', (e) => {
    const p = e.target.value;
    if (isFinite(video.duration)) {
        video.currentTime = (p/100) * video.duration;
    }
});

playBtn.addEventListener('click', togglePlay);
centerBtn.addEventListener('click', togglePlay);
center.addEventListener('click', (e)=>{ if (e.target.id === 'center') togglePlay(); });

function togglePlay(){
    if (video.paused) {
        video.play();
        playBtn.textContent = '❚❚';
        center.style.display = 'none';
    } else {
        video.pause();
        playBtn.textContent = '►';
        center.style.display = '';
    }
}

video.addEventListener('play', ()=> { playBtn.textContent = '❚❚'; center.style.display = 'none'; });
video.addEventListener('pause', ()=> { playBtn.textContent = '►'; center.style.display = ''; });

back10.addEventListener('click', ()=> { video.currentTime = Math.max(0, video.currentTime - 10); });
fwd10.addEventListener('click', ()=> { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); });

speed.addEventListener('change', ()=> { video.playbackRate = parseFloat(speed.value); });

volume.addEventListener('input', ()=> { video.volume = parseFloat(volume.value); });

fsBtn.addEventListener('click', ()=> {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
});

// Autoplay attempt with muted fallback
video.muted = false;
video.autoplay = true;
video.playsInline = true;

// try play (some browsers block autoplay without user gesture)
video.addEventListener('loadedmetadata', ()=>{
    // unmute if volume slider > 0
    if (volume.value > 0) video.muted = false;
});

// touch double-tap skip (mobile)
let lastTap = 0;
document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
        // double tap -> skip forward
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
    }
    lastTap = now;
});
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log('Servidor optimizado corriendo en http://localhost:' + PORT));
