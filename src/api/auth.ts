import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { kvDelete, kvGet, kvSet } from '../db.ts';
import { log } from '../log.ts';
import { encodeParams, GraphError, request } from './http.ts';

export interface StoredToken {
  accessToken: string;
  userId: string;
  username?: string;
  accountType?: string;
  /** ISO time the current token was issued/refreshed. */
  issuedAt: string;
  /** ISO expiry; undefined when unknown (e.g. pasted token not yet introspected) or never (Facebook Page token). */
  expiresAt?: string;
  permissions?: string;
  /** Facebook Login: the Page whose token is stored. */
  pageId?: string;
}

const TOKEN_KEY = 'token';
const DAY = 86_400_000;

export function loadToken(): StoredToken | undefined {
  return kvGet<StoredToken>(TOKEN_KEY);
}

function saveToken(token: StoredToken): void {
  kvSet(TOKEN_KEY, token);
}

export function clearToken(): void {
  kvDelete(TOKEN_KEY);
}

export interface Me {
  user_id: string;
  id: string;
  username: string;
  account_type?: string;
  media_count?: number;
  name?: string;
  profile_picture_url?: string;
}

const FB_IG_FIELDS = 'id,username,name,media_count,profile_picture_url';

export async function fetchMe(accessToken: string): Promise<Me> {
  if (config.login === 'facebook') {
    // The stored token is a Page token; the Instagram account hangs off the Page.
    const page = await request<{ id: string; instagram_business_account?: Me }>('me', {
      token: accessToken,
      params: { fields: `instagram_business_account{${FB_IG_FIELDS}}` },
    });
    const ig = page.instagram_business_account;
    if (!ig) throw new Error(`Facebook sahifa ${page.id} ga Instagram professional akkaunt ulanmagan`);
    return { ...ig, user_id: ig.id };
  }
  return request<Me>('me', {
    token: accessToken,
    params: { fields: 'user_id,username,account_type,media_count,name,profile_picture_url' },
  });
}

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

function pickPage(pages: FbPage[]): FbPage | undefined {
  if (config.pageId) return pages.find((p) => p.id === config.pageId);
  if (config.username) return pages.find((p) => p.instagram_business_account?.username?.toLowerCase() === config.username);
  return pages.find((p) => p.instagram_business_account);
}

/**
 * Facebook Login: user token (e.g. from Graph API Explorer) → long-lived user token → Page token.
 * A Page token derived from a long-lived user token does not expire, so no refresh is needed.
 */
async function storeFacebookToken(rawToken: string): Promise<StoredToken> {
  if (!config.appId || !config.appSecret) {
    throw new Error('IG_LOGIN=facebook: IG_APP_ID va IG_APP_SECRET .env da bo‘lishi kerak (App settings → Basic)');
  }
  const long = await request<TokenResponse>('oauth/access_token', {
    retries: 1,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: rawToken.trim(),
    },
  });
  const pages = await request<{ data?: FbPage[] }>('me/accounts', {
    token: long.access_token,
    params: { fields: 'id,name,access_token,instagram_business_account{id,username}' },
  });
  const page = pickPage(pages.data ?? []);
  if (!page) {
    const names = (pages.data ?? [])
      .map((p) => `${p.name} (${p.id}${p.instagram_business_account?.username ? `, @${p.instagram_business_account.username}` : ''})`)
      .join(', ') || 'hech qanday sahifa ko‘rinmadi';
    const wanted = config.pageId ? ` (IG_PAGE_ID=${config.pageId})` : config.username ? ` (@${config.username})` : '';
    throw new Error(`Instagram ulangan Facebook sahifa topilmadi${wanted}: ${names}. ` +
      'Token pages_show_list ruxsati bilan olinganini va Instagram sahifaga ulanganini tekshiring');
  }
  const me = await fetchMe(page.access_token);
  const token: StoredToken = {
    accessToken: page.access_token,
    userId: me.id,
    username: me.username,
    issuedAt: new Date().toISOString(),
    pageId: page.id,
  };
  saveToken(token);
  return token;
}

/** Store a token (short- or long-lived) after verifying it, upgrading short-lived ones when the app secret is known. */
export async function storeToken(rawToken: string, expiresInSec?: number): Promise<StoredToken> {
  if (config.login === 'facebook') return storeFacebookToken(rawToken);
  let accessToken = rawToken.trim();
  let expiresIn = expiresInSec;
  if (config.appSecret && expiresIn === undefined) {
    // Short-lived tokens can be exchanged; long-lived ones are rejected by this call, which is fine.
    try {
      const long = await exchangeForLongLived(accessToken);
      accessToken = long.access_token;
      expiresIn = long.expires_in;
      log('qisqa token uzoq muddatli (60 kun) tokenga almashtirildi');
    } catch {
      /* already long-lived, or exchange not possible */
    }
  }
  const me = await fetchMe(accessToken);
  const now = new Date();
  const token: StoredToken = {
    accessToken,
    userId: me.user_id ?? me.id,
    username: me.username,
    accountType: me.account_type,
    issuedAt: now.toISOString(),
    // Pasted dashboard tokens are long-lived (60 days) unless told otherwise.
    expiresAt: new Date(now.getTime() + (expiresIn ?? 60 * 86_400) * 1000).toISOString(),
  };
  saveToken(token);
  return token;
}

