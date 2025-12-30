# Deployment Guide

This guide covers deploying the Supabase MCP Server to production environments, including cloud platforms, Docker containers, and on-premises servers.

## 🚀 Deployment Options

### Cloud Platforms

- **Railway** - Recommended for simplicity
- **Vercel** - Good for serverless deployment
- **Heroku** - Traditional PaaS option
- **DigitalOcean** - VPS deployment
- **AWS/GCP/Azure** - Enterprise cloud deployment

### Containerization

- **Docker** - Single container deployment
- **Docker Compose** - Multi-service deployment
- **Kubernetes** - Orchestrated deployment

### On-Premises

- **Linux Server** - Direct deployment
- **VM/Container** - Isolated deployment

## 🏭 Production Checklist

### Prerequisites

- [x] Supabase production project configured
- [x] Domain name and SSL certificates
- [x] Environment variables secured
- [x] Database migrations applied
- [x] Monitoring setup planned

### Security Requirements

- [x] HTTPS enabled
- [x] Environment variables secured
- [x] Database access restricted
- [x] Rate limiting configured
- [x] CORS origins restricted

## ☁️ Cloud Deployment

### Railway Deployment (Recommended)

Railway provides simple Node.js deployment with automatic builds.

#### 1. Prepare Repository

```bash
# Ensure package.json has correct start script
npm run build  # If you have a build step

# Create railway.json for configuration
cat > railway.json << EOF
{
  "name": "supabase-mcp-server",
  "plan": "hobby",
  "region": "us-west1",
  "variables": {
    "NODE_ENV": "production",
    "PORT": "3007"
  }
}
EOF
```

#### 2. Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway link  # Link to existing project or create new

# Set environment variables
railway variables set SUPABASE_URL=https://your-project.supabase.co
railway variables set SUPABASE_PUBLISHABLE_KEY=your_publishable_key
railway variables set SUPABASE_SECRET_KEY=your_secret_key
railway variables set NODE_ENV=production
railway variables set MCP_SERVER_PORT=3007
railway variables set CORS_ORIGINS='["https://yourdomain.com"]'

# Deploy
railway up
```

#### 3. Configure Custom Domain

```bash
# Add custom domain in Railway dashboard
# Configure DNS CNAME record pointing to railway domain
# Enable SSL (automatic with Railway)
```

### Vercel Deployment

Vercel is ideal for serverless deployment with automatic scaling.

#### 1. Configure Vercel

Create `vercel.json`:

```json
{
  "name": "supabase-mcp-server",
  "version": 2,
  "builds": [
    {
      "src": "src/server/mcp-server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "src/server/mcp-server.js"
    }
  ],
  "env": {
    "NODE_ENV": "production"
  },
  "functions": {
    "src/server/mcp-server.js": {
      "maxDuration": 30
    }
  }
}
```

#### 2. Deploy

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Set environment variables
vercel env add SUPABASE_URL production
vercel env add SUPABASE_PUBLISHABLE_KEY production
vercel env add SUPABASE_SECRET_KEY production

# Deploy with environment
vercel --prod
```

### DigitalOcean Droplet

Traditional VPS deployment for full control.

#### 1. Create Droplet

```bash
# Create Ubuntu 22.04 droplet (2GB RAM minimum)
# Configure SSH keys
# Set up firewall (ports 22, 80, 443, 3007)
```

#### 2. Server Setup

```bash
# SSH into droplet
ssh root@your-droplet-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Install PM2 for process management
npm install -g pm2

# Install Nginx for reverse proxy
apt-get install -y nginx

# Install SSL certificates (Let's Encrypt)
apt-get install -y certbot python3-certbot-nginx
```

#### 3. Application Deployment

```bash
# Clone repository
git clone <your-repo-url> /opt/supabase-mcp
cd /opt/supabase-mcp

# Install dependencies
npm install

# Create environment file
cat > .env << EOF
NODE_ENV=production
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SECRET_KEY=your_secret_key
MCP_SERVER_PORT=3007
MCP_SERVER_HOST=0.0.0.0
CORS_ORIGINS='["https://yourdomain.com"]'
EOF

# Start with PM2
pm2 start src/server/mcp-server.js --name "mcp-server"
pm2 save
pm2 startup
```

