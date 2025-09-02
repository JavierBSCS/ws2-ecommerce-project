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
      createdAt: currentDate,
      updatedAt: currentDate,
    };

    await usersCollection.insertOne(newUser);

    res.send(`
      <h2>✅ Registration Successful!</h2>
      <p>User ${newUser.firstName} ${newUser.lastName} registered with ID: ${newUser.userId}</p>
      <a href="/users/login">Proceed to Login</a>
    `);
  } catch (err) {
    console.error("❌ Error saving user:", err);
    res.send("Something went wrong.");
  }
});

// ================== LOGIN ==================
router.get('/login', (req, res) => {
  res.render('login', { title: "Login" });
});

router.post('/login', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ email: req.body.email });
    if (!user) return res.send("❌ Invalid email or password.");

    const match = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!match) return res.send("❌ Invalid email or password.");

    // Save session
    req.session.user = {
      id: user.userId,
      email: user.email,
      role: user.role,
    };

    res.send(`
      <h2>✅ Login Successful!</h2>
      <p>Welcome back, ${user.firstName}!</p>
      <a href="/users/list">View Users</a>
    `);
  } catch (err) {
    console.error("❌ Error logging in:", err);
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

// ================== LOGOUT ==================
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/users/login');
  });
});

module.exports = router;
