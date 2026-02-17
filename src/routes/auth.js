const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const router = Router();
const prisma = new PrismaClient();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { layout: false, error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !await bcrypt.compare(password, user.passwordHash)) {
    return res.render('login', { layout: false, error: 'Fel e-post eller lösenord' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
