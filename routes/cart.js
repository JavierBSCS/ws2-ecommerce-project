const express = require("express");
const router = express.Router();
const requireLogin = require("../middleware/auth");
const { ObjectId } = require("mongodb"); // Add this


// Add product to cart
router.get("/add/:id", async (req, res) => {
    try {
        if (!req.session.cart) req.session.cart = [];

        const db = req.app.locals.client.db(req.app.locals.dbName);
        const productsCol = db.collection("products");
        
        const product = await productsCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!product) return res.redirect("/");

        // Check if product already exists in cart
        const existing = req.session.cart.find(item => item.productId == req.params.id);

        if (existing) {
            existing.qty += 1; // increase quantity
        } else {
            req.session.cart.push({
                productId: req.params.id, // Use string ID
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
// Increase quantity
router.post("/increase/:id", (req, res) => {
    try {
        if (!req.session.cart) return res.redirect("/cart");
        
        const item = req.session.cart.find(item => item.productId == req.params.id);
        if (item) {
            item.qty += 1;
        }
        
        res.redirect("/cart");
    } catch (err) {
        console.error("Increase quantity ERROR:", err);
        res.redirect("/cart");
    }
});

// Decrease quantity
router.post("/decrease/:id", (req, res) => {
    try {
        if (!req.session.cart) return res.redirect("/cart");
        
        const itemIndex = req.session.cart.findIndex(item => item.productId == req.params.id);
        if (itemIndex !== -1) {
            if (req.session.cart[itemIndex].qty > 1) {
                req.session.cart[itemIndex].qty -= 1;
            } else {
                // Remove item if quantity becomes 0
                req.session.cart.splice(itemIndex, 1);
            }
        }
        
        res.redirect("/cart");
    } catch (err) {
        console.error("Decrease quantity ERROR:", err);
        res.redirect("/cart");
    }
});

// Remove item from cart
router.post("/remove/:id", (req, res) => {
    try {
        if (!req.session.cart) return res.redirect("/cart");
        
        req.session.cart = req.session.cart.filter(item => item.productId != req.params.id);
        res.redirect("/cart");
    } catch (err) {
        console.error("Remove item ERROR:", err);
        res.redirect("/cart");
    }
});

// Cart page
router.get("/", (req, res) => {
    const cart = req.session.cart || [];
    
    // Calculate totals
    const subtotal = cart.reduce((total, item) => total + (item.price * item.qty), 0);
    const tax = subtotal * 0.12; // 12% tax
    const total = subtotal + tax;
    
    res.render("customer/cart", { 
        cart,
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2)
    });
});




module.exports = router;