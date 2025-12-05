const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const saltRounds = 12;
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
const { ObjectId } = require("mongodb");
const requireLogin = require("../middleware/auth");
const verifyTurnstile = require("../utils/turnstileVerify");
const upload = require("../middleware/upload");
const uploadProfile = require("../middleware/uploadProfile");
const fs = require("fs");
const path = require("path");
const uploadProduct = require("../middleware/uploadProduct");


function getDb(req) {
    return req.app.locals.client.db(req.app.locals.dbName);
}
// =======================================================================
//  PROFILE PAGE - FIXED VERSION
// =======================================================================
router.get("/profile", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");
    
    // Fetch complete user data from database, not just session
    const user = await usersCollection.findOne({ userId: req.session.user.userId });

    if (!user) {
      return res.status(404).send("❌ User not found");
    }

    // Ensure all address fields have values
    const userData = {
      ...user,
      address: user.address || '',
      province: user.province || '',
      city: user.city || '',
      zip: user.zip || '',
      phone: user.phone || ''
    };

    res.render("profile", { 
      user: userData,
      passwordChanged: req.query.passwordChanged,
      editSuccess: req.query.editSuccess // ADD THIS
    });
  } catch (err) {
    console.error("❌ Profile error:", err);
    res.status(500).send("Error loading profile");
  }
});

// =======================================================================
//  EDIT USER (GET)
// =======================================================================
router.get("/edit-user/:userId", requireLogin, async (req, res) => {
  try {
    if (req.session.user.userId !== req.params.userId) {
      return res.status(403).send("❌ You can only edit your own profile.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");
    const user = await usersCollection.findOne({ userId: req.params.userId });

    if (!user) return res.send("❌ User not found.");

    res.render("edit-user", { title: "Edit Profile", user });
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.send("Something went wrong.");
  }
});


// =======================================================================
//  EDIT USER (POST) — WITH PROFILE IMAGE UPLOAD
// =======================================================================
router.post(
  "/edit-user/:userId",
  requireLogin,
  uploadProfile.single("avatar"),
  async (req, res) => {
    try {
      if (req.session.user.userId !== req.params.userId) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(403).send("❌ You can only edit your own profile.");
      }

      const db = req.app.locals.client.db(req.app.locals.dbName);
      const usersCollection = db.collection("users");

      const { firstName, lastName, email, address, province, city, zip, phone } = req.body;

      // email must be unique
      const emailCheck = await usersCollection.findOne({ email });
      if (emailCheck && emailCheck.userId !== req.params.userId) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.send("❌ Email already in use.");
      }

      const updateObj = {
        firstName,
        lastName,
        address: address || '',
        province: province || '',
        city: city || '',
        zip: zip || '',
        phone: phone || '',
        updatedAt: new Date(),
      };

      // Handle new uploaded profile image
      if (req.file) {
        const publicPath = "/uploads/profile-pics/" + req.file.filename;
        updateObj.profileImage = publicPath;

        // delete previous pfp
        const existing = await usersCollection.findOne({
          userId: req.params.userId,
        });

        if (existing && existing.profileImage) {
          const oldPath = path.join(
            __dirname,
            "..",
            "public",
            existing.profileImage.replace(/^\/+/, "")
          );

          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
      }

      await usersCollection.updateOne(
        { userId: req.params.userId },
        { $set: updateObj }
      );

      const updatedUser = await usersCollection.findOne({
        userId: req.params.userId,
      });

      req.session.user = {
        userId: updatedUser.userId,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        role: updatedUser.role,
        isEmailVerified: updatedUser.isEmailVerified,
        profileImage: updatedUser.profileImage || null,
        address: updatedUser.address || '',
        province: updatedUser.province || '',
        city: updatedUser.city || '',
        zip: updatedUser.zip || '',
        phone: updatedUser.phone || ''
      };

      req.session.save(() => {
        // ADD SUCCESS PARAMETER HERE
        res.redirect("/users/profile?editSuccess=1");
      });
    } catch (err) {
      console.error("❌ Error updating user:", err);

      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (err) {}
      }

      res.send("Something went wrong.");
    }
  }
);

// =======================================================================
//  ADMIN: MANAGE USERS (GET)
// =======================================================================
router.get("/admin/users", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const usersCollection = db.collection("users");
        
        // Search filters
        const searchName = (req.query.searchName || "").trim();
        const searchRole = (req.query.searchRole || "").trim();
        const searchStatus = (req.query.searchStatus || "").trim();
        
        const query = {};
        
        // Name search (search in firstName and lastName)
        if (searchName) {
            query.$or = [
                { firstName: { $regex: searchName, $options: "i" } },
                { lastName: { $regex: searchName, $options: "i" } },
                { email: { $regex: searchName, $options: "i" } }
            ];
        }
        
        // Role filter
        if (searchRole) {
            query.role = searchRole;
        }
        
        // Status filter
        if (searchStatus) {
            if (searchStatus === "active") {
                query.accountStatus = "active";
            } else if (searchStatus === "inactive") {
                query.accountStatus = "inactive";
            } else if (searchStatus === "verified") {
                query.isEmailVerified = true;
            } else if (searchStatus === "unverified") {
                query.isEmailVerified = false;
            }
        }

        const users = await usersCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        // Calculate stats
        const stats = {
            total: users.length,
            admin: users.filter(u => u.role === "admin").length,
            customer: users.filter(u => u.role === "customer").length,
            active: users.filter(u => u.accountStatus === "active").length,
            inactive: users.filter(u => u.accountStatus === "inactive").length,
            verified: users.filter(u => u.isEmailVerified).length,
            unverified: users.filter(u => !u.isEmailVerified).length
        };

        // Success messages
        const success = req.query.success;
        const action = req.query.action;
        let message = null;
        
        if (success == "1" && action == "updated") {
            message = {
                type: "success",
                text: "User updated successfully."
            };
        } else if (success == "1" && action == "deleted") {
            message = {
                type: "success",
                text: "User deleted successfully."
            };
        } else if (success == "1" && action == "status") {
            message = {
                type: "success",
                text: "User status updated successfully."
            };
        }

        res.render("admin/manageUsers", {
            title: "Manage Users",
            users,
            currentUser: req.session.user,
            stats,
            message,
            searchName,
            searchRole,
            searchStatus,
            highlightedUser: req.query.highlight || null
        });

    } catch (err) {
        console.error("❌ Manage users error:", err);
        res.status(500).send("Error loading users.");
    }
});

