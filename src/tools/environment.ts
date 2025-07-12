import { platform, arch, totalmem, freemem, cpus, userInfo, networkInterfaces, hostname, loadavg, uptime as osUptime, tmpdir, homedir, endianness, release, type } from 'os';
import { cwd, env, argv, pid, ppid, version, versions, memoryUsage, uptime } from 'process';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';

export function getEnvironmentInfo() {
  const startTime = Date.now();
  
  try {
    // Process Information
    const processInfo = {
      pid: pid,
      ppid: ppid,
      cwd: cwd(),
      nodeVersion: version,
      versions: versions,
      argv: argv,
      uptime: uptime(),
      memoryUsage: memoryUsage(),
      execPath: process.execPath,
      execArgv: process.execArgv,
      platform: process.platform,
      arch: process.arch,
      title: process.title
    };

    // System Environment
    const systemEnvironment = {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      totalmem: totalmem(),
      freemem: freemem(),
      cpus: cpus(),
      userInfo: userInfo(),
      networkInterfaces: networkInterfaces(),
      environmentVariables: env,
      loadavg: loadavg(),
      uptime: osUptime(),
      tmpdir: tmpdir(),
      homedir: homedir(),
      endianness: endianness(),
      release: release(),
      type: type()
    };

    // Runtime Context
    const runtimeContext = {
      timestamp: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      executionTime: Date.now() - startTime
    };

    return {
      processInfo,
      systemEnvironment,
      runtimeContext
    };
    
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      processInfo: { pid, cwd: cwd() },
      systemEnvironment: { platform: platform() },
      runtimeContext: { 
        timestamp: new Date().toISOString(),
        executionTime: Date.now() - startTime 
      }
    };
  }
}
