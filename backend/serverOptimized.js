const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const cron = require('node-cron');
const path = require('path');

// Load environment variables from parent directory
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

console.log('Optimized AWS EC2 Monitor Backend starting...');
console.log('Environment variables loaded:');
console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'SET' : 'NOT SET');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET');

// Import optimized services
const awsService = require('./services/awsServiceMultiRegion');
const pingService = require('./services/pingService');
const metricsService = require('./services/metricsService');
const portScanService = require('./services/portScanService');
const notificationService = require('./services/notificationService');
const authService = require('./services/authService');

// Import routes
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Authentication routes
app.use('/api/auth', authRoutes);

let connectedClients = new Set();
let monitoringData = {
  instances: [],
  pingResults: {},
  systemMetrics: {},
  openPorts: {},
  stats: {
    totalInstances: 0,
    runningInstances: 0,
    stoppedInstances: 0,
    highCpuInstances: 0,
    highMemoryInstances: 0,
    offlineInstances: 0,
    lastUpdate: null
  }
};

// WebSocket connection handling
wss.on('connection', (ws) => {
  connectedClients.add(ws);
  
  ws.send(JSON.stringify({
    type: 'initial_data',
    data: monitoringData
  }));

  ws.on('close', () => {
    connectedClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    connectedClients.delete(ws);
  });
});

function broadcastToClients(data) {
  const message = JSON.stringify(data);
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        connectedClients.delete(client);
      }
    }
  });
}

// Enhanced API endpoints

