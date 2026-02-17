const { PrismaClient } = require('../generated/prisma');
const prisma = new PrismaClient();

const VISMA_ENVS = {
  sandbox: {
    scopes: 'ea:api ea:sales ea:purchase ea:accounting offline_access',
  },
  production: {
    scopes: 'offline_access ea:api ea:sales ea:accounting_readonly',
  },
};

class SpirisClient {
  constructor() {
    this.apiUrl = 'https://eaccountingapi.vismaonline.com';
    this.identityUrl = 'https://identity.vismaonline.com';
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // 600 req/min ≈ 100ms
  }

  async getEnvironment() {
    const envSetting = await prisma.setting.findUnique({ where: { key: 'visma_environment' } });
    return envSetting?.value || 'sandbox';
  }

  async getCredentials() {
    const env = await this.getEnvironment();
    const prefix = `visma_${env}_`;

    const clientIdSetting = await prisma.setting.findUnique({ where: { key: `${prefix}client_id` } });
    const clientSecretSetting = await prisma.setting.findUnique({ where: { key: `${prefix}client_secret` } });

    const clientId = clientIdSetting?.value || process.env.VISMA_CLIENT_ID;
    const clientSecret = clientSecretSetting?.value || process.env.VISMA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(`Spiris credentials not configured for ${env}`);
    }

    return { clientId, clientSecret, env };
  }

  async getRedirectUri() {
    const env = await this.getEnvironment();
    const setting = await prisma.setting.findUnique({ where: { key: `visma_${env}_redirect_uri` } });
    return setting?.value || process.env.VISMA_REDIRECT_URI || 'http://localhost:3000/settings/visma/callback';
  }

  /**
   * Build the OAuth2 authorization URL for user login.
   */
  async getAuthorizationUrl(state) {
    const { clientId, env } = await this.getCredentials();
    const redirectUri = await this.getRedirectUri();
    const scopes = VISMA_ENVS[env]?.scopes || VISMA_ENVS.sandbox.scopes;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      state: state || 'default',
      prompt: 'select_account',
    });

    return `${this.identityUrl}/connect/authorize?${params}`;
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(code) {
    const { clientId, clientSecret } = await this.getCredentials();
    const redirectUri = await this.getRedirectUri();

    const res = await fetch(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Spiris token exchange failed: ${res.status} — ${body}`);
    }

    const data = await res.json();

    // Store tokens in database
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);

    await prisma.apiToken.upsert({
      where: { id: (await prisma.apiToken.findFirst({ where: { provider: 'visma' } }))?.id || 0 },
      update: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt,
        tokenData: JSON.stringify({ scope: data.scope, token_type: data.token_type }),
      },
      create: {
        provider: 'visma',
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt,
        tokenData: JSON.stringify({ scope: data.scope, token_type: data.token_type }),
      },
    });

    return data;
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refreshAccessToken() {
    const { clientId, clientSecret } = await this.getCredentials();
    const stored = await prisma.apiToken.findFirst({ where: { provider: 'visma' } });

    if (!stored?.refreshToken) {
      throw new Error('No Spiris refresh token available — re-authorize via /settings');
    }

    const res = await fetch(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Spiris token refresh failed: ${res.status} — ${body}`);
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);

    await prisma.apiToken.update({
      where: { id: stored.id },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || stored.refreshToken,
        expiresAt,
      },
    });

    return data.access_token;
  }

  /**
   * Get a valid access token, refreshing if needed.
   */
  async getToken() {
    const stored = await prisma.apiToken.findFirst({ where: { provider: 'visma' } });

    if (!stored) {
      throw new Error('Spiris not connected — authorize via /settings');
    }

    // Refresh if expired or expiring within 5 minutes
    if (new Date() > new Date(stored.expiresAt.getTime() - 5 * 60 * 1000)) {
      return this.refreshAccessToken();
    }

    return stored.accessToken;
  }

  async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Authenticated GET request to Spiris API.
   */
  async get(path, params = {}) {
    const token = await this.getToken();
    await this.rateLimit();

    const url = new URL(`/v2${path}`, this.apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    if (res.status === 401) {
      // Try refresh once
      const newToken = await this.refreshAccessToken();
      const retry = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${newToken}`, 'Accept': 'application/json' },
      });
      if (!retry.ok) {
        const body = await retry.text().catch(() => '');
        throw new Error(`Spiris GET ${path} failed: ${retry.status} — ${body}`);
      }
      return retry.json();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Spiris GET ${path} failed: ${res.status} — ${body}`);
    }

    return res.json();
  }

  /**
   * Authenticated POST request to Spiris API.
   */
  async post(path, body = {}) {
    const token = await this.getToken();
    await this.rateLimit();

    const url = new URL(`/v2${path}`, this.apiUrl);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Spiris POST ${path} failed: ${res.status} — ${errBody}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * List customers.
   */
  async getCustomers(page = 1, pageSize = 100) {
    return this.get('/customers', { $page: page, $pagesize: pageSize });
  }

  /**
   * List articles.
   */
  async getArticles(page = 1, pageSize = 100) {
    return this.get('/articles', { $page: page, $pagesize: pageSize });
  }

  /**
   * Find project by number (fetches all and filters locally).
   */
  async findProjectByNumber(projectNumber) {
    const num = String(projectNumber).trim();
    let page = 1;
    while (true) {
      const data = await this.get('/projects', { $page: page, $pagesize: 100 });
      const items = data.Data || data.data || data;
      if (!Array.isArray(items) || items.length === 0) break;
      const match = items.find(p => String(p.Number).trim() === num);
      if (match) return match;
      if (items.length < 100) break;
      page++;
    }
    return null;
  }

  /**
   * Create invoice draft.
   */
  async createInvoiceDraft(draft) {
    return this.post('/customerinvoicedrafts', draft);
  }

  /**
   * Convert draft to booked invoice.
   */
  async bookInvoiceDraft(draftId) {
    return this.post(`/customerinvoicedrafts/${draftId}/convert`);
  }

  /**
   * Send invoice via email.
   */
  async sendInvoiceEmail(invoiceId) {
    return this.post(`/customerinvoices/${invoiceId}/email`);
  }
}

module.exports = { SpirisClient };
