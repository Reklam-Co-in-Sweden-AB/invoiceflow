require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');
const path = require('path');

const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

// Routes
app.use('/', require('./routes/auth'));
app.use('/', requireAuth, require('./routes/dashboard'));
app.use('/invoices', requireAuth, require('./routes/invoices'));
app.use('/batches', requireAuth, require('./routes/batches'));
app.use('/hosting', requireAuth, require('./routes/hosting'));
app.use('/projects', requireAuth, require('./routes/projects'));
app.use('/customers', requireAuth, require('./routes/customers'));
app.use('/settings', requireAuth, require('./routes/settings'));
app.use('/api', requireAuth, require('./routes/api'));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`FakturaFlöde running on http://localhost:${PORT}`);
  });
}

module.exports = app;