// Get instances with pagination, sorting, and search (multi-region)
app.get('/api/instances', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 20,
      sortBy = 'name',
      sortOrder = 'asc',
      search = '',
      includeMetrics = 'false',
      region = 'all'
    } = req.query;

    console.log(`Fetching instances - Page: ${page}, Size: ${pageSize}, Sort: ${sortBy} ${sortOrder}, Search: "${search}", Region: ${region}`);

    // Get all instances from all regions
    let allInstances = await awsService.getEC2Instances();
    
    // Filter by region if specified
    if (region !== 'all') {
      allInstances = allInstances.filter(instance => instance.Region === region);
    }
    
    // Filter by search term
    let filteredInstances = allInstances;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredInstances = allInstances.filter(instance => 
        (instance.Name && instance.Name.toLowerCase().includes(searchLower)) ||
        instance.InstanceId.toLowerCase().includes(searchLower) ||
        instance.InstanceType.toLowerCase().includes(searchLower) ||
        (instance.PublicIpAddress && instance.PublicIpAddress.includes(searchLower)) ||
        (instance.PrivateIpAddress && instance.PrivateIpAddress.includes(searchLower)) ||
        (instance.Region && instance.Region.toLowerCase().includes(searchLower))
      );
    }
    
    // Sort instances
    filteredInstances.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'name':
          aValue = a.Name || a.InstanceId;
          bValue = b.Name || b.InstanceId;
          break;
        case 'region':
          aValue = a.Region;
          bValue = b.Region;
          break;
        case 'state':
          aValue = a.State.Name;
          bValue = b.State.Name;
          break;
        case 'type':
          aValue = a.InstanceType;
          bValue = b.InstanceType;
          break;
        case 'launchTime':
          aValue = new Date(a.LaunchTime);
          bValue = new Date(b.LaunchTime);
          break;
        default:
          aValue = a.Name || a.InstanceId;
          bValue = b.Name || b.InstanceId;
      }

      if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    
    // Paginate
    const startIndex = (parseInt(page) - 1) * parseInt(pageSize);
    const endIndex = startIndex + parseInt(pageSize);
    const paginatedInstances = filteredInstances.slice(startIndex, endIndex);
    
    const result = {
      instances: paginatedInstances,
      pagination: {
        currentPage: parseInt(page),
        pageSize: parseInt(pageSize),
        totalItems: filteredInstances.length,
        totalPages: Math.ceil(filteredInstances.length / parseInt(pageSize)),
        hasNextPage: endIndex < filteredInstances.length,
        hasPreviousPage: parseInt(page) > 1
      }
    };

    // Optionally include metrics for sorting by resource usage
    if (includeMetrics === 'true') {
      for (const instance of result.instances) {
        const metrics = monitoringData.systemMetrics[instance.InstanceId];
        if (metrics) {
          instance.currentCpu = parseFloat(metrics.cpu?.current || 0);
          instance.currentMemory = parseFloat(metrics.memory?.current || 0);
        }
      }

      // Re-sort by resource usage if requested
      if (sortBy === 'cpu' || sortBy === 'memory') {
        result.instances.sort((a, b) => {
          const aValue = sortBy === 'cpu' ? (a.currentCpu || 0) : (a.currentMemory || 0);
          const bValue = sortBy === 'cpu' ? (b.currentCpu || 0) : (b.currentMemory || 0);
          return sortOrder === 'desc' ? bValue - aValue : aValue - bValue;
        });
      }
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error fetching paginated instances:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// Enhanced dashboard endpoint with sorting by resource usage
app.get('/api/dashboard', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const { sortBy = 'usage', limit = 50 } = req.query;
    
    // Get instances with current metrics for sorting
    const instances = monitoringData.instances.slice(0, parseInt(limit));
    
    // Enrich instances with current metrics for sorting
    const enrichedInstances = instances.map(instance => {
      const metrics = monitoringData.systemMetrics[instance.InstanceId];
      const pingResult = monitoringData.pingResults[instance.InstanceId];
      
      return {
        ...instance,
        currentCpu: parseFloat(metrics?.cpu?.current || 0),
        currentMemory: parseFloat(metrics?.memory?.current || 0),
        isOnline: pingResult?.alive || false,
        hasHighCpu: parseFloat(metrics?.cpu?.current || 0) > 80,
        hasHighMemory: parseFloat(metrics?.memory?.current || 0) > 80,
        usageScore: (parseFloat(metrics?.cpu?.current || 0) + parseFloat(metrics?.memory?.current || 0)) / 2
      };
    });

    // Sort instances by usage (high usage first)
    if (sortBy === 'usage') {
      enrichedInstances.sort((a, b) => {
        // Prioritize high usage instances
        if (a.hasHighCpu || a.hasHighMemory) {
          if (!(b.hasHighCpu || b.hasHighMemory)) return -1;
          return b.usageScore - a.usageScore;
        }
        if (b.hasHighCpu || b.hasHighMemory) return 1;
        return b.usageScore - a.usageScore;
      });
    }

    const dashboardData = {
      ...monitoringData,
      instances: enrichedInstances,
      sortedByUsage: sortBy === 'usage'
    };

    res.json(dashboardData);
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search endpoint (multi-region)
app.get('/api/search', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const { q, type = 'all', region = 'all' } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    const searchResults = [];
    const searchLower = q.toLowerCase();

    // Search instances
    if (type === 'all' || type === 'instances') {
      let searchInstances = monitoringData.instances;
      
      // Filter by region if specified
      if (region !== 'all') {
        searchInstances = searchInstances.filter(instance => instance.Region === region);
      }
      
      const matchingInstances = searchInstances.filter(instance => {
        const instanceName = instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId;
        return instanceName.toLowerCase().includes(searchLower) ||
               instance.InstanceId.toLowerCase().includes(searchLower) ||
               instance.InstanceType.toLowerCase().includes(searchLower) ||
               (instance.PublicIpAddress && instance.PublicIpAddress.includes(searchLower)) ||
               (instance.PrivateIpAddress && instance.PrivateIpAddress.includes(searchLower)) ||
               (instance.Region && instance.Region.toLowerCase().includes(searchLower)) ||
               (instance.RegionName && instance.RegionName.toLowerCase().includes(searchLower));
      });

      matchingInstances.forEach(instance => {
        const instanceName = instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId;
        const metrics = monitoringData.systemMetrics[instance.InstanceId];
        
        searchResults.push({
          type: 'instance',
          id: instance.InstanceId,
          name: instanceName,
          details: `${instance.InstanceType} - ${instance.State.Name} (${instance.RegionName || instance.Region})`,
          region: instance.Region,
          regionName: instance.RegionName,
          metrics: metrics ? {
            cpu: metrics.cpu?.current,
            memory: metrics.memory?.current
          } : null,
          isOnline: monitoringData.pingResults[instance.InstanceId]?.alive
        });
      });
    }

    res.json({ 
      results: searchResults,
      regionStats: awsService.getRegionStats()
    });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ error: error.message });
  }
});

