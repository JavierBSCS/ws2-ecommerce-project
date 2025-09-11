// middleware/auth.js
function requireLogin(req, res, next) {
  if (!req.session.user) {
    // session expired or not logged in
    return res.redirect('/users/login?expired=1');
  }
  next();
}

module.exports = requireLogin;
