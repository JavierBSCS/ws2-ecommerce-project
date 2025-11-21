function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).send("You must be logged in to access this page.");
  }
  next();
}

module.exports = requireLogin;