// =======================================================================
//  ADMIN: EDIT USER (GET)
// =======================================================================
router.get("/admin/users/edit/:userId", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const usersCollection = db.collection("users");

        const user = await usersCollection.findOne({ 
            userId: req.params.userId 
        });

        if (!user) return res.status(404).send("User not found.");

        // List of available roles
        const availableRoles = ["customer", "admin"];
        
        // List of account statuses
        const accountStatuses = ["active", "inactive"];

        res.render("admin/editUser", {
            title: "Edit User",
            user,
            currentUser: req.session.user,
            availableRoles,
            accountStatuses,
            errors: [],
            formData: {}
        });

    } catch (err) {
        console.error("❌ Edit user error:", err);
        res.status(500).send("Error loading user.");
    }
});

// =======================================================================
//  ADMIN: EDIT USER (POST)
// =======================================================================
router.post("/admin/users/edit/:userId", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const usersCollection = db.collection("users");

        const { 
            firstName, 
            lastName, 
            email, 
            role, 
            accountStatus,
            phone,
            address,
            city,
            province,
            zip 
        } = req.body;

        // Validation
        const errors = [];
        
        if (!firstName?.trim()) errors.push("First name is required.");
        if (!lastName?.trim()) errors.push("Last name is required.");
        if (!email?.trim()) errors.push("Email is required.");
        
        // Check if email is already taken by another user
        const existingUser = await usersCollection.findOne({ 
            email: email.trim(),
            userId: { $ne: req.params.userId }
        });
        
        if (existingUser) {
            errors.push("Email is already in use by another account.");
        }

        if (errors.length > 0) {
            const user = await usersCollection.findOne({ 
                userId: req.params.userId 
            });
            
            return res.render("admin/editUser", {
                title: "Edit User",
                user,
                currentUser: req.session.user,
                availableRoles: ["customer", "admin"],
                accountStatuses: ["active", "inactive"],
                errors,
                formData: req.body
            });
        }

        // Update user
        const updateData = {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            role: role || "customer",
            accountStatus: accountStatus || "active",
            phone: phone?.trim() || "",
            address: address?.trim() || "",
            city: city?.trim() || "",
            province: province?.trim() || "",
            zip: zip?.trim() || "",
            updatedAt: new Date()
        };

        // Update password only if provided
        if (req.body.password && req.body.password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(req.body.password.trim(), saltRounds);
            updateData.passwordHash = hashedPassword;
        }

        await usersCollection.updateOne(
            { userId: req.params.userId },
            { $set: updateData }
        );

        // Redirect with success message
        res.redirect(`/users/admin/users?success=1&action=updated&highlight=${req.params.userId}`);

    } catch (err) {
        console.error("❌ Update user error:", err);
        res.status(500).send("Error updating user.");
    }
});

// =======================================================================
//  ADMIN: DELETE USER (GET)
// =======================================================================
router.get("/admin/users/delete/:userId", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const usersCollection = db.collection("users");
        const ordersCollection = db.collection("orders");

        const userId = req.params.userId;

        // Prevent admin from deleting themselves
        if (userId === req.session.user.userId) {
            return res.redirect("/users/admin/users?error=cannot_delete_self");
        }

        // Check if user has orders
        const userOrders = await ordersCollection.findOne({ userId });
        
        if (userOrders) {
            // User has orders, we'll just deactivate instead of delete
            await usersCollection.updateOne(
                { userId },
                { $set: { accountStatus: "inactive", updatedAt: new Date() } }
            );
            
            return res.redirect("/users/admin/users?success=1&action=status&highlight=" + userId);
        } else {
            // User has no orders, safe to delete
            await usersCollection.deleteOne({ userId });
            return res.redirect("/users/admin/users?success=1&action=deleted");
        }

    } catch (err) {
        console.error("❌ Delete user error:", err);
        res.status(500).send("Error deleting user.");
    }
});



