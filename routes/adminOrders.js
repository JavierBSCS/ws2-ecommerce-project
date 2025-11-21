const express = require("express");
const router = express.Router();
const requireLogin = require("../middleware/auth");

router.get("/orders", requireLogin, async (req, res) => {
  if (req.session.user.role !== "admin") {
    return res.status(403).send("Access denied.");
  }

  const db = req.app.locals.client.db(req.app.locals.dbName);
  const ordersCol = db.collection("orders");
  const usersCol = db.collection("users");

  const orders = await ordersCol.find().sort({ createdAt: -1 }).toArray();

  const userIds = [...new Set(orders.map(o => o.userId))];
  const users = await usersCol.find({ userId: { $in: userIds } }).toArray();

  const merged = orders.map(order => {
    const u = users.find(x => x.userId === order.userId);
    return {
      ...order,
      userEmail: u?.email || "Unknown"
    };
  });

  res.render("admin-orders", { orders: merged, title: "All Orders" });
});

module.exports = router;
