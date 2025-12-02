// server.js - FIXED VERSION
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
const adminReportsRoute = require("./routes/adminReports");
// MIDDLEWARE
const requireLogin = require('./middleware/requireLogin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ================================
// VIEW ENGINE & STATIC FILES
// ================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Make sure this is set
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // Add this for JSON parsing

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
// DEBUG MIDDLEWARE - ADD THIS
// ================================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ================================
// ROUTES (CORRECT ORDER)
// ================================

// 1️⃣ PUBLIC PRODUCT ROUTES FIRST
app.use("/products", productsRoute);

// 2️⃣ CART ROUTES
app.use("/cart", cartRoute);

// CHECKOUT ROUTE - SINGLE DEFINITION (UPDATED WITH QR CODE AND PHONE NUMBER)
app.get("/checkout", requireLogin, async (req, res) => {
  console.log("🔍 GET /checkout route hit");
  console.log("📦 Cart contents:", req.session.cart);
  console.log("👤 User:", req.session.user);
  
  const cart = req.session.cart || [];
  
  if (cart.length === 0) {
    console.log("❌ Cart is empty, redirecting to /cart");
    return res.redirect("/cart");
  }

  try {
    // Get QR code and phone number from database
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const settingsCol = db.collection("settings");
    const qrSetting = await settingsCol.findOne({ key: "gcash_qr_code" });
    const phoneSetting = await settingsCol.findOne({ key: "gcash_phone_number" });
    
    console.log("📱 QR Code found:", qrSetting ? "Yes" : "No");
    console.log("📞 Phone number found:", phoneSetting ? phoneSetting.value : "Not found, using default");
    
    // Calculate totals for display
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const tax = subtotal * 0.12;
    const total = subtotal + tax;
    
    console.log("💰 Calculated totals:", { subtotal, tax, total });
    
    // Render from customer folder
    res.render("customer/checkout", {
      title: "Checkout",
      cart: cart,
      subtotal: subtotal.toFixed(2),
      tax: tax.toFixed(2),
      total: total.toFixed(2),
      qrCodeImage: qrSetting ? qrSetting.value : null,
      gcashNumber: phoneSetting ? phoneSetting.value : "0917 123 4567" // Pass phone number to template
    });
    console.log("✅ Checkout page rendered successfully from customer folder");
  } catch (err) {
    console.error("❌ Error rendering checkout page:", err);
    res.status(500).send("Error loading checkout page");
  }
});

// 4️⃣ ORDERS ROUTES - THIS CONTAINS POST /orders/checkout
app.use("/orders", ordersRoute);

// 5️⃣ USERS ROUTES
app.use('/users', usersRoute);

// 6️⃣ OTHER ROUTES
app.use('/password', passwordRoute);
app.use("/admin", adminOrdersRoute);

// 7️⃣ INDEX ROUTE
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
// is Admin
// ================================
app.use("/admin", adminReportsRoute); 

// ================================
// MONGO SETUP
// ================================
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
const client = new MongoClient(uri);

app.locals.client = client;
app.locals.dbName = process.env.DB_NAME || "ecommerceDB";

// ================================
// 404 HANDLER (ADD THIS)
// ================================
app.use((req, res) => {
  res.status(404).render('404', { title: "Page Not Found", user: res.locals.user });
});

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