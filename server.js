const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { WebSocketServer } = require("ws");
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;


const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CSV_PATH = path.join(__dirname, "data/data.csv");
const JSON_PATH = path.join(__dirname, "data/data.json");
const THUMBNAILS_DIR = path.join(__dirname, "data/thumbnails");
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR);

async function getSpotifyToken() {
  const resp = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return resp.data.access_token;
}

async function searchOnSpotify(query, type) {
  const token = await getSpotifyToken();
  const resp = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type, limit: 5 },
  });

  if (type === "album") {
    const items = resp.data.albums?.items || [];
    return items.map(album => {
      const albumArtist = album.artists?.[0]?.name?.replace(/;/g, ",") || "Unknown Artist";
      const albumName = album.name?.replace(/;/g, ",") || "Unknown Album";
      const albumUri = album.uri || "";
      const albumArt = album.images?.[0]?.url || "";
      return { albumArtist, albumName, albumUri, albumArt };
    });
  } else if (type === "playlist") {
    const items = resp.data.playlists?.items || [];
    return items.map(playlist => {
      const albumArtist = playlist.owner?.display_name?.replace(/;/g, ",") || "Unknown Owner";
      const albumName = playlist.name?.replace(/;/g, ",") || "Unknown Playlist";
      const albumUri = playlist.uri || "";
      const albumArt = playlist.images?.[0]?.url || "";
      return { albumArtist, albumName, albumUri, albumArt };
    });
  } else if (type === "track") {
    const items = resp.data.tracks?.items || [];
    return items.map(track => {
      const albumArtist = track.artists?.[0]?.name?.replace(/;/g, ",") || "Unknown Artist";
      const albumName = track.name?.replace(/;/g, ",") || "Unknown Track";
      const albumUri = track.uri || "";
      const albumArt = track.album?.images?.[0]?.url || "";
      return { albumArtist, albumName, albumUri, albumArt };
    });
  } else if (type === "episode") {
    const items = resp.data.episodes?.items || [];
    return items.map(episode => {
      const albumArtist = episode.show?.publisher?.replace(/;/g, ",") || "Unknown Publisher";
      const albumName = episode.name?.replace(/;/g, ",") || "Unknown Episode";
      const albumUri = episode.uri || "";
      const albumArt = episode.images?.[0]?.url || "";
      return { albumArtist, albumName, albumUri, albumArt };
    });
  } else if (type === "audiobook") {
    const items = resp.data.audiobooks?.items || [];
    return items.map(audiobook => {
      const albumArtist = audiobook.authors?.[0]?.name?.replace(/;/g, ",") || "Unknown Author";
      const albumName = audiobook.name?.replace(/;/g, ",") || "Unknown Audiobook";
      const albumUri = audiobook.uri || "";
      const albumArt = audiobook.images?.[0]?.url || "";
      return { albumArtist, albumName, albumUri, albumArt };
    });
  }
  return [];
}

function loadData() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const content = fs.readFileSync(CSV_PATH, "utf8");
  return content
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => {
      const [card, name, url] = line.split(";");
      return { card, name, url };
    });
}

function saveData(rows) {
  let lines = rows.map(r => `${r.card};${r.name};${r.url}`);
  fs.writeFileSync(CSV_PATH, lines.join("\n"), "utf8");
  let map = {};
  rows.forEach(r => map[r.card] = `${r.url}:play`);
  fs.writeFileSync(JSON_PATH, JSON.stringify(map,null, '  '), "utf8");
}

let rows = loadData();

app.get("/data", (req, res) => {
  res.json(rows);
});

app.post("/update", (req, res) => {
  const { card, name, url } = req.body;
  const idx = rows.findIndex(r => r.card === card);
  if (idx !== -1) {
    rows[idx].name = name;
    rows[idx].url = url;
    saveData(rows);
    broadcast({ type: "updateCard", payload: rows[idx] });
  }
  res.json({ success: true });
});

app.post("/newCard", (req, res) => {
  const newCardId = req.body.id || "CARD_ID";
  if (rows.find(r => r.card === newCardId)) {
    broadcast({ type: "openCard", payload: newCardId });
    return res.status(400).send(`Card '${newCardId}' already exists!`);
  }
  const newRow = { card: newCardId, name: "", url: "" };
  rows.push(newRow);
  saveData(rows);
  broadcast({ type: "newCard", payload: newRow });
  res.send(`New row created with card='${newCardId}'.`);
});

app.get("/spotifySearch", async (req, res) => {
  try {
    const query = req.query.query || "";
    const type = req.query.type || "album";
    if (!query) return res.json([]);
    const results = await searchOnSpotify(query, type);
    res.json(results);
  } catch {
    res.status(500).json({ error: "Error searching Spotify" });
  }
});

app.post("/selectAlbum", async (req, res) => {
  const { card, albumArtist, albumName, albumUri, albumArt } = req.body;
  const idx = rows.findIndex(r => r.card === card);
  if (idx === -1) return res.status(404).json({ error: "Row not found" });
  rows[idx].name = `${albumArtist} - ${albumName}`;
  rows[idx].url = albumUri;
  try {
    const files = fs.readdirSync(THUMBNAILS_DIR);
    for (const file of files) {
      if (file.startsWith(`${card}_`)) fs.unlinkSync(path.join(THUMBNAILS_DIR, file));
    }
  } catch {}
  if (albumArt) {
    try {
      const sanitized = albumName.replace(/[^a-z0-9]/gi, "_").substring(0, 50);
      const filePath = path.join(THUMBNAILS_DIR, `${card}_${sanitized}.jpg`);
      const resp = await axios.get(albumArt, { responseType: "arraybuffer" });
      fs.writeFileSync(filePath, resp.data);
    } catch {}
  }
  saveData(rows);
  broadcast({ type: "updateCard", payload: rows[idx] });
  res.json({ success: true });
});

app.get("/openCard", (req, res) => {
  const cardId = req.query.id;
  broadcast({ type: "openCard", payload: cardId });
  res.sendStatus(200);
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

const wss = new WebSocketServer({ server });

function broadcast(msgObj) {
  const str = JSON.stringify(msgObj);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
}

wss.on("connection", ws => {});
