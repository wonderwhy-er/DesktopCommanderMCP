/**
 * CI's first job: which platforms this run tests (helpers/ci-platforms.js), from
 * the event GitHub Actions passes. Writes to GITHUB_OUTPUT, and prints:
 * - `platforms`: their names, a JSON list, e.g. ["linux","windows"];
 * - `os`: their runner images;
 * - `matrix`: the test job's matrix, a job per platform, or for an on-demand
 *   tests=timed a job per timed test and platform, from the list the workflow
 *   read at the commit (TIMED_LIST, test/timed.txt's text).
 *
 *   GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=event.json node test/ci-platforms.js
 */
import fs from 'fs';
import { matrixFor, osOf, platformsFor, timedNamesIn } from './helpers/ci-platforms.js';

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const platforms = platformsFor(process.env.GITHUB_EVENT_NAME, event);
const tests = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? event.inputs?.tests ?? '' : '';
if (tests === 'timed' && !process.env.TIMED_LIST) throw new Error('tests=timed: TIMED_LIST names no file with test/timed.txt\'s text');
const timed = tests === 'timed' ? timedNamesIn(fs.readFileSync(process.env.TIMED_LIST, 'utf8')) : [];
// Fail closed: asked for the timed tests and there are none, the run fails, not a green run with no job
if (tests === 'timed' && timed.length === 0) throw new Error('tests=timed: test/timed.txt names no test at this commit');
const matrix = matrixFor(osOf(platforms), { tests, timed });
const os = matrix.os ?? [...new Set(matrix.include.map((job) => job.os))];
const lines = [`platforms=${JSON.stringify(platforms)}`, `os=${JSON.stringify(os)}`, `matrix=${JSON.stringify(matrix)}`];
console.log(lines.join('\n'));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
