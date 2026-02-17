const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const settings = await prisma.setting.findMany();
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));

  const blikkToken = await prisma.apiToken.findFirst({ where: { provider: 'blikk' } });
  const vismaToken = await prisma.apiToken.findFirst({ where: { provider: 'visma' } });
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });

  res.render('settings', { settings: settingsMap, blikkToken, vismaToken, users });
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
  const { clientId, clientSecret, redirectUri, environment } = req.body;
  const env = environment || 'sandbox';
  const prefix = `visma_${env}_`;

  const keys = {
    [`${prefix}client_id`]: clientId,
    [`${prefix}client_secret`]: clientSecret,
    [`${prefix}redirect_uri`]: redirectUri,
  };
  for (const [key, value] of Object.entries(keys)) {
    if (value) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  }

  res.redirect('/settings');
});

// Switch Visma environment (sandbox <-> production)
router.post('/visma/environment', async (req, res) => {
  const { environment } = req.body;
  if (!['sandbox', 'production'].includes(environment)) {
    return res.redirect('/settings?error=' + encodeURIComponent('Ogiltig miljö'));
  }

  await prisma.setting.upsert({
    where: { key: 'visma_environment' },
    update: { value: environment },
    create: { key: 'visma_environment', value: environment },
  });

  // Clear existing token — user must re-authorize in new environment
  const existingToken = await prisma.apiToken.findFirst({ where: { provider: 'visma' } });
  if (existingToken) {
    await prisma.apiToken.delete({ where: { id: existingToken.id } });
  }

  res.redirect('/settings?success=env_switched');
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

// Create new user
router.post('/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.redirect('/settings?error=' + encodeURIComponent('Alla fält krävs'));
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.redirect('/settings?error=' + encodeURIComponent('E-postadressen används redan'));
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { name, email, passwordHash } });
    res.redirect('/settings?success=user_created');
  } catch (error) {
    res.redirect('/settings?error=' + encodeURIComponent(error.message));
  }
});

// Change user password
router.post('/users/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.redirect('/settings?error=' + encodeURIComponent('Lösenordet måste vara minst 4 tecken'));
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: Number(req.params.id) },
      data: { passwordHash },
    });
    res.redirect('/settings?success=password_changed');
  } catch (error) {
    res.redirect('/settings?error=' + encodeURIComponent(error.message));
  }
});

// Delete user (cannot delete yourself)
router.post('/users/:id/delete', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (req.session.user && req.session.user.id === userId) {
      return res.redirect('/settings?error=' + encodeURIComponent('Du kan inte ta bort dig själv'));
    }
    await prisma.user.delete({ where: { id: userId } });
    res.redirect('/settings?success=user_deleted');
  } catch (error) {
    res.redirect('/settings?error=' + encodeURIComponent(error.message));
  }
});

module.exports = router;
