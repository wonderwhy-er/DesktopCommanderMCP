import { db } from './connection';
import { User, Device, Session } from '../types';
import bcrypt from 'bcrypt';

export class UserModel {
  static async create(userData: Omit<User, 'id' | 'created_at'>): Promise<User> {
    const { rows } = await db.query<User>(
      'INSERT INTO users (email, name, provider, provider_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [userData.email, userData.name, userData.provider, userData.provider_id]
    );
    return rows[0];
  }

  static async findByEmail(email: string): Promise<User | null> {
    const { rows } = await db.query<User>(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return rows[0] || null;
  }

  static async findById(id: string): Promise<User | null> {
    const { rows } = await db.query<User>(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  static async findByProvider(provider: string, providerId: string): Promise<User | null> {
    const { rows } = await db.query<User>(
      'SELECT * FROM users WHERE provider = $1 AND provider_id = $2',
      [provider, providerId]
    );
    return rows[0] || null;
  }
}

export class DeviceModel {
  static async create(deviceData: Omit<Device, 'id' | 'created_at'>): Promise<Device> {
    const { rows } = await db.query<Device>(
      'INSERT INTO devices (user_id, name, status) VALUES ($1, $2, $3) RETURNING *',
      [deviceData.user_id, deviceData.name, deviceData.status]
    );
    return rows[0];
  }

  static async findByUserId(userId: string): Promise<Device | null> {
    const { rows } = await db.query<Device>(
      'SELECT * FROM devices WHERE user_id = $1',
      [userId]
    );
    return rows[0] || null;
  }

  static async findById(id: string): Promise<Device | null> {
    const { rows } = await db.query<Device>(
      'SELECT * FROM devices WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  static async updateStatus(deviceId: string, status: 'online' | 'offline', lastSeen?: Date): Promise<Device | null> {
    const { rows } = await db.query<Device>(
      'UPDATE devices SET status = $1, last_seen = $2 WHERE id = $3 RETURNING *',
      [status, lastSeen || new Date(), deviceId]
    );
    return rows[0] || null;
  }

  static async delete(deviceId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM devices WHERE id = $1',
      [deviceId]
    );
    return rowCount > 0;
  }

  static async deleteByUserId(userId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM devices WHERE user_id = $1',
      [userId]
    );
    return rowCount > 0;
  }
}

export class SessionModel {
  static async create(sessionData: Omit<Session, 'id' | 'created_at'>): Promise<Session> {
    const { rows } = await db.query<Session>(
      'INSERT INTO sessions (user_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionData.user_id, sessionData.device_id, sessionData.token_hash, sessionData.expires_at]
    );
    return rows[0];
  }

  static async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const { rows } = await db.query<Session>(
      'SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    return rows[0] || null;
  }

  static async deleteByTokenHash(tokenHash: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM sessions WHERE token_hash = $1',
      [tokenHash]
    );
    return rowCount > 0;
  }

  static async deleteExpired(): Promise<number> {
    const { rowCount } = await db.query(
      'DELETE FROM sessions WHERE expires_at <= NOW()'
    );
    return rowCount;
  }

  static async deleteByUserId(userId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [userId]
    );
    return rowCount > 0;
  }
}