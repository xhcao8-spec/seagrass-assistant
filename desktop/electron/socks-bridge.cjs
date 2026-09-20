const http = require('node:http');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrl = process.env.SEAGRASS_SOCKS_PROXY_URL;
if (!proxyUrl) throw new Error('SEAGRASS_SOCKS_PROXY_URL is required');

function targetForConnect(value = '') {
  const target = String(value).trim();
  const match = target.match(/^\[([^\]]+)\]:(\d+)$/u)
    || target.match(/^([^:]+):(\d+)$/u);
  if (!match) return null;
  return { host: match[1], port: Number(match[2]) };
}

const agent = new SocksProxyAgent(proxyUrl, { timeout: 20_000 });
const server = http.createServer((_request, response) => {
  response.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Only HTTPS CONNECT is supported by this local bridge.');
});

server.on('connect', (request, clientSocket, head) => {
  const target = targetForConnect(request.url);
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  agent.connect({ destroy() {} }, {
    host: target.host,
    port: target.port,
    secureEndpoint: false,
  }).then((socket) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clientSocket.destroy();
      socket.destroy();
    };
    // Chromium may cancel a CONNECT while the upstream SOCKS handshake is
    // still pending.  Without error listeners, ECONNRESET becomes an
    // uncaught exception and kills the bridge process for every window.
    clientSocket.once('error', (error) => {
      process.stderr.write(`BRIDGE_CLIENT_ERROR ${error?.code || error?.message || String(error)}\n`);
      close();
    });
    socket.once('error', (error) => {
      process.stderr.write(`BRIDGE_UPSTREAM_ERROR ${error?.code || error?.message || String(error)}\n`);
      close();
    });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.write(head);
    clientSocket.pipe(socket);
    socket.pipe(clientSocket);
    clientSocket.once('close', close);
    socket.once('close', close);
  }).catch((error) => {
    process.stderr.write(`SOCKS_CONNECT_FAILED ${error?.message || String(error)}\n`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
});

server.on('clientError', (error, socket) => {
  process.stderr.write(`BRIDGE_HTTP_ERROR ${error?.code || error?.message || String(error)}\n`);
  socket.destroy();
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});

function shutdown() {
  agent.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
