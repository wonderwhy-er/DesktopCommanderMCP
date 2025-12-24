import { Router, Response } from 'express';
import { DeviceModel } from '../database/models';
import { authenticateToken, generateDeviceToken, AuthenticatedRequest } from '../auth/middleware';

const router = Router();

// Get user's device
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const device = await DeviceModel.findByUserId(req.user!.id);

    if (!device) {
      return res.status(404).json({ error: 'No device registered' });
    }

    res.json({
      id: device.id,
      name: device.name,
      status: device.status,
      lastSeen: device.last_seen,
      createdAt: device.created_at
    });
  } catch (error) {
    console.error('Get device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register a device
router.post('/register', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body;
    const userId = req.user!.id;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Device name is required' });
    }

    // Check if user already has a device (MVP: only one device per user)
    const existingDevice = await DeviceModel.findByUserId(userId);
    if (existingDevice) {
      return res.status(400).json({
        error: 'Device already registered. Only one device per user is allowed in MVP.'
      });
    }

    // Create new device
    const device = await DeviceModel.create({
      user_id: userId,
      name: name.trim(),
      status: 'offline'
    });

    // Generate device token for WebSocket authentication
    const deviceToken = generateDeviceToken(device.id, userId);
    console.log('Device registered:', device, deviceToken);
    res.status(201).json({
      success: true,
      device: {
        id: device.id,
        name: device.name,
        status: device.status
      },
      deviceToken,
      websocketUrl: `ws://localhost:${process.env.PORT || 3001}/ws`
    });

    console.log(`Device registered for user ${userId}: ${device.name}`);
  } catch (error) {
    console.error('Device registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update device status (internal use)
router.put('/:deviceId/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { status } = req.body;
    const userId = req.user!.id;

    if (!['online', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be "online" or "offline"' });
    }

    // Verify device belongs to user
    const device = await DeviceModel.findById(deviceId);
    if (!device || device.user_id !== userId) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updatedDevice = await DeviceModel.updateStatus(deviceId, status, new Date());

    res.json({
      success: true,
      device: {
        id: updatedDevice!.id,
        name: updatedDevice!.name,
        status: updatedDevice!.status,
        lastSeen: updatedDevice!.last_seen
      }
    });
  } catch (error) {
    console.error('Update device status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unregister device
router.delete('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const deleted = await DeviceModel.deleteByUserId(userId);

    if (!deleted) {
      return res.status(404).json({ error: 'No device found to delete' });
    }

    res.json({ success: true, message: 'Device unregistered successfully' });
    console.log(`Device deleted for user ${userId}`);
  } catch (error) {
    console.error('Device deletion error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;