// Regions endpoint
app.get('/api/regions', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const regionStats = awsService.getRegionStats();
    res.json(regionStats);
  } catch (error) {
    console.error('Error fetching regions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Refresh regions endpoint
app.post('/api/regions/refresh', authService.authenticateToken.bind(authService), authService.requirePermission('write'), async (req, res) => {
  try {
    const activeRegions = await awsService.refreshActiveRegions();
    res.json({ 
      success: true, 
      activeRegions,
      message: `Detected ${activeRegions.length} active regions`
    });
  } catch (error) {
    console.error('Error refreshing regions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Notification configuration endpoints
app.get('/api/notifications/config', authService.authenticateToken.bind(authService), (req, res) => {
  res.json(notificationService.getConfig());
});

app.post('/api/notifications/config', authService.authenticateToken.bind(authService), authService.requirePermission('manage_notifications'), (req, res) => {
  try {
    notificationService.updateConfig(req.body);
    res.json({ success: true, message: 'Configuration updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notifications/test', authService.authenticateToken.bind(authService), authService.requirePermission('manage_notifications'), async (req, res) => {
  try {
    const testAlert = {
      instanceId: 'test-instance',
      instanceName: 'Test Instance',
      type: 'test',
      severity: 'medium',
      title: 'Test Notification',
      message: 'This is a test notification from AWS EC2 Monitor',
      timestamp: new Date(),
      metrics: { cpu: 75, memory: 60 }
    };

    const results = await notificationService.sendAlert(testAlert);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cache management endpoints
app.post('/api/cache/clear', authService.authenticateToken.bind(authService), authService.requirePermission('admin'), (req, res) => {
  try {
    awsService.clearCache();
    res.json({ success: true, message: 'Cache cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cache/stats', authService.authenticateToken.bind(authService), authService.requirePermission('admin'), (req, res) => {
  try {
    const stats = awsService.getCacheStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoints for backward compatibility
app.get('/api/ping/:instanceId', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = monitoringData.instances.find(i => i.InstanceId === instanceId);
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    const pingResult = await pingService.pingInstance(instance.PublicIpAddress || instance.PrivateIpAddress);
    res.json(pingResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/metrics/:instanceId', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { refresh = 'false' } = req.query;
    
    // Force call metricsService directly to test
    console.log(`=== METRICS API CALLED for ${instanceId}, refresh=${refresh} ===`);
    
    // Always call the metrics service to debug
    const instance = monitoringData.instances.find(i => i.InstanceId === instanceId);
    if (!instance) {
      console.log(`Instance ${instanceId} not found in monitoringData`);
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    console.log(`Calling metricsService.getSystemMetrics for ${instanceId}`);
    const rawMetrics = await metricsService.getSystemMetrics(instanceId);
    console.log(`Raw metrics keys:`, Object.keys(rawMetrics || {}));
    console.log(`Raw metrics:`, JSON.stringify(rawMetrics, null, 2));
    
    const enrichedMetrics = {
      ...rawMetrics,
      timestamp: new Date(),
      instanceName: instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instanceId,
      region: instance.Region
    };
    
    console.log(`Final enriched metrics keys:`, Object.keys(enrichedMetrics));
    
    // Update cache
    monitoringData.systemMetrics[instanceId] = enrichedMetrics;
    
    res.json(enrichedMetrics);
  } catch (error) {
    console.error(`ERROR in metrics API for ${req.params.instanceId}:`, error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/api/ports/:instanceId', authService.authenticateToken.bind(authService), async (req, res) => {
  try {
    const { instanceId } = req.params;
    const ports = monitoringData.openPorts[instanceId] || [];
    res.json(ports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enhanced monitoring functions with notifications

async function updateInstances() {
  try {
    console.log('Updating instances...');
    const instances = await awsService.getEC2Instances();
    monitoringData.instances = instances;
    
    // Update stats
    monitoringData.stats.totalInstances = instances.length;
    monitoringData.stats.runningInstances = instances.filter(i => i.State.Name === 'running').length;
    monitoringData.stats.stoppedInstances = instances.filter(i => i.State.Name === 'stopped').length;
    monitoringData.stats.lastUpdate = new Date();
    
    broadcastToClients({
      type: 'instances_update',
      data: {
        success: true,
        count: instances.length,
        instances: instances,
        stats: monitoringData.stats
      }
    });
    
    console.log(`Updated ${instances.length} instances`);
  } catch (error) {
    console.error('Error updating instances:', error);
    broadcastToClients({
      type: 'instances_update',
      data: {
        success: false,
        error: error.message,
        instances: []
      }
    });
  }
}

async function runPingChecks() {
  try {
    const batchSize = 20;
    const runningInstances = monitoringData.instances.filter(i => i.State.Name === 'running');
    
    for (let i = 0; i < runningInstances.length; i += batchSize) {
      const batch = runningInstances.slice(i, i + batchSize);
      
      const pingPromises = batch.map(async (instance) => {
        const ip = instance.PublicIpAddress || instance.PrivateIpAddress;
        if (ip) {
          try {
            const result = await pingService.pingInstance(ip);
            const instanceName = instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId;
            
            monitoringData.pingResults[instance.InstanceId] = {
              ...result,
              timestamp: new Date(),
              instanceName
            };

            // Send notification if instance went offline
            if (!result.alive) {
              const alert = notificationService.createInstanceDownAlert(instance.InstanceId, instanceName);
              await notificationService.sendAlert(alert);
            }
          } catch (error) {
            console.error(`Error pinging ${instance.InstanceId}:`, error.message);
          }
        }
      });
      
      await Promise.all(pingPromises);
    }
    
    // Update offline count
    const offlineCount = Object.values(monitoringData.pingResults)
      .filter(result => !result.alive).length;
    monitoringData.stats.offlineInstances = offlineCount;
    
    broadcastToClients({
      type: 'ping_update',
      data: monitoringData.pingResults
    });
  } catch (error) {
    console.error('Error running ping checks:', error);
  }
}

async function collectSystemMetrics() {
  try {
    const batchSize = 8; // Smaller batch for multi-region
    const runningInstances = monitoringData.instances.filter(i => i.State.Name === 'running');
    
    let highCpuCount = 0;
    let highMemoryCount = 0;
    
    for (let i = 0; i < runningInstances.length; i += batchSize) {
      const batch = runningInstances.slice(i, i + batchSize);
      
      const metricsPromises = batch.map(async (instance) => {
        try {
          // Use comprehensive metrics service for all instances
          const metrics = await metricsService.getSystemMetrics(instance.InstanceId);
          
          const instanceName = instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId;
          
          monitoringData.systemMetrics[instance.InstanceId] = {
            ...metrics,
            timestamp: new Date(),
            instanceName,
            region: instance.Region
          };

          // Check for high resource usage and send alerts
          const cpuUsage = parseFloat(metrics.cpu?.current || 0);
          const memoryUsage = parseFloat(metrics.memory?.current || 0);

          if (cpuUsage > 80) {
            highCpuCount++;
            const alert = notificationService.createHighCPUAlert(instance.InstanceId, instanceName, cpuUsage);
            await notificationService.sendAlert(alert);
          }

          if (memoryUsage > 80) {
            highMemoryCount++;
            const alert = notificationService.createHighMemoryAlert(instance.InstanceId, instanceName, memoryUsage);
            await notificationService.sendAlert(alert);
          }
        } catch (error) {
          console.error(`Error collecting metrics for ${instance.InstanceId}:`, error.message);
        }
      });
      
      await Promise.all(metricsPromises);
    }
    
    // Update stats
    monitoringData.stats.highCpuInstances = highCpuCount;
    monitoringData.stats.highMemoryInstances = highMemoryCount;
    
    broadcastToClients({
      type: 'metrics_update',
      data: monitoringData.systemMetrics
    });
  } catch (error) {
    console.error('Error collecting system metrics:', error);
  }
}

async function scanPorts() {
  try {
    const batchSize = 5; // Smaller batch for port scanning as it's resource intensive
    const runningInstances = monitoringData.instances.filter(i => i.State.Name === 'running');
    
    for (let i = 0; i < runningInstances.length; i += batchSize) {
      const batch = runningInstances.slice(i, i + batchSize);
      
      const portScanPromises = batch.map(async (instance) => {
        const ip = instance.PublicIpAddress || instance.PrivateIpAddress;
        if (ip) {
          try {
            const openPorts = await portScanService.scanCommonPorts(ip);
            const instanceName = instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId;
            
            monitoringData.openPorts[instance.InstanceId] = {
              ports: openPorts,
              timestamp: new Date(),
              instanceName,
              ipAddress: ip
            };

            // Check for high-risk ports
            if (openPorts.openPorts) {
              const highRiskPorts = openPorts.openPorts
                .filter(port => [21, 23, 135, 139, 445, 1433, 3389].includes(port.port))
                .map(port => port.port);
              
              if (highRiskPorts.length > 0) {
                const alert = notificationService.createSecurityAlert(instance.InstanceId, instanceName, highRiskPorts);
                await notificationService.sendAlert(alert);
              }
            }
          } catch (error) {
            console.error(`Error scanning ports for ${instance.InstanceId}:`, error.message);
          }
        }
      });
      
      await Promise.all(portScanPromises);
    }
    
    broadcastToClients({
      type: 'ports_update',
      data: monitoringData.openPorts
    });
  } catch (error) {
    console.error('Error scanning ports:', error);
  }
}

// Optimized cron schedules for high-scale monitoring
cron.schedule('*/30 * * * * *', runPingChecks); // Every 30 seconds
cron.schedule('*/2 * * * *', collectSystemMetrics); // Every 2 minutes
cron.schedule('*/10 * * * *', scanPorts); // Every 10 minutes
cron.schedule('*/5 * * * *', updateInstances); // Every 5 minutes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    connectedClients: connectedClients.size,
    stats: monitoringData.stats
  });
});

server.listen(PORT, () => {
  console.log(`Multi-Region AWS EC2 Monitor Backend running on port ${PORT}`);
  console.log(`Connected WebSocket clients will receive real-time updates`);
  console.log(`Maximum instances supported: ${process.env.MAX_INSTANCES || 500}`);
  console.log(`Auto-detecting regions with EC2 instances...`);
  
  // Initial data loading with region detection
  setTimeout(async () => {
    console.log('Starting initial data collection...');
    await updateInstances();
    console.log('Initial instance data loaded');
  }, 1000);
  
  setTimeout(runPingChecks, 15000);
  setTimeout(collectSystemMetrics, 25000);
  setTimeout(scanPorts, 35000);
});