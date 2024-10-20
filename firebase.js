const admin = require('firebase-admin');
require('dotenv').config()
const credentials = JSON.parse(process.env.SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(credentials)
});

module.exports = { admin };