#!/usr/bin/env bash
# One-time: build the pristine "old PHP shop with 300 product photos" for the photo scenario.
set -e
[ "${DC_DEV_TOOLS:-}" = 1 ] || { echo "Dev-only script for a throwaway VPS (writes /var/tmp/dctest/photokit). Set DC_DEV_TOOLS=1 to run it."; exit 1; }
K=/var/tmp/dctest/photokit; P=$K/pristine/public_html
rm -rf $K/pristine; mkdir -p $P/images/products $P/css $P/tools
cat > $P/index.php <<'PHP'
<?php include 'config.php'; $items = glob('images/products-web/*.jpg'); ?>
<html><head><title><?= SHOP_NAME ?></title><link rel="stylesheet" href="css/style.css"></head>
<body><h1><?= SHOP_NAME ?></h1><?php foreach ($items as $i) echo "<img src='$i' width=200>"; ?></body></html>
PHP
printf "<?php\ndefine('SHOP_NAME', 'Linden Tea House');\ndefine('PHOTO_DIR', 'images/products-web');\n" > $P/config.php
echo 'body{font-family:Verdana}' > $P/css/style.css
cd $P/tools && npm init -y >/dev/null && npm install sharp@0.33 --no-audit --no-fund --loglevel=error
node -e "
const sharp=require('sharp');const path=require('path');
(async()=>{for(let i=1;i<=300;i++){const f=path.join('$P/images/products','product-'+String(i).padStart(4,'0')+'.jpg');
await sharp({create:{width:1600,height:1200,channels:3,background:{r:(i*37)%255,g:(i*91)%255,b:(i*13)%255},noise:{type:'gaussian',mean:128,sigma:20}}}).jpeg({quality:85}).toFile(f);}})();"
echo 'this is not an image (upload failed in 2009)' > $P/images/products/product-0181.jpg
rm -f $P/tools/package-lock.json
du -sh $P/images/products $P/tools/node_modules; ls $P/images/products | wc -l
