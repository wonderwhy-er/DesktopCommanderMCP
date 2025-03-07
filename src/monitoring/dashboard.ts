import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getBackupStats } from '../tools/backup.js';
import { getAllDirectoryPermissions, PermissionNames, PermissionLevel } from '../security/permissions.js';

interface MonitoringEvent {
  timestamp: string;
  type: string;
  details: Record<string, any>;
}

// Constants
const LOG_DIR = path.join(os.homedir(), '.claude-commander', 'logs');
const DEFAULT_PORT = 27182; // Claude's number
const eventCache: MonitoringEvent[] = [];
let dashboardServer: http.Server | null = null;
let isServerRunning = false;

// Initialize monitoring system
export async function initializeMonitoring(): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await loadRecentEvents();
}

// Load recent security and operation events
async function loadRecentEvents(maxEvents: number = 1000): Promise<void> {
  try {
    const files = await fs.readdir(LOG_DIR);
    
    // Only process log files
    const logFiles = files.filter(file => file.endsWith('.log'));
    // Sort by date (newest first)
    logFiles.sort().reverse();
    
    // Process log files until we reach the max events
    let eventsLoaded = 0;
    for (const file of logFiles) {
      if (eventsLoaded >= maxEvents) break;
      
      const filePath = path.join(LOG_DIR, file);
      const content = await fs.readFile(filePath, 'utf8');
      
      // Process each line (each line is a JSON event)
      const lines = content.split('\n').filter(line => line.trim());
      for (const line of lines) {
        if (eventsLoaded >= maxEvents) break;
        
        try {
          const event = JSON.parse(line);
          eventCache.push(event);
          eventsLoaded++;
        } catch (error) {
          // Skip invalid JSON
          console.error(`Invalid event log entry: ${line}`);
        }
      }
    }
    
    // Sort events by timestamp (newest first)
    eventCache.sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    
    console.log(`Loaded ${eventsLoaded} events from logs`);
  } catch (error) {
    console.error('Error loading event logs:', error);
  }
}

// Log an event to the monitoring system
export async function logEvent(
  type: string,
  details: Record<string, any>
): Promise<void> {
  const timestamp = new Date().toISOString();
  const event: MonitoringEvent = {
    timestamp,
    type,
    details
  };
  
  // Add to in-memory cache
  eventCache.unshift(event);
  
  // Write to log file
  const today = timestamp.split('T')[0];
  const logFile = path.join(LOG_DIR, `operations-${today}.log`);
  
  await fs.appendFile(
    logFile,
    JSON.stringify(event) + '\n',
    'utf8'
  );
}

// HTTP request handler
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '/';
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  
  // Only allow GET requests
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  
  try {
    if (url === '/' || url === '/index.html') {
      // Serve main dashboard HTML
      res.setHeader('Content-Type', 'text/html');
      res.end(await generateDashboardHtml());
    } else if (url === '/api/events') {
      // Return events as JSON
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ events: eventCache.slice(0, 100) }));
    } else if (url === '/api/stats') {
      // Return system stats
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await getSystemStats()));
    } else if (url === '/api/permissions') {
      // Return directory permissions
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        permissions: await getAllDirectoryPermissions(),
        permissionNames: PermissionNames
      }));
    } else {
      // 404 Not Found for any other path
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    // 500 Internal Server Error for any exceptions
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}

// Start the monitoring dashboard server
export async function startDashboardServer(port: number = DEFAULT_PORT): Promise<void> {
  if (isServerRunning) {
    console.log(`Dashboard server already running on port ${port}`);
    return;
  }
  
  dashboardServer = http.createServer(handleRequest);
  
  return new Promise((resolve, reject) => {
    dashboardServer!.listen(port, () => {
      console.log(`Dashboard server started on http://localhost:${port}`);
      isServerRunning = true;
      resolve();
    });
    
    dashboardServer!.on('error', (error) => {
      console.error(`Failed to start dashboard server: ${error.message}`);
      reject(error);
    });
  });
}

// Stop the monitoring dashboard server
export async function stopDashboardServer(): Promise<void> {
  if (!isServerRunning || !dashboardServer) {
    console.log('Dashboard server not running');
    return;
  }
  
  return new Promise((resolve) => {
    dashboardServer!.close(() => {
      console.log('Dashboard server stopped');
      isServerRunning = false;
      dashboardServer = null;
      resolve();
    });
  });
}

// Get server status
export function getDashboardStatus(): { running: boolean; port?: number } {
  if (isServerRunning && dashboardServer) {
    const address = dashboardServer.address();
    const port = typeof address === 'object' && address ? address.port : undefined;
    return { running: true, port };
  }
  return { running: false };
}

// Get system stats for the dashboard
async function getSystemStats(): Promise<Record<string, any>> {
  // Collect various system statistics
  const backupStats = await getBackupStats();
  
  return {
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: os.uptime(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        usage: 1 - (os.freemem() / os.totalmem())
      },
      cpus: os.cpus().length
    },
    events: {
      total: eventCache.length,
      byType: countEventsByType()
    },
    backups: backupStats
  };
}

