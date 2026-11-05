/** Run this trusted checkout's tools on selected product and test SHAs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIndependent } from './helpers/independent-ci.js';

const values=process.argv.slice(2);
const option=(name,fallback)=>values.includes(name)?values[values.indexOf(name)+1]:fallback;
const harnessRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(option('--root','.'));
const product=option('--product');
const tests=option('--tests',product);
const outDir=path.resolve(option('--out','test-results/independent'));
const exit=await runIndependent({root,product,tests,harnessRoot,harness:option('--harness'),outDir,
  selection:process.env.TESTS ?? '',timed:process.env.TIMED==='true',run:process.env.GITHUB_RUN_ID || 'local',attempt:process.env.GITHUB_RUN_ATTEMPT || '1'});
// Only trusted code writes the external receipt; child code never receives this path.
if (process.env.EXECUTION_RECEIPT) fs.copyFileSync(path.join(outDir,'execution.json'),process.env.EXECUTION_RECEIPT);
for (const folder of ['test-results','coverage']) {
  const dir=path.join(outDir,folder);
  if (fs.existsSync(dir)) fs.copyFileSync(path.join(outDir,'execution.json'),path.join(dir,'execution.json'));
}
process.exitCode=exit;