// =======================================================================
//  CHANGE PASSWORD (POST)
// =======================================================================
router.post("/change-password/:userId", requireLogin, async (req, res) => {
  try {
    if (req.session.user.userId !== req.params.userId) {
      return res.status(403).send("❌ You can only change your own password.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");

    const { oldPassword, newPassword, confirmPassword } = req.body;

    // Get current user
    const user = await usersCollection.findOne({ userId: req.params.userId });
    if (!user) {
      return res.send("❌ User not found.");
    }

    // Validate old password
    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isOldPasswordValid) {
      return res.send("❌ Current password is incorrect.");
    }

    // Validate new password
    if (newPassword.length < 8) {
      return res.send("❌ New password must be at least 8 characters long.");
    }

    if (newPassword !== confirmPassword) {
      return res.send("❌ New passwords do not match.");
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password in database
    await usersCollection.updateOne(
      { userId: req.params.userId },
      { 
        $set: { 
          passwordHash: hashedPassword,
          updatedAt: new Date()
        } 
      }
    );

    // Redirect to profile with success message
    res.redirect("/users/profile?passwordChanged=1");
    
  } catch (err) {
    console.error("❌ Change password error:", err);
    res.send("Something went wrong.");
  }
});

// =======================================================================
//  REGISTER (GET) - UPDATED
// =======================================================================
router.get("/register", (req, res) => {
  res.render("register", { 
    title: "Register", 
    formData: {},  // Add this
    message: null  // Add this
  });
});


// =======================================================================
//  REGISTER (POST) - UPDATED WITH TERMS VALIDATION
// =======================================================================
router.post("/register", async (req, res) => {
  try {
    const token = req.body["cf-turnstile-response"];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render("register", {
        title: "Register",
        message: {
          type: "error",
          text: "⚠️ Verification failed. Please try again.",
        },
        formData: req.body  // Pass the form data back
      });
    }

    // Check if terms were accepted
    if (!req.body.terms || req.body.terms !== 'on') {
      return res.status(400).render("register", {
        title: "Register",
        message: {
          type: "error",
          text: "⚠️ You must accept the terms and conditions.",
        },
        formData: req.body  // Pass the form data back
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");

    const existingUser = await usersCollection.findOne({
      email: req.body.email,
    });
    
    if (existingUser) {
      return res.status(400).render("register", {
        title: "Register",
        message: {
          type: "error",
          text: "❌ Email already registered.",
        },
        formData: req.body  // Pass the form data back
      });
    }

    // Additional password validation (server-side)
    const password = req.body.password;
    const passwordErrors = [];
    
    if (password.length < 8) passwordErrors.push("Password must be at least 8 characters");
    if (!/[A-Z]/.test(password)) passwordErrors.push("Password must contain at least one uppercase letter");
    if (!/[a-z]/.test(password)) passwordErrors.push("Password must contain at least one lowercase letter");
    if (!/[0-9]/.test(password)) passwordErrors.push("Password must contain at least one number");
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) passwordErrors.push("Password must contain at least one special character");
    
    if (passwordErrors.length > 0) {
      return res.status(400).render("register", {
        title: "Register",
        message: {
          type: "error",
          text: `Password validation failed: ${passwordErrors.join(", ")}`,
        },
        formData: req.body
      });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const verificationToken = uuidv4();
    const now = new Date();

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const verifyURL = `${baseUrl}/users/verify/${verificationToken}`;

    const newUser = {
      userId: uuidv4(),
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      passwordHash: hashedPassword,
      role: "customer",
      accountStatus: "active",
      isEmailVerified: false,
      verificationToken,
      tokenExpiry: new Date(Date.now() + 3600000),
      // Add address fields with empty defaults
      address: '',
      province: '',
      city: '',
      zip: '',
      phone: '',
      createdAt: now,
      updatedAt: now,
    };

    await usersCollection.insertOne(newUser);

    // send verification email
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: newUser.email,
        subject: "Verify Your Email",
        html: `
          <h2>Hello ${newUser.firstName},</h2>
          <p>Please verify your email:</p>
          <a href="${verifyURL}">${verifyURL}</a>
          <p>Click the link above or copy and paste it into your browser.</p>
          <p>This link will expire in 1 hour.</p>
        `,
      });
    } catch (emailError) {
      console.error("❌ Email sending error:", emailError);
      // Continue even if email fails
    }

    res.redirect("/users/login?registered=1");
    
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).render("register", {
      title: "Register",
      message: {
        type: "error",
        text: "❌ An error occurred during registration. Please try again.",
      },
      formData: req.body  // Pass the form data back
    });
  }
});

// =======================================================================
//  VERIFY EMAIL
// =======================================================================
router.get("/verify/:token", async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");

    const user = await usersCollection.findOne({
      verificationToken: req.params.token,
    });

    if (!user) return res.send("❌ Invalid token.");

    if (user.tokenExpiry < new Date()) {
      return res.send("⏰ Verification link expired.");
    }

    await usersCollection.updateOne(
      { verificationToken: req.params.token },
      {
        $set: { isEmailVerified: true },
        $unset: { verificationToken: "", tokenExpiry: "" },
      }
    );

    res.redirect("/users/login?verified=1");
  } catch (err) {
    console.error("❌ Verify error:", err);
    res.send("Something went wrong.");
  }
});


// =======================================================================
//  LOGIN (GET)
// =======================================================================
router.get("/login", (req, res) => {
  res.render("login", {
    title: "Login",
    expired: req.query.expired === "1",
    logout: req.query.logout === "1",
    reset: req.query.reset === "1",
    verified: req.query.verified === "1",
    registered: req.query.registered === "1",
    error: null,
  });
});


// =======================================================================
//  LOGIN (POST) - UPDATED WITH REACTIVATION
// =======================================================================
router.post("/login", async (req, res) => {
  try {
    const token = req.body["cf-turnstile-response"];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render("login", {
        title: "Login",
        error: "⚠️ Verification failed.",
        expired: false,
        logout: false,
        reset: false,
        verified: false,
        registered: false,
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");

    const user = await usersCollection.findOne({ email: req.body.email });

    if (!user) return res.send("❌ User not found.");
    if (!user.isEmailVerified) return res.send("📧 Verify email first.");
    
    // CHECK IF ACCOUNT IS INACTIVE
    if (user.accountStatus !== "active") {
      // Return JSON for AJAX handling or render page with modal trigger
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.json({ 
          inactive: true, 
          message: "Account inactive. Would you like to request reactivation?",
          email: user.email 
        });
      }
      
      // Regular form submission - show reactivation option
      return res.render("login", {
        title: "Login",
        error: `⚠️ Account inactive. <button type="button" onclick="showReactivationModal('${user.email}')" 
                style="background: var(--accent-blue); color: white; border: none; padding: 5px 15px; 
                border-radius: 5px; cursor: pointer; margin-left: 10px;">
                Request Reactivation</button>`,
        expired: false,
        logout: false,
        reset: false,
        verified: false,
        registered: false,
      });
    }

    const isValid = await bcrypt.compare(
      req.body.password,
      user.passwordHash
    );

    if (!isValid) return res.send("❌ Wrong password.");

    // Save session
    req.session.user = {
      userId: user.userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      profileImage: user.profileImage || null,
    };

    res.redirect("/users/dashboard");
  } catch (err) {
    console.error("❌ Login error:", err);
    res.send("Something went wrong.");
  }
});

// =======================================================================
//  REQUEST REACTIVATION (POST) - User requests account reactivation
// =======================================================================
router.post("/request-reactivation", async (req, res) => {
  try {
    const { email, reason } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: "Email is required." 
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");
    const reactivationCollection = db.collection("reactivation_requests");

    // Check if user exists
    const user = await usersCollection.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found." 
      });
    }

    // Check if account is already active
    if (user.accountStatus === "active") {
      return res.json({ 
        success: false, 
        message: "Account is already active." 
      });
    }

    // Check for recent request (prevent spam)
    const recentRequest = await reactivationCollection.findOne({
      userId: user.userId,
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
    });

    if (recentRequest) {
      return res.json({ 
        success: false, 
        message: "You already requested reactivation recently. Please wait 24 hours." 
      });
    }

    // Create reactivation request
    const requestId = uuidv4();
    const reactivationRequest = {
      requestId,
      userId: user.userId,
      userEmail: user.email,
      userName: `${user.firstName} ${user.lastName}`,
      reason: reason || "No reason provided",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await reactivationCollection.insertOne(reactivationRequest);

    // Send email to admin
    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const approveUrl = `${baseUrl}/users/admin/reactivation/approve/${requestId}`;
    const rejectUrl = `${baseUrl}/users/admin/reactivation/reject/${requestId}`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.ADMIN_EMAIL || "admin@yourstore.com", // Set this in .env
      subject: `🔔 Reactivation Request: ${user.firstName} ${user.lastName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>📋 Reactivation Request</h2>
          
          <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
            <p><strong>User:</strong> ${user.firstName} ${user.lastName}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>Requested:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Reason:</strong> ${reason || "No reason provided"}</p>
          </div>
          
          <div style="margin: 30px 0;">
            <a href="${approveUrl}" 
               style="background: #4CAF50; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 5px; margin-right: 10px;">
              ✅ Approve & Activate
            </a>
            
            <a href="${rejectUrl}" 
               style="background: #f44336; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 5px;">
              ❌ Reject
            </a>
          </div>
          
          <p style="color: #666; font-size: 14px;">
            Or manage all requests at: ${baseUrl}/users/admin/reactivation-requests
          </p>
        </div>
      `,
    });

    // Send confirmation email to user
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: user.email,
      subject: "✅ Reactivation Request Received",
      html: `
        <h2>Hello ${user.firstName},</h2>
        <p>Your account reactivation request has been received.</p>
        <p>Our admin team will review it shortly. You'll receive another email once a decision is made.</p>
        <p><strong>Request ID:</strong> ${requestId}</p>
        <p><strong>Request Time:</strong> ${new Date().toLocaleString()}</p>
        ${reason ? `<p><strong>Your Reason:</strong> ${reason}</p>` : ''}
        <p>Thank you for your patience.</p>
      `,
    });

    res.json({ 
      success: true, 
      message: "Reactivation request sent! Check your email for confirmation." 
    });

  } catch (err) {
    console.error("❌ Reactivation request error:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error. Please try again later." 
    });
  }
});


