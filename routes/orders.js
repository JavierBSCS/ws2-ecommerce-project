const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const requireLogin = require("../middleware/auth");
const { ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");

// MULTER CONFIGURATION
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'payment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// POST /orders/checkout → creates an order
router.post("/checkout", requireLogin, upload.single('paymentScreenshot'), async (req, res) => {
  try {
    console.log("Checkout request received:", {
      paymentMethod: req.body.paymentMethod,
      hasGcashReference: !!req.body.gcashReference,
      hasScreenshot: !!req.file,
      itemsCount: req.body.items ? JSON.parse(req.body.items).length : 0
    });

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");
    const productsCol = db.collection("products");
    const user = req.session.user;

    let items = req.body.items;
    const paymentMethod = req.body.paymentMethod;
    const gcashReference = req.body.gcashReference;
    
    let paymentScreenshot = null;
    if (req.file) {
      paymentScreenshot = '/uploads/' + req.file.filename;
      console.log("📸 Screenshot uploaded:", paymentScreenshot);
    }

    // Validate payment method
    if (!paymentMethod) {
      console.log("❌ Payment method missing");
      return res.status(400).send("Payment method is required.");
    }

    if (paymentMethod !== 'cod' && paymentMethod !== 'gcash') {
      console.log("❌ Invalid payment method:", paymentMethod);
      return res.status(400).send("Invalid payment method.");
    }

    // Validate GCash reference AND screenshot if GCash is selected
    if (paymentMethod === 'gcash') {
      if (!gcashReference) {
        console.log("❌ GCash reference missing");
        return res.status(400).send("GCash reference number is required.");
      }
      if (!paymentScreenshot) {
        console.log("❌ Payment screenshot missing");
        return res.status(400).send("Payment proof screenshot is required for GCash payments.");
      }
    }

    try {
      items = JSON.parse(items);
    } catch (err) {
      console.log("❌ Invalid items data:", err);
      return res.status(400).send("Invalid items data.");
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log("❌ No items provided");
      return res.status(400).send("No items provided.");
    }

    const productIds = items.map(i => new ObjectId(i.productId));
    const productDocs = await productsCol.find({ _id: { $in: productIds } }).toArray();

    const orderItems = items.map(item => {
      const prod = productDocs.find(p => p._id.toString() === item.productId);
      const qty = parseInt(item.quantity, 10) || 1;
      const price = prod?.price || 0;

      return {
        productId: item.productId,
        name: prod?.name || "Unknown",
        price: price,
        quantity: qty,
        subtotal: qty * price
      };
    });

    // Calculate totals
    const subtotal = orderItems.reduce((acc, i) => acc + i.subtotal, 0);
    const tax = Number((subtotal * 0.12).toFixed(2));
    const totalAmount = Number((subtotal + tax).toFixed(2));

    const now = new Date();

    const newOrder = {
      orderId: uuidv4(),
      userId: user.userId,
      items: orderItems,
      paymentMethod: paymentMethod,
      gcashReference: gcashReference || null,
      paymentScreenshot: paymentScreenshot,
      subtotal: subtotal,
      tax: tax,
      totalAmount: totalAmount,
      orderStatus: 'pending',
      createdAt: now,
      updatedAt: now,
      // Enhanced refund tracking fields
      refundAmount: null,
      refundReason: null,
      refundProcessedAt: null,
      returnRequestedAt: null,
      returnReason: null
    };

    console.log("📦 Creating order:", {
      orderId: newOrder.orderId,
      paymentMethod: newOrder.paymentMethod,
      hasScreenshot: !!newOrder.paymentScreenshot,
      status: newOrder.orderStatus
    });

    await ordersCol.insertOne(newOrder);

    // Clear cart
    req.session.cart = [];

    console.log("✅ Order created successfully with screenshot, rendering success page");

    res.render("customer/checkout-success", {
      title: "Order Successful",
      order: newOrder
    });

  } catch (err) {
    console.error("❌ Checkout error:", err);
    
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).send('File too large. Maximum size is 5MB.');
      }
    }
    
    res.status(500).send("Error placing order.");
  }
});

// SUCCESS PAGE
router.get("/success", requireLogin, (req, res) => {
  res.render("customer/checkout-success", {
    title: "Order Successful"
  });
});

