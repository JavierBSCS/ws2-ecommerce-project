const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const saltRounds = 12;
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { ObjectId } = require('mongodb');
const requireLogin = require('../middleware/auth');
const verifyTurnstile = require('../utils/turnstileVerify');
const upload = require("../middleware/upload");

// ================== PROFILE ==================
router.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { user: req.session.user });
});

// ================== REGISTER ==================
router.get('/register', (req, res) => {
  res.render('register', { title: "Register", error: null });
});

router.post('/register', async (req, res) => {
  try {
    const token = req.body['cf-turnstile-response'];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render('register', {
        title: "Register",
        error: "⚠️ Verification failed. Please try again."
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const existingUser = await usersCollection.findOne({ email: req.body.email });
    if (existingUser) return res.send("❌ User already exists with this email.");

    const hashedPassword = await bcrypt.hash(req.body.password, saltRounds);

    const tokenId = uuidv4();
    const currentDate = new Date();

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const verificationUrl = `${baseUrl}/users/verify/${tokenId}`;

    const newUser = {
      userId: uuidv4(),
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      passwordHash: hashedPassword,
      role: "customer",
      accountStatus: "active",
      isEmailVerified: false,
      verificationToken: tokenId,
      tokenExpiry: new Date(Date.now() + 3600000),
      createdAt: currentDate,
      updatedAt: currentDate
    };

    await usersCollection.insertOne(newUser);

    // send verification email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: newUser.email,
      subject: "Verify your account",
      html: `
        <h2>Hello ${newUser.firstName},</h2>
        <p>Thank you for registering! Please verify your email:</p>
        <a href="${verificationUrl}">${verificationUrl}</a>
      `
    });

    res.redirect('/users/login?registered=1');

  } catch (err) {
    console.error("❌ Error saving user:", err);
    res.send("Something went wrong.");
  }
});

//ORDER HISTORY
router.get("/orders/history", requireLogin, async (req, res) => {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");

    const orders = await ordersCol
        .find({ userId: req.session.user.userId })
        .sort({ createdAt: -1 })
        .toArray();

    res.render("orders-history", {
        title: "My Orders",
        orders
    });
});


// ================== VERIFY EMAIL ==================
router.get('/verify/:token', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ verificationToken: req.params.token });
    if (!user) return res.send("❌ Invalid or expired verification link.");

    if (user.tokenExpiry < new Date()) {
      return res.send("⏰ Verification link expired. Register again.");
    }

    await usersCollection.updateOne(
      { verificationToken: req.params.token },
      {
        $set: { isEmailVerified: true },
        $unset: { verificationToken: "", tokenExpiry: "" }
      }
    );

    res.redirect('/users/login?verified=1');

  } catch (err) {
    console.error("❌ Error verifying user:", err);
    res.send("Something went wrong during verification.");
  }
});

// ================== EDIT USER ==================
router.get('/edit-user/:userId', requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    if (req.session.user.userId !== req.params.userId) {
      return res.status(403).send("❌ You can only edit your own profile.");
    }

    const user = await usersCollection.findOne({ userId: req.params.userId });
    if (!user) return res.send("❌ User not found.");

    res.render('edit-user', { title: "Edit Profile", user });

  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.send("Something went wrong.");
  }
});

router.post('/edit-user/:userId', requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    if (req.session.user.userId !== req.params.userId) {
      return res.status(403).send("❌ You can only edit your own profile.");
    }

    const { firstName, lastName, email } = req.body;

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser && existingUser.userId !== req.params.userId) {
      return res.send("❌ Email already in use.");
    }

    await usersCollection.updateOne(
      { userId: req.params.userId },
      {
        $set: {
          firstName,
          lastName,
          email,
          updatedAt: new Date()
        }
      }
    );

    const updatedUser = await usersCollection.findOne({ userId: req.params.userId });

    req.session.user = {
      userId: updatedUser.userId,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      email: updatedUser.email,
      role: updatedUser.role,
      isEmailVerified: updatedUser.isEmailVerified
    };

    req.session.save(() => {
      res.redirect("/users/profile");
    });

  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.send("Something went wrong.");
  }
});

// ================== LOGIN ==================
router.get('/login', (req, res) => {
  res.render('login', {
    title: "Login",
    expired: req.query.expired === '1',
    logout: req.query.logout === '1',
    reset: req.query.reset === '1',
    verified: req.query.verified === '1',
    registered: req.query.registered === '1',
    error: null
  });
});

router.post('/login', async (req, res) => {
  try {
    const token = req.body['cf-turnstile-response'];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render('login', {
        title: "Login",
        error: "⚠️ Verification failed.",
        expired: false,
        logout: false,
        reset: false,
        verified: false,
        registered: false
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ email: req.body.email });
    if (!user) return res.send("❌ User not found.");
    if (user.accountStatus !== "active") return res.send("⚠️ Account inactive.");
    if (!user.isEmailVerified) return res.send("📧 Verify email first.");

    const valid = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!valid) return res.send("❌ Invalid password.");

    req.session.user = {
      userId: user.userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified
    };

    res.redirect("/users/dashboard");

  } catch (err) {
    console.error("❌ Error during login:", err);
    res.send("Something went wrong.");
  }
});

// ================== LIST USERS ==================
router.get('/list', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');
    const users = await usersCollection.find().toArray();

    res.render('users-list', { title: "Registered Users", users });

  } catch (err) {
    console.error("❌ Fetch users error:", err);
    res.send("Something went wrong.");
  }
});

