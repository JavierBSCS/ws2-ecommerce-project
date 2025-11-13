const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const saltRounds = 12;
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { ObjectId } = require('mongodb');
const requireLogin = require('../middleware/auth');
const verifyTurnstile = require('../utils/turnstileVerify'); // 🧠 Cloudflare Turnstile verification

// ================== REGISTER ==================
router.get('/register', (req, res) => {
  res.render('register', { title: "Register", error: null });
});

router.post('/register', async (req, res) => {
  try {
    // 🧠 Turnstile verification before processing
    const token = req.body['cf-turnstile-response'];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render('register', { title: "Register", error: "⚠️ Verification failed. Please try again." });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    // Check if email already exists
    const existingUser = await usersCollection.findOne({ email: req.body.email });
    if (existingUser) return res.send("❌ User already exists with this email.");

    // Hash password
    const hashedPassword = await bcrypt.hash(req.body.password, saltRounds);
    const currentDate = new Date();
    const tokenId = uuidv4();

    // Build dynamic verification URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/users/verify/${tokenId}`;

    const newUser = {
      userId: uuidv4(),
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      passwordHash: hashedPassword,
      role: 'customer',
      accountStatus: 'active',
      isEmailVerified: false,
      verificationToken: tokenId,
      tokenExpiry: new Date(Date.now() + 3600000),
      createdAt: currentDate,
      updatedAt: currentDate,
    };

    await usersCollection.insertOne(newUser);

    // Send verification email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: newUser.email,
      subject: "Verify your account",
      html: `
        <h2>Hello ${newUser.firstName},</h2>
        <p>Thank you for registering! Please verify your email by clicking the link below:</p>
        <a href="${verificationUrl}">${verificationUrl}</a>
        <p>This link will expire in 1 hour.</p>
      `,
    });

    res.redirect('/users/login?registered=1');
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

    // Check if token expired
    if (user.tokenExpiry < new Date()) {
      return res.send("⏰ Verification link has expired. Please register again.");
    }

    // Mark verified
    await usersCollection.updateOne(
      { verificationToken: req.params.token },
      { $set: { isEmailVerified: true }, $unset: { verificationToken: "", tokenExpiry: "" } }
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
    const existingUser = await usersCollection.findOne({ email: email });
    if (existingUser && existingUser.userId !== req.params.userId) {
      return res.send("❌ This email is already associated with another account.");
    }

    // Update user in DB
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

    // 🧠 Fetch updated user and refresh session
    const updatedUser = await usersCollection.findOne({ userId: req.params.userId });
    req.session.user = {
      userId: updatedUser.userId,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      email: updatedUser.email,
      role: updatedUser.role,
      isEmailVerified: updatedUser.isEmailVerified
    };

    // Save session before redirect
    req.session.save((err) => {
      if (err) {
        console.error("❌ Error saving session:", err);
      }
      res.redirect('/users/dashboard');
    });

  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.send("Something went wrong while updating profile.");
  }
});

// ================== LOGIN ==================
router.get('/login', (req, res) => {
  const expired = req.query.expired === '1';
  const logout = req.query.logout === '1';
  const reset = req.query.reset === '1';
  const verified = req.query.verified === '1';
  const registered = req.query.registered === '1';

  res.render('login', {
    title: "Login",
    expired,
    logout,
    reset,
    verified,
    registered,
    error: null
  });
});

router.post('/login', async (req, res) => {
  try {
    // 🧠 Turnstile verification before login
    const token = req.body['cf-turnstile-response'];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render('login', {
        title: "Login",
        error: "⚠️ Verification failed. Please try again.",
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
    if (user.accountStatus !== 'active') return res.send("⚠️ Account is not active.");
    if (!user.isEmailVerified) return res.send("📧 Please verify your email before logging in.");

    const isPasswordValid = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!isPasswordValid) return res.send("❌ Invalid password.");

    // Save session
    req.session.user = {
      userId: user.userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified
    };

    res.redirect('/users/dashboard');
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
    console.error("❌ Error fetching users:", err);
    res.send("Something went wrong.");
  }
});

// ================== DASHBOARD ==================
router.get('/dashboard', requireLogin, (req, res) => {
  res.render('dashboard', { title: "User Dashboard", user: req.session.user });
});

// ================== ADMIN VIEW ==================
router.get('/admin', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') {
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
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.send("Something went wrong during logout.");
    }
    res.redirect('/users/login?logout=1');
  });
});

// ================== 404 HANDLER ==================
router.use((req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

module.exports = router;
