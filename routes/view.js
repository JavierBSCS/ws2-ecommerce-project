// routes/view.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require('mongodb');

// View individual product
router.get("/:id", async (req, res) => {
    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const product = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });
        
        if (!product) {
            return res.status(404).send("Product not found");
        }

        res.render("view-product", {
            title: product.name,
            product: product,
            currentUser: req.session.user
        });
    } catch (err) {
        console.error("View product ERROR:", err);
        res.redirect("/users/dashboard");
    }
});

module.exports = router;