// ================== DASHBOARD (products shown) ==================
router.get('/dashboard', requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const products = await db.collection('products').find().toArray();

    // normalize images: ensure array
    const normalized = products.map(p => {
      const images = [];
      if (p.images && Array.isArray(p.images) && p.images.length) images.push(...p.images);
      if (p.imageUrl && typeof p.imageUrl === 'string' && p.imageUrl.trim()) images.push(p.imageUrl);
      return { ...p, images };
    });

    res.render('dashboard', {
      title: "User Dashboard",
      currentUser: req.session.user,
      products: normalized
    });
  } catch (err) {
    console.error("❌ Error loading dashboard:", err);
    res.send("Something went wrong.");
  }
});

// ================== ADMIN: PRODUCTS CRUD (using native MongoDB) ==================
/*
  Product document shape (advanced B):
  {
    _id: ObjectId,
    name: String,
    category: String,
    price: Number,
    stock: Number,
    images: [String],
    description: String,
    createdAt: Date
  }
*/

// List (manage) products (admin)
router.get('/admin/products', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const products = await db.collection('products').find().toArray();
    res.render('admin/manageProducts', { products, currentUser: req.session.user });
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    res.send("Something went wrong.");
  }
});

// Show add product form (admin)
router.get('/admin/products/add', requireLogin, (req, res) => {
  if (req.session.user.role !== "admin") return res.status(403).send("Access denied.");
  res.render('admin/addproduct', { title: "Add Product", currentUser: req.session.user });
});

// Handle add product (admin)
router.post('/admin/products/add', requireLogin, upload.single("image"), async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const { name, price, description, category, stock, status } = req.body;

    let imagesArr = [];

    // If image uploaded via file input
    if (req.file) {
      imagesArr.push("/uploads/" + req.file.filename);
    }

    let stockValue = parseInt(stock || "0", 10);
    let statusValue = status || "available";

    // Auto update status
    if (stockValue === 0 && statusValue !== "maintenance") {
      statusValue = "unavailable";
    }

    const product = {
      name: name || 'Untitled',
      category: category || 'General',
      price: parseFloat(price) || 0,
      stock: stockValue,
      status: statusValue,
      images: imagesArr,
      description: description || '',
      createdAt: new Date()
    };

    await db.collection('products').insertOne(product);

    res.redirect('/users/admin/products');
  } catch (err) {
    console.error("❌ Error adding product:", err);
    res.send("Something went wrong while creating product.");
  }
});


// Edit product form (admin)
router.get('/admin/products/edit/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const product = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.send("Product not found.");

    // flatten images to comma string for the form input
    const imagesCsv = (product.images && Array.isArray(product.images)) ? product.images.join(', ') : (product.imageUrl || '');
    res.render('admin/editProduct', { product: { ...product, imagesCsv }, currentUser: req.session.user });
  } catch (err) {
    console.error("❌ Error fetching product:", err);
    res.send("Something went wrong.");
  }
});

// Save edits (admin)
router.post('/admin/products/edit/:id', requireLogin, upload.single("image"), async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const { name, price, description, category, stock, status } = req.body;

    // Get existing product
    const product = await db.collection("products").findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.send("Product not found.");

    // Keep or modify images
    let imagesArr = Array.isArray(product.images) ? product.images : [];

    // If CSV given → replace list
    if (req.body.images && req.body.images.trim()) {
      imagesArr = req.body.images.split(",").map(s => s.trim());
    }

    // If file uploaded → replace first image
    if (req.file) {
      const newImagePath = "/uploads/" + req.file.filename;
      if (imagesArr.length > 0) {
        imagesArr[0] = newImagePath;
      } else {
        imagesArr.push(newImagePath);
      }
    }

    // Parse stock & status
    let stockValue = parseInt(stock || "0", 10);
    let statusValue = status || "available";

    // Auto-update status
    if (stockValue === 0 && statusValue !== "maintenance") {
      statusValue = "unavailable";
    }

    // Save everything
    await db.collection("products").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          name,
          description,
          category: category || "General",
          stock: stockValue,
          price: parseFloat(price) || 0,
          status: statusValue,
          images: imagesArr,
          updatedAt: new Date()
        }
      }
    );

    res.redirect("/users/admin/products");

  } catch (err) {
    console.error("❌ Error updating product:", err);
    res.send("Something went wrong while updating product.");
  }
});




// Delete product (admin)
router.get('/admin/products/delete/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    await db.collection('products').deleteOne({ _id: new ObjectId(req.params.id) });
    res.redirect('/users/admin/products');
  } catch (err) {
    console.error("❌ Error deleting product:", err);
    res.send("Something went wrong while deleting product.");
  }
});

// ================== ADMIN GENERAL PAGE ==================
router.get('/admin', requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin") return res.status(403).send("Access denied.");

  const db = req.app.locals.client.db(req.app.locals.dbName);
  const users = await db.collection('users').find().toArray();

  res.render('admin', {
    title: "Admin Dashboard",
    users,
    currentUser: req.session.user
  });
});

// ================== LOGOUT ==================
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/users/login?logout=1');
  });
});





// ================== 404 ==================
router.use((req, res) => {
  res.status(404).render('404', { title: "Page Not Found" });
});

module.exports = router;