// =======================================================================
//  ADMIN: APPROVE REACTIVATION (GET) - WITH REDIRECT
// =======================================================================
router.get("/admin/reactivation/approve/:requestId", async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const reactivationCollection = db.collection("reactivation_requests");
    const usersCollection = db.collection("users");

    const request = await reactivationCollection.findOne({ 
      requestId: req.params.requestId 
    });

    if (!request) {
      // Show error page if request not found
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Request Not Found</title>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            .icon {
              font-size: 80px;
              margin-bottom: 20px;
            }
            .error { color: #f44336; }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 30px;
            }
            .btn {
              display: inline-block;
              padding: 12px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: bold;
              transition: 0.3s;
              border: none;
              cursor: pointer;
              font-size: 16px;
            }
            .btn:hover {
              background: #5a67d8;
              transform: translateY(-2px);
            }
            .btn-home {
              background: #6c757d;
              margin-left: 10px;
            }
            .btn-home:hover {
              background: #5a6268;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon error">
              <i class="fas fa-exclamation-triangle"></i>
            </div>
            <h1>Request Not Found</h1>
            <p>The reactivation request you're trying to approve could not be found.</p>
            <p>It may have already been processed or expired.</p>
            <div style="margin-top: 30px;">
              <a href="/users/login" class="btn">Go to Login</a>
              <a href="/" class="btn btn-home">Go to Homepage</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    // Check if already processed
    if (request.status !== "pending") {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Already Processed</title>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            .icon {
              font-size: 80px;
              margin-bottom: 20px;
            }
            .info { color: #2196F3; }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 30px;
            }
            .user-info {
              background: #f5f5f5;
              padding: 20px;
              border-radius: 10px;
              margin: 20px 0;
              text-align: left;
            }
            .btn {
              display: inline-block;
              padding: 12px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: bold;
              transition: 0.3s;
              border: none;
              cursor: pointer;
              font-size: 16px;
            }
            .btn:hover {
              background: #5a67d8;
              transform: translateY(-2px);
            }
            .btn-success {
              background: #4CAF50;
            }
            .btn-success:hover {
              background: #45a049;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon info">
              <i class="fas fa-info-circle"></i>
            </div>
            <h1>Already Processed</h1>
            <p>This reactivation request has already been <strong>${request.status}</strong>.</p>
            <div class="user-info">
              <p><strong>User:</strong> ${request.userName}</p>
              <p><strong>Email:</strong> ${request.userEmail}</p>
              <p><strong>Status:</strong> ${request.status}</p>
              <p><strong>Processed:</strong> ${new Date(request.updatedAt).toLocaleString()}</p>
            </div>
            <div style="margin-top: 30px;">
              <a href="/users/login" class="btn">Go to Login</a>
              <a href="/users/admin/reactivation-requests" class="btn btn-success">View All Requests</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    // Update user status to active
    await usersCollection.updateOne(
      { userId: request.userId },
      { $set: { accountStatus: "active", updatedAt: new Date() } }
    );

    // Update request status
    await reactivationCollection.updateOne(
      { requestId: req.params.requestId },
      { $set: { status: "approved", updatedAt: new Date() } }
    );

    // Send email to user
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: request.userEmail,
      subject: "🎉 Your Account Has Been Reactivated!",
      html: `
        <h2>Hello ${request.userName},</h2>
        <p>Great news! Your account has been reactivated.</p>
        <p>You can now log in and access all features:</p>
        <p><a href="${process.env.BASE_URL || 'http://localhost:3000'}/users/login" 
              style="background: #4cc9f0; color: white; padding: 12px 24px; 
                     text-decoration: none; border-radius: 5px; display: inline-block;">
          Login Now
        </a></p>
        <p>Welcome back! 😊</p>
      `,
    });

    // REDIRECT to requests page with success message
    res.redirect("/users/admin/reactivation-requests?approved=1");

  } catch (err) {
    console.error("❌ Approve reactivation error:", err);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
            text-align: center;
            max-width: 500px;
            width: 100%;
          }
          .icon {
            font-size: 80px;
            margin-bottom: 20px;
          }
          .error { color: #f44336; }
          h1 {
            color: #333;
            margin-bottom: 20px;
          }
          p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 30px;
          }
          .btn {
            display: inline-block;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: bold;
            transition: 0.3s;
            border: none;
            cursor: pointer;
            font-size: 16px;
          }
          .btn:hover {
            background: #5a67d8;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon error">
            <i class="fas fa-exclamation-circle"></i>
          </div>
          <h1>Error Processing Request</h1>
          <p>There was an error processing the reactivation request. Please try again later.</p>
          <p>Error: ${err.message}</p>
          <div style="margin-top: 30px;">
            <a href="/" class="btn">Go to Homepage</a>
            <a href="/users/admin/reactivation-requests" class="btn" style="background: #6c757d; margin-left: 10px;">View Requests</a>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});
// =======================================================================
//  ADMIN: REJECT REACTIVATION (GET) - WITH REDIRECT
// =======================================================================
router.get("/admin/reactivation/reject/:requestId", async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const reactivationCollection = db.collection("reactivation_requests");

    const request = await reactivationCollection.findOne({ 
      requestId: req.params.requestId 
    });

    if (!request) {
      // Show error page if request not found (same as approve route)
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Request Not Found</title>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            .icon {
              font-size: 80px;
              margin-bottom: 20px;
            }
            .error { color: #f44336; }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 30px;
            }
            .btn {
              display: inline-block;
              padding: 12px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: bold;
              transition: 0.3s;
              border: none;
              cursor: pointer;
              font-size: 16px;
            }
            .btn:hover {
              background: #5a67d8;
              transform: translateY(-2px);
            }
            .btn-home {
              background: #6c757d;
              margin-left: 10px;
            }
            .btn-home:hover {
              background: #5a6268;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon error">
              <i class="fas fa-exclamation-triangle"></i>
            </div>
            <h1>Request Not Found</h1>
            <p>The reactivation request you're trying to reject could not be found.</p>
            <p>It may have already been processed or expired.</p>
            <div style="margin-top: 30px;">
              <a href="/users/login" class="btn">Go to Login</a>
              <a href="/" class="btn btn-home">Go to Homepage</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    // Check if already processed
    if (request.status !== "pending") {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Already Processed</title>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            .icon {
              font-size: 80px;
              margin-bottom: 20px;
            }
            .info { color: #2196F3; }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 30px;
            }
            .user-info {
              background: #f5f5f5;
              padding: 20px;
              border-radius: 10px;
              margin: 20px 0;
              text-align: left;
            }
            .btn {
              display: inline-block;
              padding: 12px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: bold;
              transition: 0.3s;
              border: none;
              cursor: pointer;
              font-size: 16px;
            }
            .btn:hover {
              background: #5a67d8;
              transform: translateY(-2px);
            }
            .btn-success {
              background: #4CAF50;
            }
            .btn-success:hover {
              background: #45a049;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon info">
              <i class="fas fa-info-circle"></i>
            </div>
            <h1>Already Processed</h1>
            <p>This reactivation request has already been <strong>${request.status}</strong>.</p>
            <div class="user-info">
              <p><strong>User:</strong> ${request.userName}</p>
              <p><strong>Email:</strong> ${request.userEmail}</p>
              <p><strong>Status:</strong> ${request.status}</p>
              <p><strong>Processed:</strong> ${new Date(request.updatedAt).toLocaleString()}</p>
            </div>
            <div style="margin-top: 30px;">
              <a href="/users/login" class="btn">Go to Login</a>
              <a href="/users/admin/reactivation-requests" class="btn btn-success">View All Requests</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    // Update request status
    await reactivationCollection.updateOne(
      { requestId: req.params.requestId },
      { $set: { status: "rejected", updatedAt: new Date() } }
    );

    // Send email to user
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: request.userEmail,
      subject: "📝 About Your Reactivation Request",
      html: `
        <h2>Hello ${request.userName},</h2>
        <p>Thank you for your reactivation request.</p>
        <p>After review, we're unable to reactivate your account at this time.</p>
        <p>If you have questions or would like to appeal this decision, 
           please contact our support team.</p>
        <p>Best regards,<br>The Support Team</p>
      `,
    });

    // REDIRECT to requests page with success message
    res.redirect("/users/admin/reactivation-requests?rejected=1");

  } catch (err) {
    console.error("❌ Reject reactivation error:", err);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
            text-align: center;
            max-width: 500px;
            width: 100%;
          }
          .icon {
            font-size: 80px;
            margin-bottom: 20px;
          }
          .error { color: #f44336; }
          h1 {
            color: #333;
            margin-bottom: 20px;
          }
          p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 30px;
          }
          .btn {
            display: inline-block;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: bold;
            transition: 0.3s;
            border: none;
            cursor: pointer;
            font-size: 16px;
          }
          .btn:hover {
            background: #5a67d8;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon error">
            <i class="fas fa-exclamation-circle"></i>
          </div>
          <h1>Error Processing Request</h1>
          <p>There was an error processing the reactivation request. Please try again later.</p>
          <p>Error: ${err.message}</p>
          <div style="margin-top: 30px;">
            <a href="/" class="btn">Go to Homepage</a>
            <a href="/users/admin/reactivation-requests" class="btn" style="background: #6c757d; margin-left: 10px;">View Requests</a>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});

// =======================================================================
//  ADMIN: VIEW REACTIVATION REQUESTS (GET)
// =======================================================================
router.get("/admin/reactivation-requests", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const reactivationCollection = db.collection("reactivation_requests");

    const requests = await reactivationCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate stats
    const stats = {
      total: requests.length,
      pending: requests.filter(r => r.status === "pending").length,
      approved: requests.filter(r => r.status === "approved").length,
      rejected: requests.filter(r => r.status === "rejected").length
    };

    res.render("admin/reactivationRequests", {
      title: "Reactivation Requests",
      currentUser: req.session.user,
      requests,
      stats,
      approved: req.query.approved === "1",
      rejected: req.query.rejected === "1"
    });

  } catch (err) {
    console.error("❌ Reactivation requests error:", err);
    res.status(500).send("Error loading requests.");
  }
});


