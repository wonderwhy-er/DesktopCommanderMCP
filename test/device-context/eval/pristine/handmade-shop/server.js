// Clay & Co online shop. Reads settings from .env, serves products from a JSON file.
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=').map((x) => x.trim()))
);
const PORT = Number(env.PORT || 3000);
const DATA_FILE = path.join(__dirname, env.DATA_FILE || 'data/products.json');
const products = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<h1>${env.SHOP_NAME || 'Shop'}</h1><ul>${products.map((p) => `<li>${p.name} — €${p.price}</li>`).join('')}</ul>`);
}).listen(PORT, () => console.log(`shop listening on :${PORT}`));
