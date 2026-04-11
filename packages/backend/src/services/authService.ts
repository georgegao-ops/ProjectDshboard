import crypto from 'crypto';

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export class AuthService {
  /**
   * Generate JWT-like token (simplified implementation)
   * In production, use jsonwebtoken library
   */
  static generateToken(payload: TokenPayload): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64');

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64');

    // Create signature
    const secret = process.env.JWT_SECRET || 'your-secret-key';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payloadStr}`)
      .digest('base64');

    return `${header}.${payloadStr}.${signature}`;
  }

  /**
   * Verify and decode JWT token
   */
  static verifyToken(token: string): TokenPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }

      const [header, payload, signature] = parts;
      const secret = process.env.JWT_SECRET || 'your-secret-key';

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64');

      if (signature !== expectedSignature) {
        return null;
      }

      // Decode payload
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      return decoded;
    } catch (error) {
      return null;
    }
  }

  /**
   * Hash password (use bcrypt in production)
   */
  static hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  /**
   * Verify password
   */
  static verifyPassword(
    plainPassword: string,
    hashedPassword: string
  ): boolean {
    return this.hashPassword(plainPassword) === hashedPassword;
  }
}