// Count events by type
function countEventsByType(): Record<string, number> {
  const counts: Record<string, number> = {};
  
  for (const event of eventCache) {
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  
  return counts;
}

// Generate HTML for the dashboard
async function generateDashboardHtml(): Promise<string> {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Desktop Commander Dashboard</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f5f5f7;
      color: #333;
    }
    header {
      background-color: #221627;
      color: white;
      padding: 1rem;
      text-align: center;
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 1rem;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background-color: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      padding: 1.5rem;
      transition: all 0.3s ease;
    }
    .card:hover {
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      transform: translateY(-2px);
    }
    .card h2 {
      margin-top: 0;
      color: #221627;
      border-bottom: 2px solid #f0f0f0;
      padding-bottom: 0.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    table th, table td {
      padding: 0.5rem;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    .event-type {
      font-weight: bold;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      background-color: #e0e0e0;
    }
    .event-time {
      color: #666;
      font-size: 0.9rem;
    }
    .permission-level-0 { background-color: #ff000020; }
    .permission-level-1 { background-color: #ffaa0020; }
    .permission-level-2 { background-color: #aaff0020; }
    .permission-level-3 { background-color: #00aaff20; }
    .permission-level-4 { background-color: #aa00ff20; }
    .refresh-button {
      background-color: #221627;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .refresh-button:hover {
      background-color: #3a1f45;
    }
    #event-list {
      max-height: 400px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <header>
    <h1>Claude Desktop Commander Dashboard</h1>
  </header>
  <main>
    <button id="refresh-btn" class="refresh-button">Refresh Data</button>
    
    <div class="dashboard-grid">
      <div class="card" id="system-info">
        <h2>System Information</h2>
        <div id="system-content">Loading...</div>
      </div>
      
      <div class="card" id="backup-stats">
        <h2>Backup Statistics</h2>
        <div id="backup-content">Loading...</div>
      </div>
    </div>
    
    <div class="card">
      <h2>Directory Permissions</h2>
      <div id="permissions-table">Loading...</div>
    </div>
    
    <div class="card">
      <h2>Recent Events</h2>
      <div id="event-list">Loading...</div>
    </div>
  </main>
  
  <script>
    // Fetch data from API
    async function fetchData() {
      try {
        const [eventsResponse, statsResponse, permissionsResponse] = await Promise.all([
          fetch('/api/events'),
          fetch('/api/stats'),
          fetch('/api/permissions')
        ]);
        
        const events = await eventsResponse.json();
        const stats = await statsResponse.json();
        const permissions = await permissionsResponse.json();
        
        updateSystemInfo(stats);
        updateBackupStats(stats.backups);
        updatePermissionsList(permissions);
        updateEventsList(events.events);
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    }
    
    // Update system information section
    function updateSystemInfo(stats) {
      const system = stats.system;
      const memoryUsage = Math.round(system.memory.usage * 100);
      
      document.getElementById('system-content').innerHTML = \`
        <table>
          <tr><th>Hostname:</th><td>\${system.hostname}</td></tr>
          <tr><th>Platform:</th><td>\${system.platform} (\${system.arch})</td></tr>
          <tr><th>OS Version:</th><td>\${system.release}</td></tr>
          <tr><th>Memory:</th><td>\${formatBytes(system.memory.free)} free of \${formatBytes(system.memory.total)} (\${memoryUsage}% used)</td></tr>
          <tr><th>CPUs:</th><td>\${system.cpus} cores</td></tr>
          <tr><th>Uptime:</th><td>\${formatUptime(system.uptime)}</td></tr>
        </table>
      \`;
    }
    
    // Update backup statistics section
    function updateBackupStats(backupStats) {
      document.getElementById('backup-content').innerHTML = \`
        <table>
          <tr><th>Files Tracked:</th><td>\${backupStats.totalFiles}</td></tr>
          <tr><th>Total Versions:</th><td>\${backupStats.totalVersions}</td></tr>
          <tr><th>Storage Used:</th><td>\${formatBytes(backupStats.totalSize)}</td></tr>
          <tr><th>Oldest Backup:</th><td>\${formatDate(backupStats.oldestBackup)}</td></tr>
          <tr><th>Newest Backup:</th><td>\${formatDate(backupStats.newestBackup)}</td></tr>
        </table>
      \`;
    }
    
    // Update permissions list section
    function updatePermissionsList(permissions) {
      const permissionNames = permissions.permissionNames;
      
      let html = '<table><tr><th>Directory</th><th>Permission Level</th></tr>';
      
      for (const dirPerm of permissions.permissions) {
        html += \`<tr class="permission-level-\${dirPerm.level}">
          <td>\${dirPerm.path}</td>
          <td>\${permissionNames[dirPerm.level]}</td>
        </tr>\`;
      }
      
      html += '</table>';
      document.getElementById('permissions-table').innerHTML = html;
    }
    
    // Update events list section
    function updateEventsList(events) {
      let html = '<table><tr><th>Time</th><th>Event</th><th>Details</th></tr>';
      
      for (const event of events) {
        const details = Object.entries(event.details)
          .map(([key, value]) => \`<strong>\${key}:</strong> \${JSON.stringify(value)}\`)
          .join('<br>');
        
        html += \`<tr>
          <td class="event-time">\${formatDate(event.timestamp)}</td>
          <td><span class="event-type">\${event.type}</span></td>
          <td>\${details}</td>
        </tr>\`;
      }
      
      html += '</table>';
      document.getElementById('event-list').innerHTML = html;
    }
    
    // Format bytes to human-readable size
    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      
      return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    // Format timestamp to readable date
    function formatDate(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleString();
    }
    
    // Format uptime to readable duration
    function formatUptime(seconds) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      
      const parts = [];
      if (days > 0) parts.push(\`\${days} days\`);
      if (hours > 0) parts.push(\`\${hours} hours\`);
      if (minutes > 0) parts.push(\`\${minutes} minutes\`);
      
      return parts.join(', ') || 'Less than a minute';
    }
    
    // Initial data load
    fetchData();
    
    // Set up refresh button
    document.getElementById('refresh-btn').addEventListener('click', fetchData);
    
    // Auto-refresh every 60 seconds
    setInterval(fetchData, 60000);
  </script>
</body>
</html>
  `;
}
