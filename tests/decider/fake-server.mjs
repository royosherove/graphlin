// A fake Decider server for tests. It listens on 127.0.0.1 with a free port
// only. It records each request and answers each System One request with
// literal answers. It never evaluates the source text.
import http from 'node:http';
import { responseValue } from '../jev/helpers.mjs';

export const deciderAnswer = request => ({ ...responseValue(request), model: request.model });

/**
 * respond(entry, res, count) writes the response. Without respond, the server
 * answers 200 with deciderAnswer for the request body.
 */
export async function fakeDeciderServer(t, respond) {
  const requests = [];
  const sockets = new Set();
  let connections = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8') };
      requests.push(entry);
      if (respond) return respond(entry, res, requests.length);
      const answer = JSON.stringify(deciderAnswer(JSON.parse(entry.body)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer);
    });
  });
  server.on('connection', socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  return {
    server, requests, port,
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    get connections() { return connections; },
    get openSockets() { return sockets.size; },
  };
}
