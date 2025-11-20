// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const path = require('path');
require('dotenv').config();
const mongoose = require("mongoose");




// ROUTES
const passwordRoute = require('./routes/password');
const indexRoute = require('./routes/index');
const usersRoute = require('./routes/users');

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
      secure: false,               // required for local development
      maxAge: 15 * 60 * 1000       // 15 minutes
    }
  })
);

// Make logged-in user available in templates
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  next();
});


// ================================
// ROUTES
// ================================
app.use('/', indexRoute);
app.use('/users', usersRoute);
app.use('/password', passwordRoute);


// ================================
// SITEMAP
// ================================
app.get('/sitemap.xml', (req, res) => {
  const filePath = path.join(__dirname, 'sitemap.xml');
  res.type('application/xml');

  res.sendFile(filePath, err => {
    if (err) {
      console.error("Error sending sitemap.xml:", err);
      res.status(500).send("Error loading sitemap");
    }
  });
});


// ================================
// MONGO SETUP
// ================================
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
const client = new MongoClient(uri);

// Make Mongo available inside route files
app.locals.client = client;
app.locals.dbName = process.env.DB_NAME || "ecommerceDB";


app.use("/cart", require("./routes/cart"));


// ================================
// 500 (SERVER ERROR)
// ================================
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.stack);

  if (res.headersSent) return next(err);

  res.status(500).render('500', {
    title: "Server Error",
    user: res.locals.user || null
  });
});

// ================================
// MONGOOSE SETUP
// ================================
mongoose.connect(uri, {
  dbName: process.env.DB_NAME || "ecommerceDB"
})
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
