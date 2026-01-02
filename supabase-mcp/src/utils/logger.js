import dotenv from 'dotenv';

dotenv.config();

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

class Logger {
  constructor(module = 'app') {
    this.module = module;
    this.level = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.info;
  }

  _log(level, message, data = null, error = null) {
    if (LOG_LEVELS[level] > this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const emoji = this._getEmoji(level);
    const prefix = `${emoji} [${timestamp}] [${this.module.toUpperCase()}]`;

    let output = `${prefix} ${message}`;

    if (data) {
      output += `\\n${JSON.stringify(data, null, 2)}`;
    }

    if (error) {
      output += `\\nError: ${error.message}`;
      if (DEBUG_MODE && error.stack) {
        output += `\\nStack: ${error.stack}`;
      }
    }

    console[level === 'error' || level === 'warn' ? level : 'log'](output);
  }

  _getEmoji(level) {
    const emojis = {
      error: '🔴',
      warn: '🟡',
      info: '🔵',
      debug: '🔍'
    };
    return emojis[level] || '📝';
  }

  error(message, data = null, error = null) {
    this._log('error', message, data, error);
  }

  warn(message, data = null) {
    this._log('warn', message, data);
  }

  info(message, data = null) {
    this._log('info', message, data);
  }

  debug(message, data = null) {
    this._log('debug', message, data);
  }

  // Request logging helper
  logRequest(req, action = 'INCOMING') {
    const { method, url, ip, headers } = req;
    const userAgent = headers['user-agent'] || 'unknown';

    // Filter sensitive headers
    const safeHeaders = { ...headers };
    if (safeHeaders.authorization) {
      safeHeaders.authorization = safeHeaders.authorization.startsWith('Bearer ')
        ? `Bearer ***${safeHeaders.authorization.slice(-8)}`
        : '***hidden***';
    }

    this.info(`${action} REQUEST`, {
      method,
      url,
      ip,
      userAgent,
      headers: DEBUG_MODE ? safeHeaders : undefined
    });
  }

  // Response logging helper  
  logResponse(req, res, duration = null) {
    const { method, url } = req;
    const { statusCode } = res;

    this.info('RESPONSE', {
      method,
      url,
      status: statusCode,
      duration: duration ? `${duration}ms` : undefined
    });
  }

  // SSE connection logging
  logSSEConnection(userId, action = 'CONNECT') {
    this.info(`SSE ${action}`, { userId });
  }

  // MCP message logging
  logMCPMessage(userId, method, messageId, direction = 'RECEIVED') {
    this.info(`MCP ${direction}`, {
      userId,
      method,
      messageId
    });
  }
}

// Create logger instances for different modules
export const createLogger = (module) => new Logger(module);

// Default loggers
export const serverLogger = new Logger('server');
export const authLogger = new Logger('auth');
export const sseLogger = new Logger('sse');
export const mcpLogger = new Logger('mcp');
export const webLogger = new Logger('web');
export const dispatchLogger = new Logger('dispatch');
export const agentLogger = new Logger('agent');