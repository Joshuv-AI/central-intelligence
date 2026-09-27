// Central Intelligence — SSE client registry.
// One-way push: the backend broadcasts a message on every sweep completion.
// Clients reconnect on their own; no per-client state is kept.
const clients = new Set();

function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  for (const res of [...clients]) send(res, event, data);
}

// Keep idle connections alive through proxies.
setInterval(() => {
  for (const res of [...clients]) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 25000).unref();

module.exports = { addClient, broadcast, clientCount: () => clients.size };