#### 4. Nginx Configuration

```bash
# Create Nginx config
cat > /etc/nginx/sites-available/mcp-server << EOF
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3007;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
    }
}
EOF

# Enable site
ln -s /etc/nginx/sites-available/mcp-server /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx

# Setup SSL
certbot --nginx -d yourdomain.com
```

## 🐳 Docker Deployment

### Single Container

#### 1. Create Dockerfile

```dockerfile
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S mcp -u 1001

# Change ownership
RUN chown -R mcp:nodejs /usr/src/app
USER mcp

# Expose port
EXPOSE 3007

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3007/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start application
CMD ["node", "src/server/mcp-server.js"]
```

#### 2. Build and Run

```bash
# Build image
docker build -t supabase-mcp-server .

# Run container
docker run -d \
  --name mcp-server \
  -p 3007:3007 \
  --env-file .env \
  --restart unless-stopped \
  supabase-mcp-server
```

### Docker Compose

#### 1. Create docker-compose.yml

```yaml
version: '3.8'

services:
  mcp-server:
    build: .
    ports:
      - "3007:3007"
    environment:
      - NODE_ENV=production
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY}
      - SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY}
      - MCP_SERVER_PORT=3007
      - MCP_SERVER_HOST=0.0.0.0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3007/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - mcp-network

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - mcp-server
    restart: unless-stopped
    networks:
      - mcp-network

networks:
  mcp-network:
    driver: bridge
```

#### 2. Deploy

```bash
# Deploy with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f mcp-server

# Update deployment
docker-compose pull && docker-compose up -d
```

## 🔧 Environment Configuration

### Production Environment Variables

Create `.env.production`:

```env
# Required
NODE_ENV=production
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key_here
SUPABASE_SECRET_KEY=sb_secret_your_key_here

# Server Configuration
MCP_SERVER_PORT=3007
MCP_SERVER_HOST=0.0.0.0

# Security
CORS_ORIGINS='["https://yourdomain.com","https://www.yourdomain.com"]'

# Optional
DEBUG_MODE=false
ENABLE_HTTPS=true

# Monitoring (if using)
SENTRY_DSN=https://your-sentry-dsn
LOG_LEVEL=info
```

### Secrets Management

#### Using Railway

```bash
railway variables set SUPABASE_SECRET_KEY="sb_secret_your_secret_key"
```

#### Using Docker Secrets

```yaml
# docker-compose.yml
version: '3.8'

services:
  mcp-server:
    # ... other config
    secrets:
      - supabase_secret_key
    environment:
      - SUPABASE_SECRET_KEY_FILE=/run/secrets/supabase_secret_key

secrets:
  supabase_secret_key:
    external: true
```

#### Using Kubernetes Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-secrets
type: Opaque
data:
  supabase-secret-key: <base64-encoded-key>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  template:
    spec:
      containers:
      - name: mcp-server
        env:
        - name: SUPABASE_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: mcp-secrets
              key: supabase-secret-key
```

## 📊 Monitoring & Logging

### Health Monitoring

#### 1. Health Check Endpoint

Set up monitoring for `/health` endpoint:

```bash
# Simple health check script
#!/bin/bash
HEALTH_URL="https://yourdomain.com/health"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL)

if [ $RESPONSE -eq 200 ]; then
  echo "Service is healthy"
  exit 0
else
  echo "Service is unhealthy (HTTP $RESPONSE)"
  exit 1
fi
```

#### 2. Uptime Monitoring

Popular services:
- **Uptime Robot** - Free tier available
- **Pingdom** - Comprehensive monitoring
- **StatusCake** - Multiple check types

### Application Monitoring

#### 1. Sentry Integration

```javascript
// Add to src/server/mcp-server.js
import * as Sentry from "@sentry/node";

