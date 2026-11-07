import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import dotenv from 'dotenv';

export interface AccountCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  tokens?: Credentials;
  sourceFile: string;
}

export interface AccountAuthRecord {
  config: AccountCredentials;
  client: OAuth2Client;
  authorized: boolean;
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

class AuthPool {
  private pool = new Map<string, AccountAuthRecord>();
  private oauthDir: string;

  constructor(oauthDir = path.resolve(process.cwd(), '.oauths')) {
    this.oauthDir = oauthDir;
  }

  public getDirectory(): string {
    return this.oauthDir;
  }

  public scan(): Map<string, AccountAuthRecord> {
    if (!fs.existsSync(this.oauthDir)) {
      return this.pool;
    }

    const files = fs.readdirSync(this.oauthDir);

    for (const file of files) {
      if (file.startsWith('.') || file.endsWith('.tokens.json')) {
        continue;
      }

      const filePath = path.join(this.oauthDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }

      const parsed = this.parseCredentialFile(filePath);
      if (!parsed) {
        continue;
      }

      const existing = this.pool.get(parsed.accountId);
      if (existing) {
        if (parsed.tokens && JSON.stringify(parsed.tokens) !== JSON.stringify(existing.config.tokens)) {
          existing.config.tokens = parsed.tokens;
          existing.client.setCredentials(parsed.tokens);
          existing.authorized = Boolean(parsed.tokens.refresh_token || parsed.tokens.access_token);
        }
        continue;
      }

      this.registerAccount(parsed);
    }

    return this.pool;
  }

  private parseCredentialFile(filePath: string): AccountCredentials | null {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, ext);

    if (ext === '.json') {
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const target = content.web || content.installed || content;

        if (!target.client_id || !target.client_secret) {
          return null;
        }

        const tokenFile = path.join(this.oauthDir, `${baseName}.tokens.json`);
        let tokens: Credentials | undefined;

        if (fs.existsSync(tokenFile)) {
          tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        } else if (target.refresh_token) {
          tokens = {
            refresh_token: target.refresh_token,
            access_token: target.access_token,
            expiry_date: target.expiry_date,
          };
        }

        const isInstalled = Boolean(content.installed);
        let redirectUris = target.redirect_uris || ['http://localhost:3000/api/auth/callback'];
        if (isInstalled && (!redirectUris.length || redirectUris[0] === 'http://localhost' || redirectUris[0] === 'urn:ietf:wg:oauth:2.0:oob')) {
          redirectUris = ['http://localhost:3000/api/auth/callback'];
        }

        return {
          accountId: baseName,
          clientId: target.client_id,
          clientSecret: target.client_secret,
          redirectUris,
          tokens,
          sourceFile: filePath,
        };
      } catch {
        return null;
      }
    }

    if (ext === '.env') {
      try {
        const envContent = fs.readFileSync(filePath, 'utf8');
        const env = dotenv.parse(envContent);

        const clientId = env.GOOGLE_CLIENT_ID || env.CLIENT_ID;
        const clientSecret = env.GOOGLE_CLIENT_SECRET || env.CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return null;
        }

        const refreshToken = env.GOOGLE_REFRESH_TOKEN || env.REFRESH_TOKEN;
        const redirectUri = env.GOOGLE_REDIRECT_URI || env.REDIRECT_URI || 'http://localhost:3000/api/auth/callback';

        const tokenFile = path.join(this.oauthDir, `${baseName}.tokens.json`);
        let tokens: Credentials | undefined;

        if (fs.existsSync(tokenFile)) {
          tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        } else if (refreshToken) {
          tokens = { refresh_token: refreshToken };
        }

        return {
          accountId: baseName,
          clientId,
          clientSecret,
          redirectUris: [redirectUri],
          tokens,
          sourceFile: filePath,
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  private registerAccount(cred: AccountCredentials): AccountAuthRecord {
    const defaultRedirect = cred.redirectUris[0] || 'http://localhost:3000/api/auth/callback';
    const oauth2Client = new google.auth.OAuth2(cred.clientId, cred.clientSecret, defaultRedirect);

    const record: AccountAuthRecord = {
      config: cred,
      client: oauth2Client,
      authorized: false,
    };

    if (cred.tokens?.refresh_token || cred.tokens?.access_token) {
      oauth2Client.setCredentials(cred.tokens);
      record.authorized = Boolean(cred.tokens.refresh_token || cred.tokens.access_token);
    }

    oauth2Client.on('tokens', (newTokens) => {
      const merged: Credentials = {
        ...(record.config.tokens || {}),
        ...newTokens,
      };
      record.config.tokens = merged;
      record.authorized = true;

      const tokenFilePath = path.join(this.oauthDir, `${cred.accountId}.tokens.json`);
      fs.writeFileSync(tokenFilePath, JSON.stringify(merged, null, 2), 'utf8');
    });

    this.pool.set(cred.accountId, record);
    return record;
  }

  public getRecord(accountId: string): AccountAuthRecord | undefined {
    return this.pool.get(accountId);
  }

  public getClient(accountId: string): OAuth2Client | undefined {
    return this.pool.get(accountId)?.client;
  }

  public getAll(): AccountAuthRecord[] {
    return Array.from(this.pool.values());
  }

  public generateAuthUrl(accountId: string, redirectUri?: string): string {
    const record = this.pool.get(accountId);
    if (!record) {
      throw new Error(`Account ${accountId} not registered`);
    }

    const client = redirectUri
      ? new google.auth.OAuth2(record.config.clientId, record.config.clientSecret, redirectUri)
      : record.client;

    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: SCOPES,
      state: accountId,
    });
  }

  public async handleCallback(accountId: string, code: string, redirectUri?: string): Promise<Credentials> {
    const record = this.pool.get(accountId);
    if (!record) {
      throw new Error(`Account ${accountId} not registered`);
    }

    const client = redirectUri
      ? new google.auth.OAuth2(record.config.clientId, record.config.clientSecret, redirectUri)
      : record.client;

    const { tokens } = await client.getToken(code);
    const merged: Credentials = {
      ...(record.config.tokens || {}),
      ...tokens,
    };

    record.client.setCredentials(merged);
    record.config.tokens = merged;
    record.authorized = true;

    const tokenFilePath = path.join(this.oauthDir, `${accountId}.tokens.json`);
    fs.writeFileSync(tokenFilePath, JSON.stringify(merged, null, 2), 'utf8');

    return merged;
  }
}

export const authPool = new AuthPool();

