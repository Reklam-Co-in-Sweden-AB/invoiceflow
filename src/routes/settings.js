const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');
const crypto = require('crypto');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const settings = await prisma.setting.findMany();
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));

  const blikkToken = await prisma.apiToken.findFirst({ where: { provider: 'blikk' } });
  const vismaToken = await prisma.apiToken.findFirst({ where: { provider: 'visma' } });

  res.render('settings', { settings: settingsMap, blikkToken, vismaToken });
});

router.post('/blikk', async (req, res) => {
  const { username, password } = req.body;

  const keys = { blikk_username: username, blikk_password: password };
  for (const [key, value] of Object.entries(keys)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  res.redirect('/settings');
});

router.post('/visma', async (req, res) => {
  const { clientId, clientSecret } = req.body;

  const keys = { visma_client_id: clientId, visma_client_secret: clientSecret };
  for (const [key, value] of Object.entries(keys)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  res.redirect('/settings');
});

// Start Spiris OAuth2 flow
router.get('/visma/connect', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();

    const state = crypto.randomBytes(16).toString('hex');
    req.session.vismaOAuthState = state;

    const authUrl = await client.getAuthorizationUrl(state);
    res.redirect(authUrl);
  } catch (error) {
    res.redirect('/settings?error=' + encodeURIComponent(error.message));
  }
});

// OAuth2 callback
router.get('/visma/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      throw new Error(`Spiris OAuth error: ${oauthError}`);
    }

    if (!code) {
      throw new Error('No authorization code received');
    }

    // Verify state
    if (state && req.session.vismaOAuthState && state !== req.session.vismaOAuthState) {
      throw new Error('Invalid OAuth state — possible CSRF');
    }

    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    await client.exchangeCode(code);

    delete req.session.vismaOAuthState;
    res.redirect('/settings?success=spiris');
  } catch (error) {
    res.redirect('/settings?error=' + encodeURIComponent(error.message));
  }
});

// Test Spiris connection
router.post('/visma/test', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    const data = await client.getCustomers(1, 1);
    const count = data.Meta?.TotalNumberOfResults ?? data.TotalNumberOfResults ?? '?';
    res.json({ success: true, info: `Anslutning OK — ${count} kunder` });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

module.exports = router;
