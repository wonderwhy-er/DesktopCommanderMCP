import { parseMarkdownToPdf } from './dist/tools/pdf/markdown.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const markdown = `
# Desktop Commander PDF Test

<style>
body {
    font-family: 'Segoe UI', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 40px;
}
h1 {
    border-bottom: 3px solid #fff;
    padding-bottom: 10px;
}
.box {
    background: rgba(255,255,255,0.2);
    border-radius: 10px;
    padding: 20px;
    margin: 20px 0;
}
.highlight {
    background: yellow;
    color: black;
    padding: 2px 8px;
    border-radius: 4px;
}
</style>

<div class="box">

## ✨ Styled Content

This PDF was generated with **custom CSS styling**!

- Gradient background
- Custom fonts
- Rounded box containers
- <span class="highlight">Highlighted text</span>

</div>

<div class="box">

## 📅 Generated

**Date:** ${new Date().toISOString()}

**Purpose:** Testing if PDF generation works without puppeteer cache

</div>
`;

async function main() {
    console.log('Generating PDF...');
    const pdfBuffer = await parseMarkdownToPdf(markdown);
    
    const outputPath = path.join(os.homedir(), 'Downloads', 'dc-test-styled.pdf');
    await fs.writeFile(outputPath, pdfBuffer);
    
    console.log(`PDF saved to: ${outputPath}`);
    return outputPath;
}

main().then(console.log).catch(console.error);
