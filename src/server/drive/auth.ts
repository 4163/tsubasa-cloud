import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import dotenv from 'dotenv';
import { renameAccountInDb } from '../db/index.js';

export function safeRenameFile(srcPath: string, destPath: string): void {
  const resolvedSrc = path.resolve(srcPath);
  const resolvedDest = path.resolve(destPath);

  if (resolvedSrc === resolvedDest || !fs.existsSync(resolvedSrc)) {
    return;
  }

  if (resolvedSrc.toLowerCase() === resolvedDest.toLowerCase()) {
    const tempPath = `${resolvedSrc}.${Date.now()}.tmp`;
    fs.renameSync(resolvedSrc, tempPath);
    fs.renameSync(tempPath, resolvedDest);
    return;
  }

  if (fs.existsSync(resolvedDest)) {
    try {
      fs.unlinkSync(resolvedDest);
    } catch {}
  }
  fs.renameSync(resolvedSrc, resolvedDest);
}

export function extractEmailFromIdToken(idToken?: string | null): string | null {
  if (!idToken) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.email === 'string' && payload.email.includes('@')) {
      return payload.email.toLowerCase().trim();
    }
  } catch {}
  return null;
}

export interface AccountCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  tokens?: Credentials;
  sourceFile: string;
  mtimeMs?: number;
  preferredPoolId?: number;
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
  private preferredPools = new Map<string, number>();
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
      parsed.mtimeMs = stat.mtimeMs;

      if (parsed.tokens?.id_token) {
        const email = extractEmailFromIdToken(parsed.tokens.id_token);
        if (email && email.toLowerCase() !== parsed.accountId.toLowerCase()) {
          const oldId = parsed.accountId;
          const ext = path.extname(parsed.sourceFile).toLowerCase() || '.json';
          const newSourceFile = path.join(this.oauthDir, `${email}${ext}`);
          const oldTokenFile = path.join(this.oauthDir, `${oldId}.tokens.json`);
          const newTokenFile = path.join(this.oauthDir, `${email}.tokens.json`);

          safeRenameFile(parsed.sourceFile, newSourceFile);
          if (fs.existsSync(oldTokenFile)) {
            safeRenameFile(oldTokenFile, newTokenFile);
          }

          parsed.accountId = email;
          parsed.sourceFile = newSourceFile;

          try {
            renameAccountInDb(oldId, email);
          } catch (err) {
            console.warn(`Failed to update database account ID from ${oldId} to ${email}:`, err);
          }
        }
      }

      const existing = this.pool.get(parsed.accountId);
      if (existing) {
        existing.config.mtimeMs = stat.mtimeMs;
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

      const currentAccountId = record.config.accountId;
      const tokenFilePath = path.join(this.oauthDir, `${currentAccountId}.tokens.json`);
      fs.writeFileSync(tokenFilePath, JSON.stringify(merged, null, 2), 'utf8');
    });

    this.pool.set(cred.accountId, record);
    return record;
  }

  public setPreferredPool(accountId: string, poolId: number): void {
    this.preferredPools.set(accountId, poolId);
    const record = this.pool.get(accountId);
    if (record) {
      record.config.preferredPoolId = poolId;
    }
  }

  public getPreferredPool(accountId: string): number {
    return this.preferredPools.get(accountId) ?? this.pool.get(accountId)?.config.preferredPoolId ?? 1;
  }

  public renameAccount(oldAccountId: string, newAccountId: string): string {
    if (!oldAccountId || !newAccountId || oldAccountId.toLowerCase() === newAccountId.toLowerCase()) {
      return oldAccountId;
    }

    const record = this.pool.get(oldAccountId);
    if (!record) {
      return oldAccountId;
    }

    if (this.preferredPools.has(oldAccountId)) {
      const pref = this.preferredPools.get(oldAccountId)!;
      this.preferredPools.set(newAccountId, pref);
      this.preferredPools.delete(oldAccountId);
    }

    const oldSourceFile = record.config.sourceFile;
    const ext = path.extname(oldSourceFile).toLowerCase() || '.json';
    const newSourceFile = path.join(this.oauthDir, `${newAccountId}${ext}`);

    const oldTokenFile = path.join(this.oauthDir, `${oldAccountId}.tokens.json`);
    const newTokenFile = path.join(this.oauthDir, `${newAccountId}.tokens.json`);

    try {
      if (fs.existsSync(oldSourceFile) && path.resolve(oldSourceFile) !== path.resolve(newSourceFile)) {
        safeRenameFile(oldSourceFile, newSourceFile);
        record.config.sourceFile = newSourceFile;
      }

      if (fs.existsSync(oldTokenFile) && path.resolve(oldTokenFile) !== path.resolve(newTokenFile)) {
        safeRenameFile(oldTokenFile, newTokenFile);
      }
    } catch (err) {
      console.warn(`Failed to rename oauth files from ${oldAccountId} to ${newAccountId}:`, err);
    }

    record.config.accountId = newAccountId;
    this.pool.delete(oldAccountId);
    this.pool.set(newAccountId, record);

    try {
      renameAccountInDb(oldAccountId, newAccountId);
    } catch (err) {
      console.warn(`Failed to update database account ID from ${oldAccountId} to ${newAccountId}:`, err);
    }

    return newAccountId;
  }

  public removeAccount(accountId: string): boolean {
    const record = this.pool.get(accountId);
    let removedAny = false;

    if (record?.config.sourceFile && fs.existsSync(record.config.sourceFile)) {
      try {
        fs.unlinkSync(record.config.sourceFile);
        removedAny = true;
      } catch (err) {
        console.warn(`Failed to unlink source credential file ${record.config.sourceFile}:`, err);
      }
    }

    const tokenFile = path.join(this.oauthDir, `${accountId}.tokens.json`);
    if (fs.existsSync(tokenFile)) {
      try {
        fs.unlinkSync(tokenFile);
        removedAny = true;
      } catch (err) {
        console.warn(`Failed to unlink token file ${tokenFile}:`, err);
      }
    }

    if (record) {
      this.pool.delete(accountId);
      this.preferredPools.delete(accountId);
      removedAny = true;
    }

    return removedAny;
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

  public async handleCallback(
    accountId: string,
    code: string,
    redirectUri?: string
  ): Promise<{ tokens: Credentials; accountId: string }> {
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

    let targetAccountId = accountId;
    const email = extractEmailFromIdToken(tokens.id_token);
    if (email && email.toLowerCase() !== accountId.toLowerCase()) {
      targetAccountId = this.renameAccount(accountId, email.toLowerCase());
    }

    const tokenFilePath = path.join(this.oauthDir, `${targetAccountId}.tokens.json`);
    fs.writeFileSync(tokenFilePath, JSON.stringify(merged, null, 2), 'utf8');

    return { tokens: merged, accountId: targetAccountId };
  }

  public async importCredentials(
    rawFilename: string,
    rawContent: string,
    poolId = 1
  ): Promise<{
    success: boolean;
    accountId?: string;
    authorized?: boolean;
    error?: string;
  }> {
    if (!rawContent || !rawContent.trim()) {
      return { success: false, error: 'The uploaded file is empty.' };
    }

    const trimmed = rawContent.trim();
    const isJson = rawFilename.toLowerCase().endsWith('.json') || trimmed.startsWith('{');
    const ext = isJson ? '.json' : '.env';

    let baseName = rawFilename;
    if (baseName.toLowerCase().endsWith('.json')) {
      baseName = baseName.slice(0, -5);
    } else if (baseName.toLowerCase().endsWith('.env')) {
      baseName = baseName.slice(0, -4);
    }

    baseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    if (!baseName || baseName === 'env') {
      baseName = `account_${Date.now()}`;
    }

    if (isJson) {
      let json: Record<string, any>;
      try {
        json = JSON.parse(rawContent);
      } catch {
        return { success: false, error: 'Invalid JSON format in uploaded file.' };
      }

      if (json.web && !json.installed) {
        return {
          success: false,
          error: "The uploaded file has Application Type 'web'. Tsubasa requires credentials created with Application Type: 'Desktop app' (see docs/roadmap.md lines 170-173) to support loopback authentication without pre-registered redirect URIs.",
        };
      }

      const target = json.installed || json;
      const clientId = target.client_id;
      const clientSecret = target.client_secret;

      if (!clientId || !clientSecret) {
        return {
          success: false,
          error: "Missing 'client_id' or 'client_secret' in credential JSON.",
        };
      }

      if (!json.installed) {
        const probe = await verifyDesktopAppClientId(clientId);
        if (!probe.isDesktop) {
          return { success: false, error: probe.error };
        }
      }
    } else {
      let env: Record<string, string>;
      try {
        env = dotenv.parse(rawContent);
      } catch {
        return { success: false, error: 'Failed to parse .env file format.' };
      }

      const clientId = env.GOOGLE_CLIENT_ID || env.CLIENT_ID;
      const clientSecret = env.GOOGLE_CLIENT_SECRET || env.CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return {
          success: false,
          error: 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env file.',
        };
      }

      const declaredType = (env.TYPE || env.APPLICATION_TYPE || env.CLIENT_TYPE || '').toLowerCase();
      if (declaredType === 'web' || declaredType === 'web_app' || declaredType === 'web_application') {
        return {
          success: false,
          error: "The .env file specifies Application Type: 'web'. Tsubasa requires a 'Desktop app' credential (see docs/roadmap.md lines 170-173).",
        };
      }

      const envRedirect = env.GOOGLE_REDIRECT_URI || env.REDIRECT_URI;
      if (envRedirect) {
        try {
          const u = new URL(envRedirect);
          if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
            return {
              success: false,
              error: `The .env specifies a non-loopback redirect URI (${envRedirect}). Desktop apps must use loopback (http://localhost or http://127.0.0.1).`,
            };
          }
        } catch {}
      }

      const probe = await verifyDesktopAppClientId(clientId);
      if (!probe.isDesktop) {
        return { success: false, error: probe.error };
      }

      if (env.ACCOUNT_ID || env.EMAIL) {
        const preferredId = (env.ACCOUNT_ID || env.EMAIL).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (preferredId) baseName = preferredId;
      }
    }

    if (!fs.existsSync(this.oauthDir)) {
      fs.mkdirSync(this.oauthDir, { recursive: true });
    }

    const targetFilePath = path.join(this.oauthDir, `${baseName}${ext}`);
    fs.writeFileSync(targetFilePath, rawContent, 'utf8');

    this.scan();

    const record = this.pool.get(baseName) || this.getAll().find((r) => r.config.sourceFile === targetFilePath);
    const finalAccountId = record ? record.config.accountId : baseName;
    this.setPreferredPool(finalAccountId, poolId);
    if (record) {
      record.config.preferredPoolId = poolId;
    }
    return {
      success: true,
      accountId: finalAccountId,
      authorized: record?.authorized ?? false,
    };
  }
}