// =======================================================================
//  ORDER HISTORY
// =======================================================================
router.get("/orders/history", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");
    const usersCol = db.collection("users");

    let orders;

    // If user is admin, show all orders. Otherwise, show only their own orders.
    if (req.session.user.role === "admin") {
      orders = await ordersCol.find({}).sort({ createdAt: -1 }).toArray();
      
      // Get customer info for each order
      for (let order of orders) {
        const customer = await usersCol.findOne({ userId: order.userId });
        if (customer) {
          order.customerName = `${customer.firstName} ${customer.lastName}`;
          order.customerEmail = customer.email;
        } else {
          order.customerName = "Unknown Customer";
          order.customerEmail = "N/A";
        }
      }
    } else {
      orders = await ordersCol
        .find({ userId: req.session.user.userId })
        .sort({ createdAt: -1 })
        .toArray();
    }

    res.render("orders-history", {
      title: req.session.user.role === "admin" ? "All Customer Orders" : "My Orders",
      orders,
      currentUser: req.session.user
    });
  } catch (err) {
    console.error("Order history error:", err);
    res.status(500).send("Error loading order history");
  }
});


// =======================================================================
//  DASHBOARD - COMPLETE VERSION WITH ORDER COUNTS
// =======================================================================
router.get("/dashboard", requireLogin, async (req, res) => {
  try {
    console.log("🔍 DASHBOARD - Loading for user:", req.session.user.userId);
    
    const db = req.app.locals.client.db(req.app.locals.dbName);
    
    // Get products
    const products = await db.collection("products").find().toArray();
    const normalized = products.map((p) => {
      const images = [];
      if (p.images && Array.isArray(p.images)) images.push(...p.images);
      if (p.imageUrl) images.push(p.imageUrl);
      return { ...p, images };
    });

    // ✅ ADD ORDER COUNTING LOGIC
    const ordersCol = db.collection("orders");
    const userOrders = await ordersCol.find({ userId: req.session.user.userId }).toArray();

    console.log("📦 Orders found for user:", userOrders.length);
    userOrders.forEach(order => {
      console.log(`   Order ${order.orderId}: ${order.orderStatus}`);
    });

    // Count orders by status
    const statusCounts = {
      pending: 0,
      paid: 0,
      shipped: 0,
      completed: 0,
      refund: 0,
      cancelled: 0
    };

    userOrders.forEach(order => {
      const status = order.orderStatus;
      if (statusCounts[status] !== undefined) {
        statusCounts[status] += 1;
      }
    });

    console.log("📊 Final counts:", statusCounts);

    res.render("dashboard", {
      title: "User Dashboard",
      currentUser: req.session.user,
      products: normalized,
      // ✅ PASS ORDER DATA TO TEMPLATE
      statusCounts: statusCounts,
      totalOrders: userOrders.length
    });
  } catch (err) {
    console.error("❌ Dashboard error:", err);
    res.send("Something went wrong.");
  }
});


