const express = require("express");
const router = express.Router();
const Product = require("../models/Product");

// Show add product form
router.get("/add", (req, res) => {
    res.render("admin/addProduct");
});

// Handle add product
router.post("/add", async (req, res) => {
    try {
        const { name, price, description, imageUrl } = req.body;

        await Product.create({
            name,
            price,
            description,
            imageUrl
        });

        res.redirect("/users/admin/products");
    } catch (err) {
        console.error(err);
        res.send("Error creating product");
    }
});

// Manage products
router.get("/", async (req, res) => {
    const products = await Product.find();
    res.render("admin/manageProducts", { products });
});

// Edit page
router.get("/edit/:id", async (req, res) => {
    const product = await Product.findById(req.params.id);
    res.render("admin/editProduct", { product });
});

// Save edit
router.post("/edit/:id", async (req, res) => {
    const { name, price, description, imageUrl } = req.body;

    await Product.findByIdAndUpdate(req.params.id, {
        name,
        price,
        description,
        imageUrl
    });

    res.redirect("/users/admin/products");
});

// Public product page
router.get("/view/:id", async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.send("Product not found");

  res.render("product", { product });
});


// Delete
router.get("/delete/:id", async (req, res) => {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect("/users/admin/products");
});

module.exports = router;
