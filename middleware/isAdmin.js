// middleware/isAdmin.js
function isAdmin(req, res, next) {
  // Check if user is logged in
  if (!req.session.user) {
    return res.redirect('/users/login');
  }
  
  // Check if user is admin
  if (req.session.user.role !== 'admin') {
    return res.status(403).send('Access denied. Admin only.');
  }
  
  next();
}

module.exports = isAdmin;