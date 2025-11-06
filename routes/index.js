// routes/index.js
const express = require('express');
const router = express.Router();

// Home route
router.get('/', (req, res) => {
  res.render('index', { 
    title: "Home Page", 
    message: "Hello, MongoDB is connected!" 
  });
});

// About route
router.get('/about', (req, res) => {
  res.render('about', {
    title: 'About Me',
    name: 'Your Full Name',
    description: 'I am a web systems student building projects with Node.js, Express, and EJS.'
  });
});

module.exports = router;
