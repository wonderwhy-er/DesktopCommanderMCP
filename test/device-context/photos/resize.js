const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'images', 'products');
const out = path.join(__dirname, '..', 'images', 'products-web');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const files = fs.readdirSync(src).filter((f) => /\.jpe?g$/i.test(f)).sort();
  let n = 0;
  for (const f of files) {
    await sharp(path.join(src, f)).resize({ width: 800 }).jpeg({ quality: 80 }).toFile(path.join(out, f));
    n++;
    if (n % 50 === 0) console.log(`${n}/${files.length}`);
  }
  console.log(`done ${n}/${files.length}`);
})();
