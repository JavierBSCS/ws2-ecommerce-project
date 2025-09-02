const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000; // Use the PORT from Render or fallback to 3000 locally

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Routes
const indexRoute = require('./routes/index');
const usersRoute = require('./routes/users');   // ✅ Import users.js
app.use('/', indexRoute);
app.use('/users', usersRoute);                  // ✅ Mount at /users

// MongoDB Setup
const uri = process.env.MONGODB_URI;   // ✅ Match with .env
const client = new MongoClient(uri);
const dbName = "ecommerceDB";

async function main() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");

    // Start server
    app.listen(port, () => {
      console.log(`🚀 Server running at http://localhost:${port}`); // You may want to adjust this message during deployment to Render
    });
  } catch (err) {
    console.error("❌ MongoDB connection failed", err);
  }
}

main();
