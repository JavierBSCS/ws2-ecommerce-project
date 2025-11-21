// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const path = require('path');
require('dotenv').config();
const mongoose = require("mongoose");

const ordersRoute = require("./routes/orders");
const adminOrdersRoute = require("./routes/adminOrders");

// ROUTES
const passwordRoute = require('./routes/password');
const indexRoute = require('./routes/index');
const productsRoute = require("./routes/products");
const usersRoute = require('./routes/users');
const cartRoute = require("./routes/cart");

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ================================
// VIEW ENGINE & STATIC FILES
// ================================
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// ================================
// SESSION CONFIG
// ================================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: false,
      maxAge: 15 * 60 * 1000
    }
  })
);

// Make logged-in user available in templates
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  next();
});

// ================================
// ROUTES (IMPORTANT ORDER)
// ================================

// 1️⃣ PUBLIC PRODUCT ROUTES FIRST
app.use("/products", productsRoute);

// 2️⃣ CART ROUTES
app.use("/cart", cartRoute);

// 3️⃣ USERS (contains its own 404 so must come later)
app.use('/users', usersRoute);

// 4️⃣ OTHER ROUTES
app.use('/password', passwordRoute);
app.use("/orders", ordersRoute);
app.use("/admin", adminOrdersRoute);

// 5️⃣ INDEX ROUTE
app.use('/', indexRoute);

// ================================
// SITEMAP
// ================================
app.get('/sitemap.xml', (req, res) => {
  const filePath = path.join(__dirname, 'sitemap.xml');
  res.type('application/xml');
  res.sendFile(filePath);
});

// ================================
// MONGO SETUP
// ================================
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
const client = new MongoClient(uri);

app.locals.client = client;
app.locals.dbName = process.env.DB_NAME || "ecommerceDB";

// ================================
// 500 ERROR HANDLER
// ================================
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.stack);
  res.status(500).render('500', { title: "Server Error", user: res.locals.user });
});

// ================================
// MONGOOSE CONNECT
// ================================
mongoose.connect(uri, { dbName: process.env.DB_NAME || "ecommerceDB" })
  .then(() => console.log("✅ Mongoose connected"))
  .catch(err => console.error("❌ Mongoose error:", err));

// ================================
// START SERVER
// ================================
async function main() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");

    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}

main();