if (process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
  });
}
```

#### 2. Log Aggregation

For production logging:

```javascript
// Enhanced logging configuration
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: 'logs/app.log',
      maxsize: 10000000, // 10MB
      maxFiles: 5
    })
  ]
});
```

### Infrastructure Monitoring

#### Docker Monitoring

```yaml
# Add to docker-compose.yml
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

## 🔄 CI/CD Pipeline

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Production

on:
  push:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-node@v3
      with:
        node-version: 18
        cache: 'npm'
    
    - run: npm ci
    - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Deploy to Railway
      uses: railway/cli-action@v1
      with:
        command: up
      env:
        RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}

    - name: Health Check
      run: |
        sleep 30
        curl -f https://yourdomain.com/health
```

### Manual Deployment

```bash
#!/bin/bash
# deploy.sh - Production deployment script

set -e

echo "🚀 Starting deployment..."

# Backup current version
PM2_APP_NAME="mcp-server"
pm2 dump

# Pull latest code
git pull origin main

# Install dependencies
npm ci --production

# Run database migrations if any
# npm run migrate

# Restart application
pm2 restart $PM2_APP_NAME

# Wait for health check
sleep 10
curl -f http://localhost:3007/health

echo "✅ Deployment completed successfully"
```

## 🔐 Security Hardening

### Server Security

```bash
# Firewall configuration
ufw allow ssh
ufw allow 80
ufw allow 443
ufw --force enable

# Fail2ban for SSH protection
apt-get install -y fail2ban

# Automatic security updates
apt-get install -y unattended-upgrades
dpkg-reconfigure unattended-upgrades
```

### Application Security

#### 1. Rate Limiting

```javascript
// Enhanced rate limiting
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);
```

#### 2. Security Headers

```javascript
import helmet from 'helmet';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));
```

## 📈 Performance Optimization

### Server Optimization

```javascript
// Add to production server
import compression from 'compression';

// Enable gzip compression
app.use(compression());

// Connection pooling for Supabase
const supabase = createClient(url, key, {
  auth: {
    persistSession: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});
```

### Database Optimization

```sql
-- Add indexes for performance
CREATE INDEX CONCURRENTLY idx_mcp_agents_user_status 
ON mcp_agents(user_id, status) 
WHERE status = 'online';

CREATE INDEX CONCURRENTLY idx_mcp_remote_calls_timeout 
ON mcp_remote_calls(timeout_at) 
WHERE status IN ('pending', 'executing');
```

## 🚨 Troubleshooting

### Common Deployment Issues

#### Port Binding Issues

```bash
# Check port usage
netstat -tulpn | grep :3007
lsof -i :3007

# Kill process if needed
kill -9 $(lsof -t -i :3007)
```

#### Memory Issues

```bash
# Monitor memory usage
free -h
ps aux --sort=-%mem | head

# PM2 memory monitoring
pm2 monit
```

#### SSL Certificate Issues

```bash
# Check certificate expiry
openssl x509 -in /etc/letsencrypt/live/yourdomain.com/fullchain.pem -text -noout

# Renew certificates
certbot renew --dry-run
certbot renew
```

### Log Analysis

```bash
# Application logs
pm2 logs mcp-server

# System logs
journalctl -u nginx
journalctl -f

# Access logs
tail -f /var/log/nginx/access.log
```

## 📋 Maintenance

### Regular Tasks

```bash
#!/bin/bash
# maintenance.sh - Run weekly

# Update system packages
apt update && apt upgrade -y

# Clean up old logs
find /var/log -type f -name "*.log" -mtime +7 -delete

# Backup database (if using local DB)
# pg_dump production_db > backup_$(date +%Y%m%d).sql

# Check disk space
df -h

# Check service health
systemctl status nginx
pm2 status

# Update SSL certificates
certbot renew

echo "Maintenance completed"
```

### Backup Strategy

```bash
# Environment backup
cp .env .env.backup.$(date +%Y%m%d)

# Application backup
tar -czf app_backup_$(date +%Y%m%d).tar.gz \
  /opt/supabase-mcp \
  --exclude=node_modules \
  --exclude=.git
```

This deployment guide provides comprehensive coverage for production deployment across various platforms and scenarios.