function instagramLoginOnly(): void {
  if (config.login === 'facebook') throw new Error('IG_LOGIN=facebook: OAuth o‘rniga `ig auth token -` ishlating (SETUP.md)');
}

export function authorizeUrl(state = randomBytes(8).toString('hex')): string {
  instagramLoginOnly();
  if (!config.appId) throw new Error('IG_APP_ID .env da yo‘q');
  const qs = encodeParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state,
    enable_fb_login: false,
    force_reauth: true,
  });
  return `${config.authorizeBase}/oauth/authorize?${qs}`;
}

/** Accepts either the bare code or the whole redirect URL pasted from the browser. */
export function extractCode(input: string): string {
  let code = input.trim();
  if (code.includes('code=')) code = new URL(code).searchParams.get('code') ?? '';
  return code.replace(/#_$/, '');
}

export async function loginWithCode(input: string): Promise<StoredToken> {
  instagramLoginOnly();
  if (!config.appId || !config.appSecret) throw new Error('IG_APP_ID va IG_APP_SECRET .env da bo‘lishi kerak');
  const code = extractCode(input);
  if (!code) throw new Error('code topilmadi');
  const res = await request<any>('', {
    method: 'POST',
    url: `${config.oauthBase}/oauth/access_token`,
    retries: 0,
    params: {
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code,
    },
  });
  const entry = Array.isArray(res.data) ? res.data[0] : res;
  const long = await exchangeForLongLived(entry.access_token);
  const token = await storeToken(long.access_token, long.expires_in);
  token.permissions = Array.isArray(entry.permissions) ? entry.permissions.join(',') : entry.permissions;
  saveToken(token);
  return token;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeForLongLived(shortToken: string): Promise<TokenResponse> {
  return request<TokenResponse>('', {
    url: `${config.graphBase}/access_token`,
    retries: 1,
    params: { grant_type: 'ig_exchange_token', client_secret: config.appSecret, access_token: shortToken },
  });
}

export async function refreshToken(): Promise<StoredToken> {
  if (config.login === 'facebook') throw new Error('Facebook sahifa tokeni muddatsiz — yangilash kerak emas');
  const current = loadToken();
  if (!current) throw new Error('token yo‘q: avval `ig auth token <TOKEN>` yoki `ig auth login`');
  const res = await request<TokenResponse>('', {
    url: `${config.graphBase}/refresh_access_token`,
    params: { grant_type: 'ig_refresh_token', access_token: current.accessToken },
  });
  const now = new Date();
  const next: StoredToken = {
    ...current,
    accessToken: res.access_token,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + res.expires_in * 1000).toISOString(),
  };
  saveToken(next);
  return next;
}

export function tokenDaysLeft(token: StoredToken): number | undefined {
  return token.expiresAt ? (Date.parse(token.expiresAt) - Date.now()) / DAY : undefined;
}

/**
 * Refresh when the token is at least a day old (API requirement) and within
 * the refresh window. Returns true if a refresh happened.
 */
export async function refreshIfNeeded(force = false): Promise<boolean> {
  const token = loadToken();
  if (!token || config.login === 'facebook') return false;
  const ageDays = (Date.now() - Date.parse(token.issuedAt)) / DAY;
  const left = tokenDaysLeft(token) ?? 0;
  if (!force && (ageDays < 1 || left > config.refreshBeforeDays)) return false;
  if (ageDays < 1) throw new Error('token 24 soatdan yosh — Instagram hali yangilashga ruxsat bermaydi');
  await refreshToken();
  return true;
}

export async function getAuth(): Promise<{ token: string; userId: string }> {
  let stored = loadToken();
  if (!stored && config.bootstrapToken) stored = await storeToken(config.bootstrapToken);
  if (!stored) throw new Error('token yo‘q: `ig auth token <TOKEN>` yoki `ig auth login` (SETUP.md)');
  const left = tokenDaysLeft(stored);
  if (left !== undefined && left <= 0) {
    throw new GraphError('token muddati tugagan — yangi token oling (SETUP.md)', 401, { error: { code: 190 } });
  }
  try {
    if (await refreshIfNeeded()) stored = loadToken()!;
  } catch (err) {
    log(`token yangilanmadi: ${(err as Error).message}`);
  }
  return { token: stored.accessToken, userId: stored.userId };
}
