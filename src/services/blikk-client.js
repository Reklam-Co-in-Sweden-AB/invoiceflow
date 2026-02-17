const { PrismaClient } = require('../generated/prisma');
const prisma = new PrismaClient();

class BlikkClient {
  constructor() {
    this.baseUrl = process.env.BLIKK_API_URL || 'https://publicapi.blikk.com';
    this.token = null;
    this.tokenExpires = null;
    this.lastRequestTime = 0;
    this.minRequestInterval = 250; // 4 req/s
  }

  /**
   * Rate limit: wait at least 250ms between requests.
   */
  async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch with automatic retry on 429 Too Many Requests.
   */
  async fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
      const res = await fetch(url, options);
      if (res.status === 429 && i < retries - 1) {
        const wait = (i + 1) * 1000; // 1s, 2s, 3s
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    }
  }

  /**
   * Authenticate with Blikk API using Basic auth → Bearer token.
   */
  async authenticate() {
    if (this.token && this.tokenExpires && Date.now() < this.tokenExpires) {
      return this.token;
    }

    // Get credentials from settings
    const usernameSetting = await prisma.setting.findUnique({ where: { key: 'blikk_username' } });
    const passwordSetting = await prisma.setting.findUnique({ where: { key: 'blikk_password' } });

    const username = usernameSetting?.value || process.env.BLIKK_USERNAME;
    const password = passwordSetting?.value || process.env.BLIKK_PASSWORD;

    if (!username || !password) {
      throw new Error('Blikk credentials not configured');
    }

    await this.rateLimit();

    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/Auth/Token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Blikk auth failed: ${res.status} ${res.statusText} — ${body}`);
    }

    const data = await res.json();
    this.token = data.accessToken;

    if (!this.token) {
      throw new Error('Blikk auth: no accessToken in response');
    }

    // Parse expires from response, fallback to 23h
    if (data.expires) {
      this.tokenExpires = new Date(data.expires).getTime();
    } else {
      this.tokenExpires = Date.now() + 23 * 60 * 60 * 1000;
    }

    return this.token;
  }

  /**
   * Make an authenticated GET request.
   */
  async get(path, params = {}) {
    const token = await this.authenticate();
    await this.rateLimit();

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const res = await this.fetchWithRetry(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Blikk GET ${path} failed: ${res.status} ${res.statusText} — ${body}`);
    }

    return res.json();
  }

  /**
   * Make an authenticated PATCH request (query params style).
   */
  async patch(path, params = {}) {
    const token = await this.authenticate();
    await this.rateLimit();

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const res = await this.fetchWithRetry(url.toString(), {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Blikk PATCH ${path} failed: ${res.status} ${res.statusText}`);
    }

    // Some PATCH endpoints return no body
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Make an authenticated PUT request with JSON body.
   */
  async put(path, body = {}) {
    const token = await this.authenticate();
    await this.rateLimit();

    const url = new URL(path, this.baseUrl);

    const res = await this.fetchWithRetry(url.toString(), {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Blikk PUT ${path} failed: ${res.status} ${res.statusText} — ${errBody}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Fetch all invoices with pagination.
   * @param {Object} filter - Optional filters (e.g. sentToEconomySystem=null)
   */
  async getAllInvoices(filter = {}) {
    const allInvoices = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const data = await this.get('/v1/core/invoices', {
        page,
        pageSize,
        ...filter,
      });

      const items = data.items || data.data || data;
      if (!Array.isArray(items) || items.length === 0) break;

      allInvoices.push(...items);

      if (items.length < pageSize) break;
      page++;
    }

    return allInvoices;
  }

  /**
   * Fetch a single invoice with details.
   */
  async getInvoice(id) {
    return this.get(`/v1/core/invoices/${id}`);
  }

  /**
   * Fetch contacts/customers.
   */
  async getAllContacts() {
    const allContacts = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const data = await this.get('/v1/Core/Contacts', { page, pageSize });
      const items = data.items || data.data || data;
      if (!Array.isArray(items) || items.length === 0) break;

      allContacts.push(...items);
      if (items.length < pageSize) break;
      page++;
    }

    return allContacts;
  }

  /**
   * Fetch all payment plans (faktueringstillfällen) with pagination.
   * @param {Object} filter - Optional filters (e.g. filter.projectId)
   */
  async getAllPaymentPlans(filter = {}) {
    const all = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const data = await this.get('/v1/Core/PaymentPlans', {
        page,
        pageSize,
        ...filter,
      });

      const items = data.items || data.data || data;
      if (!Array.isArray(items) || items.length === 0) break;

      all.push(...items);
      if (items.length < pageSize) break;
      page++;
    }

    return all;
  }

  /**
   * Mark invoice as sent to economy system.
   */
  async markAsSent(invoiceId, date, economySystemInvoiceNumber) {
    return this.patch(
      `/v1/core/invoices/${invoiceId}/setsenttoeconomysystem`,
      {
        date,
        economySystemInvoiceNumber,
      }
    );
  }
}

module.exports = { BlikkClient };
