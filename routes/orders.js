const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const requireLogin = require("../middleware/auth");
const { ObjectId } = require("mongodb");

// POST /orders/checkout → creates an order
router.post("/checkout", requireLogin, async (req, res) => {
  try {
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCol = db.collection("orders");
    const productsCol = db.collection("products");
    const user = req.session.user;

    let items = req.body.items;

    try {
      items = JSON.parse(items);
    } catch (err) {
      return res.status(400).send("Invalid items data.");
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
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

    // 🔥 NEW: Subtotal + Tax + Total
    const subtotal = orderItems.reduce((acc, i) => acc + i.subtotal, 0);
    const tax = Number((subtotal * 0.12).toFixed(2));  // 12% VAT
    const totalAmount = Number((subtotal + tax).toFixed(2));

    const now = new Date();

    const newOrder = {
      orderId: uuidv4(),
      userId: user.userId,
      items: orderItems,

      // Save full pricing details
      subtotal,
      tax,
      totalAmount,

      orderStatus: "to_pay",
      createdAt: now,
      updatedAt: now
    };

    await ordersCol.insertOne(newOrder);

    // clear cart
    req.session.cart = [];

    return res.redirect("/orders/success");

  } catch (err) {
    console.error("Checkout error:", err);
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
      
      if (customer) {
        console.log("📋 Customer data:", {
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phone,
          address: customer.address,
          city: customer.city,
          province: customer.province,
          zip: customer.zip
        });
      }
    }

    console.log("✅ Rendering viewDetails template...");
    
    res.render("orders/viewDetails", { 
      order, 
      customer,
      currentUser: req.session.user 
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

    if (order.orderStatus !== "to_pay") {
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

module.exports = router;
