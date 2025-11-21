const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");

router.get("/view/:id", async (req, res) => {
    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const productsCol = db.collection("products");

        const id = req.params.id;

        let product = null;

        // Try normal ObjectId ONLY if it's a valid 24-char ID
        if (ObjectId.isValid(id) && id.length === 24) {
            product = await productsCol.findOne({ _id: new ObjectId(id) });
        }

        // Fallback: string ID (your case)
        if (!product) {
            product = await productsCol.findOne({ _id: id });
        }

        if (!product) {
            return res.status(404).send("Product not found");
        }

        const images = [];
        if (Array.isArray(product.images)) images.push(...product.images);
        if (product.imageUrl) images.push(product.imageUrl);

       res.render("products/product", { product: { ...product, images } });


    } catch (err) {
        console.error("Product view error:", err);
        res.status(500).send("Error loading product");
    }
});

module.exports = router;
