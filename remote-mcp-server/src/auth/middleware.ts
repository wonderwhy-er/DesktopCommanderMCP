import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserModel } from '../database/models';
import { User } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
    const user = await UserModel.findById(decoded.userId);

    if (!user) {
      res.status(401).json({ error: 'Invalid token - user not found' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const generateToken = (userId: string): string => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );
};

export const generateDeviceToken = (deviceId: string, userId: string): string => {
  return jwt.sign(
    { deviceId, userId, type: 'device' },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );
};

export const verifyDeviceToken = (token: string): { deviceId: string; userId: string } => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
    deviceId?: string;
    userId: string;
    type?: string;
    iat?: number;
    exp?: number;
  };

  console.log('Decoded device token:', decoded)

  if (!decoded.userId) {
    throw new Error('Invalid device token: missing userId');
  }

  // Use the actual deviceId from the token if available, otherwise fall back to userId
  const deviceId = decoded.deviceId || decoded.userId;

  return {
    deviceId: deviceId,
    userId: decoded.userId
  };
};

// Device authentication middleware for MCP requests
export const authenticateDeviceToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Try Authorization header first
    const authHeader = req.headers.authorization;
    let deviceToken = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    // Fallback to body.deviceToken for backward compatibility
    if (!deviceToken && req.body && req.body.deviceToken) {
      deviceToken = req.body.deviceToken;
    }

    if (!deviceToken) {
      res.status(401).json({ error: 'Device token required' });
      return;
    }
    console.log('Device token:', deviceToken);
    // Verify device token
    const { deviceId, userId } = verifyDeviceToken(deviceToken);
    console.log('Device ids:', deviceId, userId);
    // Get the user from the token
    const user = await UserModel.findById(userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid device token - user not found' });
      return;
    }

    req.user = user;
    next();

  } catch (error) {
    console.error('Device token verification error:', error);
    res.status(401).json({ error: 'Invalid or expired device token' });
  }
};