import express from "express";
import fetch from "node-fetch";
const app = express();

// CONFIGURACIÓN
const API_KEY = "yeflix2025";
let count = 0;
const LIMIT = 60;

// EXTRACTOR PRINCIPAL
async function getPage(url) {
    return await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "*/*"
        }
    }).then(r => r.text());
}

// MP4UPLOAD
async function extractMP4Upload(url) {
    const page = await getPage(url);
    const match = page.match(/src:\s*"([^"]+)"/);
    if (match) return match[1];
    return null;
}

// DOODSTREAM
async function extractDood(url) {
    const page = await getPage(url);
    const match = page.match(/token=[^"]+/);
    if (!match) return null;
    const api = `https://doodapi.com/api/download?${match[0]}`;
    const json = await fetch(api).then(r => r.json());
    return json?.downloadUrl || null;
}

// FILEMOON
async function extractFileMoon(url) {
    const page = await getPage(url);
    const m = page.match(/file:"([^"]+)"/);
    return m ? m[1] : null;
}

// STREAMTAPE
async function extractStreamTape(url) {
    const page = await getPage(url);
    const m = page.match(/robotlink'\)\.innerHTML = '(.+?)'/);
    if (!m) return null;
    return "https:" + m[1].replace(" ", "");
}

// RUTEO
app.get("/extract", async (req, res) => {
    const { key, url } = req.query;
    if (key !== API_KEY) return res.json({ error: "invalid key" });
    if (!url) return res.json({ error: "url missing" });
    if (count >= LIMIT) return res.json({ error: "limit exceeded" });
    count++;

    let final = null;
    if (url.includes("mp4upload")) final = await extractMP4Upload(url);
    else if (url.includes("dood")) final = await extractDood(url);
    else if (url.includes("filemoon")) final = await extractFileMoon(url);
    else if (url.includes("streamtape")) final = await extractStreamTape(url);

    if (!final) return res.json({ error: "extraction failed" });
    res.json({ status: "success", url: final });
});

app.listen(10000, () => console.log("Proxy listo"));