// =======================================================================
//  ADMIN: MANAGE PRODUCTS (UPDATED FOR LESSON 22)
// =======================================================================
router.get("/admin/products", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const productsCollection = db.collection("products");
        
        // Search filters (Lesson 22)
        const searchName = (req.query.searchName || "").trim();
        const searchCategory = (req.query.searchCategory || "").trim();
        
        const query = {};
        if (searchName) {
            query.name = { $regex: searchName, $options: "i" };
        }
        if (searchCategory) {
            query.category = searchCategory;
        }

        const products = await productsCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        // Messages (Lesson 22)
        const success = req.query.success;
        const action = req.query.action;
        const error = req.query.error;
        let message = null;
        
        if (success == "1" && action == "created") {
            message = {
                type: "success",
                text: "Product created successfully."
            };
        } else if (success == "1" && action == "updated") {
            message = {
                type: "success", 
                text: "Product updated successfully."
            };
        } else if (success == "1" && action == "deleted") {
            message = {
                type: "success",
                text: "Product deleted successfully."
            };
        } else if (error == "cannot_delete_used") {
            message = {
                type: "error",
                text: "Cannot delete this product because it is already used in one or more orders."
            };
        }

        res.render("admin/manageProducts", {
            products,
            currentUser: req.session.user,
            highlightedProduct: req.query.highlight || null,
            // Lesson 22 additions
            message,
            searchName,
            searchCategory
        });

    } catch (err) {
        console.error("❌ Admin products error:", err);
        res.status(500).send("Error loading products.");
    }
});


// =======================================================================
//  ADD PRODUCT (GET) - FIXED
// =======================================================================
router.get("/admin/products/add", requireLogin, (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  res.render("admin/addproduct", {
    title: "Add Product",
    currentUser: req.session.user,
    errors: [], // Add this line - initialize empty errors array
    formData: {} // Add this line - initialize empty formData object
  });
});


// =======================================================================
//  ADD PRODUCT (POST) - UPDATED WITH LESSON 22 VALIDATION
// =======================================================================
router.post(
    "/admin/products/add",
    requireLogin,
    uploadProduct.array("images", 10),
    async (req, res) => {
        if (req.session.user.role !== "admin")
            return res.status(403).send("Access denied.");

        try {
            const db = req.app.locals.client.db(req.app.locals.dbName);
            
            // Lesson 22: Validate input
            const { errors, formData, priceNumber } = validateProductInput(req.body);

            if (errors.length > 0) {
                // Validation failed - show form again with errors
                return res.status(400).render("admin/addproduct", {
                    title: "Add Product",
                    currentUser: req.session.user,
                    errors,
                    formData
                });
            }

            // Handle multiple uploaded images
            const imagesArr = [];
            if (req.files && req.files.length > 0) {
                req.files.forEach((file) => {
                    imagesArr.push("/uploads/" + file.filename);
                });
            }

            const stockVal = parseInt(req.body.stock || "0");
            let statusVal = req.body.status || "available";
            if (stockVal === 0 && statusVal !== "maintenance")
                statusVal = "unavailable";

            const product = {
                name: formData.name,
                category: formData.category,
                price: priceNumber,
                stock: stockVal,
                status: statusVal,
                images: imagesArr,
                description: formData.description,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const result = await db.collection("products").insertOne(product);
            
            // Lesson 22: Redirect with success message AND highlight
            res.redirect("/users/admin/products?success=1&action=created&highlight=" + result.insertedId);

        } catch (err) {
            console.error("❌ Add product error:", err);
            
            // Clean up uploaded files if error occurred
            if (req.files && req.files.length > 0) {
                req.files.forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                    } catch (err) {
                        console.error("Error cleaning up file:", err);
                    }
                });
            }
            
            res.status(500).send("Something went wrong.");
        }
    }
);


