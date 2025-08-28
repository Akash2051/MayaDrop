import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const distPath = path.resolve(__dirname, '..', 'dist');

// Serve built client (after `npm run build`)
app.use(express.static(distPath));

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: false,
  maxPayload: 0
});

// id -> { ws, id, name, room }
const peers = new Map();

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function peersInRoom(room) {
  const arr = [];
  for (const [id, meta] of peers.entries()) {
    if (meta.room === room) arr.push({ id: meta.id, name: meta.name });
  }
  return arr;
}

function broadcastPeers(room) {
  const list = peersInRoom(room);
  for (const meta of peers.values()) {
    if (meta.room !== room) continue;
    sendJSON(meta.ws, { type: 'peers', peers: list });
  }
}

wss.on('connection', (ws) => {
  ws._id = null;
  ws._room = 'public';
  ws._relayTo = null;

  ws.on('message', (data, isBinary) => {
    // Raw binary relay: forward as-is
    if (isBinary) {
      const toId = ws._relayTo;
      if (!toId) return;
      const dest = peers.get(toId);
      if (!dest || dest.ws.readyState !== dest.ws.OPEN) return;
      dest.ws.send(data, { binary: true });
      return;
    }

    // JSON control
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'hello') {
      ws._id = msg.id;
      ws._room = msg.room || 'public';
      const name = msg.name || 'Anonymous';
      peers.set(ws._id, { ws, id: ws._id, name, room: ws._room });
      broadcastPeers(ws._room);
      return;
    }

    if (msg.type === 'signal') {
      const dest = peers.get(msg.to);
      if (!dest) return;
      sendJSON(dest.ws, { type: 'signal', from: msg.from, payload: msg.payload });
      return;
    }

    if (msg.type === 'transfer-offer') {
      const dest = peers.get(msg.to);
      if (!dest) return;
      sendJSON(dest.ws, { type: 'transfer-offer', from: msg.from, files: msg.files, senderName: msg.senderName });
      return;
    }

    if (msg.type === 'transfer-response') {
      const dest = peers.get(msg.to);
      if (!dest) return;
      sendJSON(dest.ws, { type: 'transfer-response', from: msg.from, accepted: msg.accepted });
      return;
    }

    if (msg.type === 'relay-chunk') {
      const dest = peers.get(msg.to);
      if (!dest) return;
      if (msg.fileMeta) {
        ws._relayTo = msg.to; // lock destination for following binary frames
        sendJSON(dest.ws, { type: 'relay-chunk', from: msg.from, fileMeta: msg.fileMeta });
        return;
      }
      if (msg.done) {
        sendJSON(dest.ws, { type: 'relay-chunk', from: msg.from, done: true });
        ws._relayTo = null;
        return;
      }
    }
  });

  ws.on('close', () => {
    if (ws._id && peers.has(ws._id)) {
      const room = ws._room || 'public';
      peers.delete(ws._id);
      broadcastPeers(room);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mayadrop server running at http://${HOST}:${PORT}`);
});
