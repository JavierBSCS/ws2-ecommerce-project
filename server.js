// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const session = require('express-session'); // ✅ Added for user sessions
require('dotenv').config();
const passwordRoute = require('./routes/password');




const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (CSS, JS, images, etc.)
app.use(express.static('public'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');



// Session setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret', // keep secret in .env
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { secure: false 
      , maxAge: 15 * 60 * 1000
    }, // ✅ set true only in production with HTTPS
  })
);

// Routes
const indexRoute = require('./routes/index');
const usersRoute = require('./routes/users');
app.use('/', indexRoute);
app.use('/users', usersRoute);

// MongoDB Setup
const uri = process.env.MONGO_URI || process.env.MONGODB_URI; // ✅ fallback for naming
const client = new MongoClient(uri);

// Expose client & dbName to routes
app.locals.client = client;
app.locals.dbName = process.env.DB_NAME || 'ecommerceDB';

async function main() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB Atlas');

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
  }
}

app.use('/password', passwordRoute);

const path = require('path');
console.log("Serving static files from:", path.join(__dirname, 'public'));
app.use(express.static(path.join(__dirname, 'public')));


main();
