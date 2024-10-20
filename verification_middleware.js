const firebase_instance = require("./firebase");

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization; // Extract token from the "Authorization" header
  
  if (!token) {
    return res.status(403).send("Unauthorized");
  }

  try {
    const decodedToken = await firebase_instance.admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Attach the decoded token (user info) to the request object
    next();
  } catch (error) {
    return res.status(403).send("Error in verification");
  }
};

module.exports = verifyToken;