// =======================================================================
//  EDIT PRODUCT (GET) - FIXED
// =======================================================================
router.get("/admin/products/edit/:id", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);

    const product = await db
      .collection("products")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!product) return res.send("Product not found.");

    res.render("admin/editProduct", {
      product,
      currentUser: req.session.user,
      errors: [], // Add this line - initialize empty errors array
      formData: {} // Add this line - initialize empty formData object
    });
  } catch (err) {
    console.error("❌ Fetch product error:", err);
    res.send("Something went wrong.");
  }
});

// =======================================================================
//  EDIT PRODUCT (POST) - UPDATED WITH LESSON 22 VALIDATION
// =======================================================================
router.post(
    "/admin/products/edit/:id",
    requireLogin,
    uploadProduct.array("images", 10),
    async (req, res) => {
        if (req.session.user.role !== "admin")
            return res.status(403).send("Access denied.");

        try {
            const db = req.app.locals.client.db(req.app.locals.dbName);
            
            // Lesson 22: Validate input
            const { errors, formData, priceNumber } = validateProductInput(req.body);

            const product = await db
                .collection("products")
                .findOne({ _id: new ObjectId(req.params.id) });

            if (!product) return res.send("Product not found.");

            if (errors.length > 0) {
                // Validation failed - show form again with errors
                return res.status(400).render("admin/editProduct", {
                    product,
                    currentUser: req.session.user,
                    errors,
                    formData: { ...formData, status: req.body.status, stock: req.body.stock }
                });
            }

            const { deletedImages } = req.body;

            // Start with existing images
            let imagesArr = Array.isArray(product.images) ? [...product.images] : [];

            // Remove deleted images
            if (deletedImages && deletedImages.trim() !== '') {
                try {
                    const deletedArray = JSON.parse(deletedImages);
                    imagesArr = imagesArr.filter(img => !deletedArray.includes(img));
                    
                    // Delete the actual files from server
                    deletedArray.forEach(imgPath => {
                        try {
                            if (imgPath.startsWith('/uploads/')) {
                                const filename = imgPath.split('/').pop();
                                const filePath = path.join(__dirname, '..', 'public', 'uploads', filename);
                                if (fs.existsSync(filePath)) {
                                    fs.unlinkSync(filePath);
                                }
                            }
                        } catch (err) {
                            // Silent fail for file deletion errors
                        }
                    });
                } catch (parseError) {
                    // Silent fail for parsing errors
                }
            }

            // Add new uploaded images
            if (req.files && req.files.length > 0) {
                req.files.forEach(file => {
                    imagesArr.push("/uploads/" + file.filename);
                });
            }

            const stockVal = parseInt(req.body.stock || "0");
            let statusVal = req.body.status || "available";
            if (stockVal === 0 && statusVal !== "maintenance")
                statusVal = "unavailable";

            await db.collection("products").updateOne(
                { _id: new ObjectId(req.params.id) },
                {
                    $set: {
                        name: formData.name,
                        description: formData.description,
                        category: formData.category,
                        stock: stockVal,
                        price: priceNumber,
                        status: statusVal,
                        images: imagesArr,
                        updatedAt: new Date(),
                    },
                }
            );

            // Lesson 22: Redirect with success message AND highlight
            res.redirect("/users/admin/products?success=1&action=updated&highlight=" + req.params.id);

        } catch (err) {
            console.error("❌ Update product error:", err);
            
            // Clean up uploaded files if error occurred
            if (req.files && req.files.length > 0) {
                req.files.forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                    } catch (err) {
                        // Silent fail for cleanup errors
                    }
                });
            }
            
            res.status(500).send("Something went wrong.");
        }
    }
);

// =======================================================================
//  DELETE PRODUCT - FIXED SAFE DELETE
// =======================================================================
router.get("/admin/products/delete/:id", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).send("Access denied.");

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const productsCollection = db.collection("products");
        const ordersCollection = db.collection("orders");

        const productId = req.params.id;

        // Check if this product is used in any orders
        const orderUsingProduct = await ordersCollection.findOne({
            "items.productId": productId
        });

        if (orderUsingProduct) {
            // Product is used in at least one order - do not delete
            return res.redirect("/users/admin/products?error=cannot_delete_used");
        }

        // Safe to delete - no orders found with this product
        await productsCollection.deleteOne({ _id: new ObjectId(productId) });

        res.redirect("/users/admin/products?success=1&action=deleted");

    } catch (err) {
        console.error("❌ Delete product error:", err);
        res.status(500).send("Something went wrong.");
    }
});


// =======================================================================
//  ADMIN DASHBOARD
// =======================================================================
router.get("/admin", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  const db = req.app.locals.client.db(req.app.locals.dbName);
  const users = await db.collection("users").find().toArray();

  res.render("admin", {
    title: "Admin Dashboard",
    users,
    currentUser: req.session.user,
  });
});

// In users.js - Add these routes for QR code management

