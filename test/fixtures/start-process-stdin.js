// A child that reads exact bytes until EOF; no shell quoting is involved.
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  console.log('STDIN_BASE64=' + Buffer.concat(chunks).toString('base64'));
});
