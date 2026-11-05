/** Validate external execution receipts before privileged result publication. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function verifyExecution(receipt, expected, {allowFailure=false}={}) {
  for (const field of ['product','tests','harness','run','attempt']) {
    if (!expected[field] || receipt?.[field]!==expected[field]) throw Error(`Execution identity mismatch: ${field}`);
  }
  if (receipt.phase!=='complete' || (receipt.exit!==0 && !(allowFailure && receipt.exit===1))) throw Error('Execution did not complete successfully');
  if (!Array.isArray(receipt.outputs) || !receipt.outputs.length) throw Error('Execution has no output manifest');
  for (const item of receipt.outputs) {
    if (!/^(coverage|test-results)\/[\w./-]+$/.test(item.file) || item.file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid output manifest');
  }
}

export function verifyOutputs(dir,receipt,expected) {
  verifyExecution(receipt,expected);
  for (const {file,sha256} of receipt.outputs) {
    const target=path.join(dir,file);
    if (!fs.existsSync(target) || createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==sha256) throw Error(`Missing or changed execution output: ${file}`);
  }
}

export function verifyArtifacts({results,coverage,expected}) {
  const receipt=JSON.parse(fs.readFileSync(path.join(results,'execution.json'),'utf8'));
  verifyExecution(receipt,expected,{allowFailure:true});
  for (const {file,sha256} of receipt.outputs) {
    const [kind,...parts]=file.split('/');
    const target=path.join(kind==='coverage'?coverage:results,...parts);
    if (!fs.existsSync(target) || createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==sha256) throw Error(`Missing or changed execution output: ${file}`);
  }
  if (!receipt.outputs.some(item=>/^test-results\/.+\/results\.json$/.test(item.file))) throw Error('No test results in execution manifest');
  return receipt;
}
