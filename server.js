// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const session = require('express-session'); 
const path = require('path');
require('dotenv').config();

const passwordRoute = require('./routes/password');
const indexRoute = require('./routes/index');
const usersRoute = require('./routes/users');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Serve static files (CSS, JS, images, etc.)
console.log("Serving static files from:", path.join(__dirname, 'public'));
app.use(express.static(path.join(__dirname, 'public')));

// Session setup (must come before res.locals)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { secure: false, maxAge: 15 * 60 * 1000 }, 
  })
);

// Make session user available in all views
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  next();
});

// Routes
app.use('/', indexRoute);
app.use('/users', usersRoute);
app.use('/password', passwordRoute);

// MongoDB Setup
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
const client = new MongoClient(uri);

// Expose client & dbName to routes
app.locals.client = client;
app.locals.dbName = process.env.DB_NAME || 'ecommerceDB';

async function main() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB Atlas');

    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
  }
}

// 404 handler (must be the last route)
app.use((req, res, next) => {
if (req.path.startsWith('/api/')) {
return res.status(404).json({ error: 'Not Found', path: req.path })
}
res.status(404).render('404', { title: 'Page Not Found' })

})

// Error handler (after the 404 is fine; Express will skip 404 for thrown errors)
app.use((err, req, res, next) => {
console.error(err)
res.status(500).render('500', { title: 'Server Error' })
})

main();
