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