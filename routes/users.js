const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const saltRounds = 12;

// ================== REGISTER ==================
router.get('/register', (req, res) => {
  res.render('register', { title: "Register" });
});

router.post('/register', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    // Check if email already exists
    const existingUser = await usersCollection.findOne({ email: req.body.email });
    if (existingUser) return res.send("❌ User already exists with this email.");

    // Hash password
    const hashedPassword = await bcrypt.hash(req.body.password, saltRounds);
    const currentDate = new Date();
    const token = uuidv4();

    // Build new user object
    const newUser = {
      userId: uuidv4(),
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      passwordHash: hashedPassword,
      role: 'customer', // default role
      accountStatus: 'active',
      isEmailVerified: false,
      verificationToken: token, // for email verification
      tokenExpiry: new Date(Date.now() + 3600000), // expires in 1 hour
      createdAt: currentDate,
      updatedAt: currentDate,
    };

    await usersCollection.insertOne(newUser);

    res.send(`
      <h2>✅ Registration Successful!</h2>
      <p>Please verify your account before logging in.</p>
      <p><a href="/users/verify/${token}">Click here to verify</a></p>
    `);
  } catch (err) {
    console.error("❌ Error saving user:", err);
    res.send("Something went wrong.");
  }
});

// ================== VERIFY EMAIL ==================
router.get('/verify/:token', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    // Find user with matching token
    const user = await usersCollection.findOne({ verificationToken: req.params.token });
    if (!user) return res.send("❌ Invalid or expired verification link.");

    // Check if token is expired
    if (user.tokenExpiry < new Date()) {
      return res.send("⏰ Verification link has expired. Please register again.");
    }

    // Mark as verified + remove token/expiry
    await usersCollection.updateOne(
      { verificationToken: req.params.token },
      { $set: { isEmailVerified: true }, $unset: { verificationToken: "", tokenExpiry: "" } }
    );

    res.send(`
      <h2>✅ Email Verified!</h2>
      <p>Your account has been verified successfully.</p>
      <a href="/users/login">Proceed to Login</a>
    `);
  } catch (err) {
    console.error("❌ Error verifying user:", err);
    res.send("Something went wrong during verification.");
  }
});

// ================== LOGIN ==================
// Show login form
router.get('/login', (req, res) => {
  res.render('login', { title: "Login" });
});

// Handle login form submission
router.post('/login', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    // Find user by email
    const user = await usersCollection.findOne({ email: req.body.email });
    if (!user) return res.send("❌ User not found.");

    // Check if account is active
    if (user.accountStatus !== 'active') return res.send("⚠️ Account is not active.");

    // Require email verification
    if (!user.isEmailVerified) {
      return res.send("📧 Please verify your email before logging in.");
    }

    // Compare hashed password
    const isPasswordValid = await bcrypt.compare(req.body.password, user.passwordHash);
    if (isPasswordValid) {
      // Store session
      req.session.user = {
        userId: user.userId,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role
      };
      res.redirect('/users/dashboard');
    } else {
      res.send("❌ Invalid password.");
    }
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
    res.render('users-list', { title: "Registered Users", users: users });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.send("Something went wrong.");
  }
});

// ================== DASHBOARD ==================
router.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/users/login');
  res.render('dashboard', { title: "User Dashboard", user: req.session.user });
});

// ================== ADMIN VIEW ==================
router.get('/admin', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send("Access denied.");
  }
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
    res.redirect('/users/login');
  });
});

module.exports = router;
