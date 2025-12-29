/**
 * User Model
 * Simple in-memory user storage for demo purposes
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class UserStore {
  constructor() {
    this.users = new Map();
    
    // Add demo user if in demo mode
    if (process.env.DEMO_MODE === 'true') {
      this.addDemoUser();
    }
  }

  /**
   * Add demo user for development
   */
  addDemoUser() {
    const demoUser = {
      id: 'demo-user-1',
      email: process.env.DEMO_USER_EMAIL || 'test@example.com',
      password: this.hashPassword(process.env.DEMO_USER_PASSWORD || 'password123'),
      name: process.env.DEMO_USER_NAME || 'Demo User',
      created_at: new Date().toISOString(),
      verified: true,
      demo: true
    };
    
    this.users.set(demoUser.email, demoUser);
    this.users.set(demoUser.id, demoUser);
  }

  /**
   * Hash password (simple implementation for demo)
   */
  hashPassword(password) {
    return crypto.createHash('sha256').update(password + 'salt').digest('hex');
  }

  /**
   * Create new user
   */
  createUser(userData) {
    const user = {
      id: uuidv4(),
      email: userData.email,
      password: this.hashPassword(userData.password),
      name: userData.name || 'Unknown User',
      created_at: new Date().toISOString(),
      verified: false,
      demo: false
    };

    // Check if email already exists
    if (this.users.has(userData.email)) {
      throw new Error('User with this email already exists');
    }

    this.users.set(user.email, user);
    this.users.set(user.id, user);
    
    return this.sanitizeUser(user);
  }

  /**
   * Find user by email
   */
  findByEmail(email) {
    const user = this.users.get(email);
    return user ? this.sanitizeUser(user) : null;
  }

  /**
   * Find user by ID
   */
  findById(id) {
    const user = this.users.get(id);
    return user ? this.sanitizeUser(user) : null;
  }

  /**
   * Validate user credentials
   */
  validateCredentials(email, password) {
    const user = this.users.get(email);
    if (!user) {
      return null;
    }

    const hashedPassword = this.hashPassword(password);
    if (user.password !== hashedPassword) {
      return null;
    }

    return this.sanitizeUser(user);
  }

  /**
   * Remove sensitive data from user object
   */
  sanitizeUser(user) {
    if (!user) return null;
    
    const { password, ...sanitized } = user;
    return sanitized;
  }

  /**
   * Update user
   */
  updateUser(id, updates) {
    const user = this.users.get(id);
    if (!user) {
      throw new Error('User not found');
    }

    const updatedUser = { ...user, ...updates };
    
    // If email is being updated, update the email key
    if (updates.email && updates.email !== user.email) {
      this.users.delete(user.email);
      this.users.set(updates.email, updatedUser);
    }
    
    this.users.set(id, updatedUser);
    return this.sanitizeUser(updatedUser);
  }

  /**
   * Delete user
   */
  deleteUser(id) {
    const user = this.users.get(id);
    if (!user) {
      return false;
    }

    this.users.delete(id);
    this.users.delete(user.email);
    return true;
  }

  /**
   * Get all users (admin function)
   */
  getAllUsers() {
    const users = [];
    for (const user of this.users.values()) {
      if (typeof user === 'object' && user.id) {
        users.push(this.sanitizeUser(user));
      }
    }
    return users;
  }

  /**
   * Verify user email
   */
  verifyUser(id) {
    const user = this.users.get(id);
    if (!user) {
      throw new Error('User not found');
    }

    user.verified = true;
    this.users.set(id, user);
    this.users.set(user.email, user);
    
    return this.sanitizeUser(user);
  }

  /**
   * Get user statistics
   */
  getStats() {
    const allUsers = this.getAllUsers();
    return {
      total_users: allUsers.length,
      verified_users: allUsers.filter(u => u.verified).length,
      demo_users: allUsers.filter(u => u.demo).length
    };
  }

  /**
   * Auto-approve user for demo mode
   */
  shouldAutoApprove(userId) {
    if (process.env.DEMO_MODE !== 'true') {
      return false;
    }

    const user = this.findById(userId);
    return user && user.demo;
  }
}

// Export singleton instance
module.exports = new UserStore();