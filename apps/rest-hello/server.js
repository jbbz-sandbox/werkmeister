// Zero-dependency REST app — Node stdlib http only.
// ponytail: no express; stdlib http covers 2 routes fine. Add a framework when routing gets real.
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      message: 'hello from the REST app',
      hostname: require('os').hostname(), // the k8s pod name — proves which replica served you
      time: new Date().toISOString(),
    }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`rest-hello listening on :${PORT}`));