export async function verifyDesktopAppClientId(clientId: string): Promise<{ isDesktop: boolean; error?: string }> {
  const probeUri = 'http://127.0.0.1:54321/tsubasa-probe';
  const probeUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(probeUri)}&response_type=code&scope=email`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const finalUrl = res.url || '';
    const text = await res.text();

    if (
      finalUrl.includes('signin/oauth/error') ||
      text.includes('redirect_uri_mismatch') ||
      finalUrl.includes('authError=ChVyZWRpcmVjdF91cmlfbWlzbWF0Y2g')
    ) {
      return {
        isDesktop: false,
        error: "Google rejected the loopback redirect URI: this Client ID is registered as a 'Web application' in Google Cloud Console. Please create credentials with Application Type set to 'Desktop app' (see docs/roadmap.md lines 170-173).",
      };
    }

    if (text.includes('invalid_client') || text.includes('deleted_client') || finalUrl.includes('error=invalid_client')) {
      return {
        isDesktop: false,
        error: 'Google reported this Client ID is invalid or deleted. Please verify your client credentials.',
      };
    }

    return { isDesktop: true };
  } catch (err) {
    console.warn('Google Desktop OAuth probe network check skipped:', err);
    return { isDesktop: true };
  } finally {
    clearTimeout(timer);
  }
}

export const authPool = new AuthPool();

