import { Router, Request, Response } from 'express';
import { UserModel } from '../database/models';
import { generateToken, authenticateToken } from './middleware';
import bcrypt from 'bcrypt';

const router = Router();

// Simple login for MVP (will be replaced with OAuth later)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, name, password } = req.body;

    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    // For MVP, we'll create users automatically on login
    let user = await UserModel.findByEmail(email);
    
    if (!user) {
      // Create new user
      user = await UserModel.create({
        email,
        name,
        provider: 'manual'
      });
      console.log('Created new user:', user.email);
    }

    const token = generateToken(user.id);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user info
router.get('/me', authenticateToken, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({
    id: user.id,
    email: user.email,
    name: user.name
  });
});

// Logout (for future session management)
router.post('/logout', authenticateToken, async (req: Request, res: Response) => {
  // For now, just return success (JWT tokens can't be "logged out" server-side without a blacklist)
  res.json({ success: true, message: 'Logged out successfully' });
});

// Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;