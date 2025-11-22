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


// =======================================================================
//  PROFILE PAGE
// =======================================================================
router.get("/profile", requireLogin, (req, res) => {
  res.render("profile", { user: req.session.user });
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

      const { firstName, lastName, email } = req.body;

      // email must be unique
      const emailCheck = await usersCollection.findOne({ email });
      if (emailCheck && emailCheck.userId !== req.params.userId) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.send("❌ Email already in use.");
      }

      const updateObj = {
        firstName,
        lastName,
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
      };

      req.session.save(() => {
        res.redirect("/users/profile");
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
//  REGISTER (GET)
// =======================================================================
router.get("/register", (req, res) => {
  res.render("register", { title: "Register", error: null });
});


// =======================================================================
//  REGISTER (POST)
// =======================================================================
router.post("/register", async (req, res) => {
  try {
    const token = req.body["cf-turnstile-response"];
    const result = await verifyTurnstile(token, req.ip);

    if (!result.success) {
      return res.status(400).render("register", {
        title: "Register",
        error: "⚠️ Verification failed. Please try again.",
      });
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const usersCollection = db.collection("users");

    const existingUser = await usersCollection.findOne({
      email: req.body.email,
    });
    if (existingUser) return res.send("❌ Email already registered.");

    const hashedPassword = await bcrypt.hash(req.body.password, saltRounds);

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
      createdAt: now,
      updatedAt: now,
    };

    await usersCollection.insertOne(newUser);

    // send verification email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: newUser.email,
      subject: "Verify Your Email",
      html: `
        <h2>Hello ${newUser.firstName},</h2>
        <p>Please verify your email:</p>
        <a href="${verifyURL}">${verifyURL}</a>
      `,
    });

    res.redirect("/users/login?registered=1");
  } catch (err) {
    console.error("❌ Register error:", err);
    res.send("Something went wrong.");
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
//  LOGIN (POST)
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
    if (user.accountStatus !== "active")
      return res.send("⚠️ Account inactive.");

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
//  ORDER HISTORY
// =======================================================================
router.get("/orders/history", requireLogin, async (req, res) => {
  const db = req.app.locals.client.db(req.app.locals.dbName);
  const ordersCol = db.collection("orders");

  const orders = await ordersCol
    .find({ userId: req.session.user.userId })
    .sort({ createdAt: -1 })
    .toArray();

  res.render("orders-history", {
    title: "My Orders",
    orders,
  });
});


// =======================================================================
//  DASHBOARD
// =======================================================================
router.get("/dashboard", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const products = await db.collection("products").find().toArray();

    const normalized = products.map((p) => {
      const images = [];
      if (p.images && Array.isArray(p.images)) images.push(...p.images);
      if (p.imageUrl) images.push(p.imageUrl);
      return { ...p, images };
    });

    res.render("dashboard", {
      title: "User Dashboard",
      currentUser: req.session.user,
      products: normalized,
    });
  } catch (err) {
    console.error("❌ Dashboard error:", err);
    res.send("Something went wrong.");
  }
});


// =======================================================================
//  ADMIN: MANAGE PRODUCTS
// =======================================================================
router.get("/admin/products", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  const db = req.app.locals.client.db(req.app.locals.dbName);
  const products = await db.collection("products").find().toArray();

  res.render("admin/manageProducts", {
    products,
    currentUser: req.session.user,
    highlightedProduct: req.query.highlight || null // ADD THIS LINE
  });
});


// =======================================================================
//  ADD PRODUCT (GET)
// =======================================================================
router.get("/admin/products/add", requireLogin, (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  res.render("admin/addproduct", {
    title: "Add Product",
    currentUser: req.session.user,
  });
});


// =======================================================================
//  ADD PRODUCT (POST)
// =======================================================================
router.post(
  "/admin/products/add",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    if (req.session.user.role !== "admin")
      return res.status(403).send("Access denied.");

    try {
      const db = req.app.locals.client.db(req.app.locals.dbName);
      const { name, price, description, category, stock, status } = req.body;

      const imagesArr = [];
      if (req.file) imagesArr.push("/uploads/" + req.file.filename);

      const stockVal = parseInt(stock || "0");
      let statusVal = status || "available";
      if (stockVal === 0 && statusVal !== "maintenance")
        statusVal = "unavailable";

      const product = {
        name: name || "Untitled",
        category: category || "General",
        price: parseFloat(price) || 0,
        stock: stockVal,
        status: statusVal,
        images: imagesArr,
        description: description || "",
        createdAt: new Date(),
      };

      const result = await db.collection("products").insertOne(product);
      
      // REDIRECT WITH HIGHLIGHT PARAMETER FOR NEW PRODUCT
      res.redirect(`/users/admin/products?highlight=${result.insertedId}`);
    } catch (err) {
      console.error("❌ Add product error:", err);
      res.send("Something went wrong.");
    }
  }
);


// =======================================================================
//  EDIT PRODUCT (GET)
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

    const imagesCsv = Array.isArray(product.images)
      ? product.images.join(", ")
      : "";

    res.render("admin/editProduct", {
      product: { ...product, imagesCsv },
      currentUser: req.session.user,
    });
  } catch (err) {
    console.error("❌ Fetch product error:", err);
    res.send("Something went wrong.");
  }
});


// =======================================================================
//  EDIT PRODUCT (POST)
// =======================================================================
router.post(
  "/admin/products/edit/:id",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    if (req.session.user.role !== "admin")
      return res.status(403).send("Access denied.");

    try {
      const db = req.app.locals.client.db(req.app.locals.dbName);
      const { name, price, description, category, stock, status } = req.body;

      const product = await db
        .collection("products")
        .findOne({ _id: new ObjectId(req.params.id) });

      if (!product) return res.send("Product not found.");

      let imagesArr = Array.isArray(product.images)
        ? [...product.images]
        : [];

      if (req.body.images && req.body.images.trim()) {
        imagesArr = req.body.images
          .split(",")
          .map((i) => i.trim())
          .filter((i) => i.length > 0);
      }

      if (req.file) {
        const newImg = "/uploads/" + req.file.filename;
        if (imagesArr.length > 0) imagesArr[0] = newImg;
        else imagesArr.push(newImg);
      }

      const stockVal = parseInt(stock || "0");
      let statusVal = status || "available";
      if (stockVal === 0 && statusVal !== "maintenance")
        statusVal = "unavailable";

      await db.collection("products").updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            name,
            description,
            category: category || "General",
            stock: stockVal,
            price: parseFloat(price) || 0,
            status: statusVal,
            images: imagesArr,
            updatedAt: new Date(),
          },
        }
      );

      // REDIRECT WITH HIGHLIGHT PARAMETER
      res.redirect(`/users/admin/products?highlight=${req.params.id}`);
    } catch (err) {
      console.error("❌ Update product error:", err);
      res.send("Something went wrong.");
    }
  }
);


// =======================================================================
//  DELETE PRODUCT
// =======================================================================
router.get("/admin/products/delete/:id", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin")
    return res.status(403).send("Access denied.");

  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    await db
      .collection("products")
      .deleteOne({ _id: new ObjectId(req.params.id) });

    res.redirect("/users/admin/products");
  } catch (err) {
    console.error("❌ Delete product error:", err);
    res.send("Something went wrong.");
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