// VIEW SINGLE ORDER
router.get("/view/:orderId", requireLogin, async (req, res) => {
  try {
    console.log("📥 View order request received for orderId:", req.params.orderId);
    
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");
    const usersCol = db.collection("users");

    const order = await ordersCol.findOne({ orderId: req.params.orderId });
    console.log("📦 Order found:", order ? "Yes" : "No");

    if (!order) {
      console.log("❌ Order not found");
      return res.status(404).send("Order not found");
    }

    // Check if user owns the order OR is an admin
    if (order.userId !== req.session.user.userId && req.session.user.role !== "admin") {
      console.log("🚫 Access denied - User doesn't own order and is not admin");
      return res.status(403).send("Access denied.");
    }

    // If admin is viewing, get customer details
    let customer = null;
    if (req.session.user.role === "admin") {
      console.log("🔍 Admin viewing - fetching customer data for userId:", order.userId);
      customer = await usersCol.findOne({ userId: order.userId });
      console.log("👤 Customer found:", customer ? "Yes" : "No");
    }

    console.log("✅ Rendering viewDetails template...");
    
    res.render("orders/viewDetails", { 
      order, 
      customer,
      currentUser: req.session.user,
      return_requested: req.query.return_requested
    });
    
  } catch (err) {
    console.error("❌ View order error:", err);
    res.status(500).send("Error loading order");
  }
});

// CANCEL ORDER
router.post("/cancel/:orderId", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");

    const orderId = req.params.orderId;

    const order = await ordersCol.findOne({ orderId });

    if (!order) return res.status(404).send("Order not found");

    if (order.orderStatus !== "pending") {
      return res.status(400).send("Order cannot be cancelled.");
    }

    await ordersCol.updateOne(
      { orderId },
      { $set: { orderStatus: "cancelled", updatedAt: new Date() } }
    );

    return res.redirect("/users/orders/history");

  } catch (err) {
    console.error("Cancel order error:", err);
    res.status(500).send("Error cancelling order");
  }
});

// UPDATE ORDER STATUS (Admin only)
router.post("/update-status/:orderId", requireLogin, async (req, res) => {
  try {
    if (req.session.user.role !== "admin") {
      return res.status(403).send("Access denied.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");

    const { status } = req.body;
    const orderId = req.params.orderId;

    const validStatuses = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'refund', 'return_requested'];
    if (!validStatuses.includes(status)) {
      return res.status(400).send("Invalid status.");
    }

    const updateData = {
      orderStatus: status,
      updatedAt: new Date()
    };

    // Add refund processed timestamp if status is refund
    if (status === 'refund') {
      updateData.refundProcessedAt = new Date();
      updateData.refundAmount = req.body.refundAmount; // Optional: for partial refunds
      updateData.refundReason = req.body.refundReason; // Optional: reason for refund
    }

    const result = await ordersCol.updateOne(
      { orderId },
      { $set: updateData }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send("Order not found.");
    }

    res.redirect(`/orders/view/${orderId}`);
  } catch (err) {
    console.error("Update order status error:", err);
    res.status(500).send("Error updating order status");
  }
});

// REQUEST RETURN (Customer only)
router.post("/request-return/:orderId", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");

    const orderId = req.params.orderId;

    const order = await ordersCol.findOne({ orderId });

    if (!order) return res.status(404).send("Order not found.");

    // Check if user owns the order
    if (order.userId !== req.session.user.userId) {
      return res.status(403).send("Access denied.");
    }

    // Only allow return requests for completed orders
    if (order.orderStatus !== "completed") {
      return res.status(400).send("Only completed orders can be returned.");
    }

    // Update order status to 'return_requested'
    await ordersCol.updateOne(
      { orderId },
      { 
        $set: { 
          orderStatus: "return_requested", 
          updatedAt: new Date(),
          returnRequestedAt: new Date(),
          returnReason: req.body.returnReason || "No reason provided"
        } 
      }
    );

    res.redirect(`/orders/view/${orderId}?return_requested=1`);
  } catch (err) {
    console.error("Return request error:", err);
    res.status(500).send("Error requesting return.");
  }
});

// ENHANCED REFUND PROCESSING (Admin only)
router.post("/process-refund/:orderId", requireLogin, async (req, res) => {
  try {
    if (req.session.user.role !== "admin") {
      return res.status(403).send("Access denied.");
    }

    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");

    const { refundAmount, refundReason, partialRefund } = req.body;
    const orderId = req.params.orderId;

    const order = await ordersCol.findOne({ orderId });
    if (!order) return res.status(404).send("Order not found.");

    // Calculate refund amount
    let finalRefundAmount;
    if (partialRefund === "true" && refundAmount) {
      finalRefundAmount = parseFloat(refundAmount);
      if (finalRefundAmount > order.totalAmount) {
        return res.status(400).send("Refund amount cannot exceed order total.");
      }
    } else {
      finalRefundAmount = order.totalAmount; // Full refund
    }

    // Update order with refund details
    await ordersCol.updateOne(
      { orderId },
      { 
        $set: { 
          orderStatus: "refund",
          refundAmount: finalRefundAmount,
          refundReason: refundReason || "Refund processed",
          refundProcessedAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );

    res.redirect(`/orders/view/${orderId}?refund_processed=1`);
  } catch (err) {
    console.error("Refund processing error:", err);
    res.status(500).send("Error processing refund.");
  }
});

module.exports = router;