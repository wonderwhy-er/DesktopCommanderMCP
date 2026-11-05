/** Validate external execution receipts before privileged result publication. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {platformJobs,resultsArtifactOf} from './ci-platforms.js';

export function latestExecutionJobs(jobs) {
  const latest=new Map();
  for (const job of jobs) {
    const previous=latest.get(job.name);
    if (!previous || Number(job.run_attempt)>Number(previous.run_attempt) ||
      (Number(job.run_attempt)===Number(previous.run_attempt) && Number(job.id)>Number(previous.id))) latest.set(job.name,job);
  }
  return [...latest.values()];
}

/** GitHub can clone a retained successful job into a newer attempt without executing it again. */
export function artifactAttempt({receipt,jobs,artifacts,resultName,coverageName,os,expected}) {
  if (!/^[1-9]\d*$/.test(receipt?.attempt??'') || !/^[1-9]\d*$/.test(expected.attempt??'')) throw Error('Invalid producer attempt');
  const candidates=platformJobs(jobs,os).filter(job=>resultsArtifactOf(job,os).artifact===resultName);
  if (!candidates.length || candidates.some(job=>String(job.run_id)!==expected.run || !Number.isSafeInteger(job.run_attempt) || job.run_attempt<1)) throw Error('Missing producer job metadata');
  const latest=latestExecutionJobs(candidates)[0];
  if (latest.run_attempt>Number(expected.attempt)) throw Error('A newer producer attempt exists');
  const executionKey=job=> {
    const start=Date.parse(job.started_at),end=Date.parse(job.completed_at);
    if (job.status!=='completed' || !Number.isFinite(start) || !Number.isFinite(end) || end<start || !Number.isSafeInteger(job.runner_id) || job.runner_id<1 || !job.runner_name) throw Error('Producer execution metadata is incomplete');
    return JSON.stringify([job.name,start,end,job.runner_id,job.runner_name]);
  };
  const latestKey=executionKey(latest);
  const sameExecution=candidates.filter(job=> {
    try {return executionKey(job)===latestKey;} catch {return false;}
  });
  const original=sameExecution.reduce((first,job)=>job.run_attempt<first.run_attempt?job:first,latest);
  if (String(original.run_attempt)!==receipt.attempt) throw Error('Latest producer replaced the artifact execution or original attempt is missing');
  if (latest!==original && (original.conclusion!=='success' || latest.conclusion!=='success')) throw Error('Latest producer replaced the artifact execution');
  if (receipt.exit===0 && latest.conclusion!=='success') throw Error('Latest producer failed after execution');
  const names=[resultName,...(receipt.outputs?.some(item=>item.file.startsWith('coverage/'))?[coverageName]:[])];
  for (const name of names) {
    const eligible=artifacts.filter(artifact=> {
      const made=Date.parse(artifact.created_at);
      return artifact.name===name && artifact.expired===false && String(artifact.workflow_run?.id)===expected.run &&
        made>=Date.parse(original.started_at) && made<=Date.parse(original.completed_at);
    });
    if (eligible.length!==1) throw Error(`Missing artifact for eligible producer: ${name}`);
  }
  return String(original.run_attempt);
}

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
