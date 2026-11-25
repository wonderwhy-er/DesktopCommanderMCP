// Travel notes: a tiny static blog. Serves posts/*.md as plain text.
const http = require('http'); const fs = require('fs'); const path = require('path');
http.createServer((req, res) => {
  const posts = fs.readdirSync(path.join(__dirname, 'posts')).filter((f) => f.endsWith('.md'));
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<h1>Travel notes</h1><ul>${posts.map((p) => `<li>${p.replace('.md', '')}</li>`).join('')}</ul>`);
}).listen(4000, () => console.log('blog listening on :4000'));