// =======================================================================
//  MANAGE QR CODES (GET) - Admin only
// =======================================================================
router.get("/admin/qr-codes", requireLogin, async (req, res) => {
  try {
    console.log("🔍 QR codes page accessed by:", req.session.user.email);
    
    if (req.session.user.role !== "admin") {
      console.log("❌ Access denied - not admin");
      return res.status(403).send("Access denied.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const settingsCol = db.collection("settings");
    
    // Get current QR code setting
    const qrSetting = await settingsCol.findOne({ key: "gcash_qr_code" });
    console.log("📱 QR code found in DB:", qrSetting ? "Yes" : "No");
    
    // Get current phone number setting
    const phoneSetting = await settingsCol.findOne({ key: "gcash_phone_number" });
    console.log("📞 Phone number found in DB:", phoneSetting ? phoneSetting.value : "Not found");
    
    res.render("admin/manageQRCodes", {
      title: "Manage QR Codes",
      currentUser: req.session.user,
      qrCodeImage: qrSetting ? qrSetting.value : null,
      gcashNumber: phoneSetting ? phoneSetting.value : "0917 123 4567", // Use saved number or default
      req: req // Pass req for query parameters
    });
  } catch (err) {
    console.error("❌ QR codes error:", err);
    res.status(500).send("Error loading QR codes page: " + err.message);
  }
});

// =======================================================================
//  UPLOAD QR CODE (POST) - Admin only
// =======================================================================
const uploadQRCode = require("../middleware/uploadQRCode");

router.post(
  "/admin/qr-codes/upload",
  requireLogin,
  uploadQRCode.single("qrCodeImage"),
  async (req, res) => {
    if (req.session.user.role !== "admin")
      return res.status(403).send("Access denied.");

    try {
      const db = req.app.locals.client.db(req.app.locals.dbName);
      const settingsCol = db.collection("settings");

      if (!req.file) {
        return res.status(400).send("No file uploaded.");
      }

      const qrCodePath = "/uploads/qr-codes/" + req.file.filename;

      // Save or update QR code path in settings
      await settingsCol.updateOne(
        { key: "gcash_qr_code" },
        { 
          $set: { 
            value: qrCodePath,
            updatedAt: new Date()
          } 
        },
        { upsert: true }
      );

      res.redirect("/users/admin/qr-codes?success=1");
    } catch (err) {
      console.error("❌ QR code upload error:", err);
      
      // Clean up uploaded file if error occurred
      if (req.file) {
        const fs = require('fs');
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupErr) {
          console.error("Error cleaning up file:", cleanupErr);
        }
      }
      
      res.send("Something went wrong.");
    }
  }
);

// =======================================================================
//  DELETE QR CODE - Admin only
// =======================================================================
router.post("/admin/qr-codes/delete", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const settingsCol = db.collection("settings");

    // Get current QR code to delete the file
    const currentQR = await settingsCol.findOne({ key: "gcash_qr_code" });
    
    if (currentQR && currentQR.value) {
      // Delete the physical file
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(__dirname, "../public", currentQR.value);
      
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Remove from database
    await settingsCol.deleteOne({ key: "gcash_qr_code" });

    res.redirect("/users/admin/qr-codes?deleted=1");
  } catch (err) {
    console.error("❌ QR code delete error:", err);
    res.send("Something went wrong.");
  }
});
// =======================================================================
//  ADMIN: TOGGLE USER STATUS (AJAX)
// =======================================================================
router.post("/admin/users/toggle-status/:userId", requireLogin, async (req, res) => {
    if (req.session.user.role !== "admin")
        return res.status(403).json({ error: "Access denied." });

    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const usersCollection = db.collection("users");

        const userId = req.params.userId;

        // Prevent admin from deactivating themselves
        if (userId === req.session.user.userId) {
            return res.status(400).json({ error: "You cannot deactivate your own account." });
        }

        const user = await usersCollection.findOne({ userId });
        
        if (!user) {
            return res.status(404).json({ error: "User not found." });
        }

        // Toggle the status (active ↔ inactive)
        const newStatus = user.accountStatus === "active" ? "inactive" : "active";
        
        await usersCollection.updateOne(
            { userId },
            { 
                $set: { 
                    accountStatus: newStatus,
                    updatedAt: new Date() 
                } 
            }
        );

        res.json({ 
            success: true, 
            newStatus,
            message: `User ${newStatus === "active" ? "activated" : "deactivated"} successfully` 
        });

    } catch (err) {
        console.error("❌ Toggle status error:", err);
        res.status(500).json({ error: "Error updating user status." });
    }
});
// =======================================================================
//  SAVE GCASH DETAILS - Admin only
// =======================================================================
router.post("/admin/qr-codes/save-details", requireLogin, async (req, res) => {
  try {
    console.log("💾 Saving GCash details by:", req.session.user.email);
    
    if (req.session.user.role !== "admin") {
      return res.status(403).send("Access denied.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const settingsCol = db.collection("settings");

    const { gcashNumber } = req.body;

    if (!gcashNumber) {
      return res.status(400).send("Phone number is required.");
    }

    // Save phone number to database
    await settingsCol.updateOne(
      { key: "gcash_phone_number" },
      { 
        $set: { 
          value: gcashNumber,
          updatedAt: new Date()
        } 
      },
      { upsert: true }
    );

    console.log("✅ GCash phone number saved:", gcashNumber);
    res.redirect("/users/admin/qr-codes?saved=1");
  } catch (err) {
    console.error("❌ Save GCash details error:", err);
    res.status(500).send("Something went wrong.");
  }
});

// =======================================================================
//  VALIDATION HELPER (Lesson 22)
// =======================================================================
function validateProductInput(body) {
    const errors = [];
    const name = (body.name || "").trim();
    const description = (body.description || "").trim();
    const category = (body.category || "").trim();

    const priceRaw = (body.price || "").toString().trim();
    const price = Number(priceRaw);

    if (!name) {
        errors.push("Product name is required.");
    } else if (name.length < 2) {
        errors.push("Product name must be at least 2 characters.");
    }

    if (!description) {
        errors.push("Description is required.");
    } else if (description.length < 5) {
        errors.push("Description must be at least 5 characters.");
    }

    if (!priceRaw) {
        errors.push("Price is required.");
    } else if (Number.isNaN(price)) {
        errors.push("Price must be a valid number.");
    } else if (price <= 0) {
        errors.push("Price must be greater than 0.");
    }

    if (!category) {
        errors.push("Category is required.");
    }

    const formData = {
        name,
        description,
        price: priceRaw, // keep raw input for the form
        category,
        status: body.status || "available",
        stock: body.stock || "0"
    };

    return { errors, formData, priceNumber: price };
}


// =======================================================================
//  LOGOUT
// =======================================================================
router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/users/login?logout=1");
  });
});


// =======================================================================
//  404 HANDLER
// =======================================================================
router.use((req, res) => {
  res.status(404).render("404", { title: "Page Not Found" });
});


module.exports = router;