process.stdout.write('> ');
setInterval(() => {
  process.stdout.write('post-resolve-stdout\n');
  process.stderr.write('post-resolve-stderr\n');
}, 10);
