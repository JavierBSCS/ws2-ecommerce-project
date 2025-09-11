const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const saltRounds = 12;
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const requireLogin = require('../middleware/auth');

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

    // Build dynamic verification URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/users/verify/${token}`;

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

    // Send verification email
    const result = await resend.emails.send({
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

    console.log("📧 Resend response:", result);

    res.send(`
      <h2>✅ Registration Successful!</h2>
      <p>Please check your email (${newUser.email}) to verify your account.</p>
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
router.get('/login', (req, res) => {
  const expired = req.query.expired === '1'; // ✅ detect expired session
  const logout = req.query.logout === '1';   // ✅ detect logout
  res.render('login', { 
    title: "Login", 
    expired: expired, 
    logout: logout, 
    error: null 
  }); 
});


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
      // Store session with isEmailVerified included
      req.session.user = {
        userId: user.userId,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified
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
    // redirect with logout=1
    res.redirect('/users/login?logout=1');
  });
});


module.exports = router;
