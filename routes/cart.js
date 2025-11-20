const express = require("express");
const router = express.Router();
const Product = require("../models/Product"); // FIXED CASE

// Add product to cart
router.get("/add/:id", async (req, res) => {
    try {
        if (!req.session.cart) req.session.cart = [];

        const product = await Product.findById(req.params.id);
        if (!product) return res.redirect("/");

        // Check if product already exists in cart
        const existing = req.session.cart.find(item => item.productId == req.params.id);

        if (existing) {
            existing.qty += 1; // increase quantity
        } else {
            req.session.cart.push({
                productId: product._id,
                name: product.name,
                price: product.price,
                qty: 1
            });
        }

        res.redirect("/cart");
    } catch (err) {
        console.error("Add to cart ERROR:", err);
        res.redirect("/");
    }
});

// Cart page
router.get("/", (req, res) => {
    const cart = req.session.cart || [];
    res.render("customer/cart", { cart });
});

// Checkout placeholder
router.get("/checkout", (req, res) => {
    res.send("Checkout coming soon!");
});

module.exports = router;
