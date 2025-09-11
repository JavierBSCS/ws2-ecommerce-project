const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const saltRounds = 12;

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// ================== SHOW FORGOT PASSWORD FORM ==================
router.get('/forgot', (req, res) => {
  res.render('forgot-password', { title: "Forgot Password" });
});

// ================== HANDLE FORGOT PASSWORD ==================
router.post('/forgot', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ email: req.body.email });
    if (!user) {
      return res.send("No account found with this email.");
    }

    // Generate reset token and expiry (1 hour)
    const token = uuidv4();
    const expiry = new Date(Date.now() + 3600000);

    await usersCollection.updateOne(
      { email: user.email },
      { $set: { resetToken: token, resetExpiry: expiry } }
    );

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const resetUrl = `${baseUrl}/password/reset/${token}`;

    // Send email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: user.email,
      subject: 'Password Reset Request',
      html: `
        <h2>Password Reset</h2>
        <p>Click below to reset your password:</p>
        <a href="${resetUrl}">${resetUrl}</a>
      `
    });

    res.send("If an account with that email exists, a reset link has been sent.");
  } catch (err) {
    console.error("Error in password reset:", err);
    res.send("Something went wrong.");
  }
});

// ================== SHOW RESET PASSWORD FORM ==================
router.get('/reset/:token', (req, res) => {
  res.render('reset-password', { title: "Reset Password", token: req.params.token });
});

// ================== HANDLE RESET PASSWORD ==================
router.post('/reset/:token', async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({
      resetToken: req.params.token,
      resetExpiry: { $gt: new Date() }
    });

    if (!user) {
      return res.send("Reset link is invalid or has expired.");
    }

    if (req.body.password !== req.body.confirm) {
      return res.send("Passwords do not match.");
    }

    const hashedPassword = await bcrypt.hash(req.body.password, saltRounds);

    await usersCollection.updateOne(
      { email: user.email },
      {
        $set: { passwordHash: hashedPassword, updatedAt: new Date() },
        $unset: { resetToken: "", resetExpiry: "" }
      }
    );

    // ✅ Redirect back to login with a success flag
    res.redirect('/users/login?reset=1');

  } catch (err) {
    console.error("Error resetting password:", err);
    res.send("Something went wrong.");
  }
});

module.exports = router;
