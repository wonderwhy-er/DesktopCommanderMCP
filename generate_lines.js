import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the output file
const outputPath = path.join('/Users/eduardruzga/work/ClaudeServerCommander/new_folder', 'file_with_1500_lines.txt');

// Generate 1500 lines of content
let fileContent = '';
for (let i = 1; i <= 1500; i++) {
    fileContent += `This is line ${i} of 1500.\n`;
}

// Create the directory if it doesn't exist
const dirPath = path.dirname(outputPath);
if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`Directory created: ${dirPath}`);
}

// Write the file
fs.writeFileSync(outputPath, fileContent);
console.log(`File created with 1500 lines at: ${outputPath}`);
