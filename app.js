const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const WebSocket = require('ws');
const http = require('http');
const uuidv4 = require('uuid').v4;
const https = require('https');
const bcrypt = require('bcrypt');
const { google } = require('googleapis');
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SCOPES = [MESSAGING_SCOPE];
require('dotenv').config()

const app = express();
const port = 3000;
const server = http.createServer(app)

// Create a MySQL connection
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});
const wss = new WebSocket.Server({ server });
var previousLeavingID = -1;
var uniqueID = '';

wss.getUniqueID = function () {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  }
  return s4() + s4() + '-' + s4();
};

wss.on('connection', function (ws) {
  console.log('new connection');
  ws.id = wss.getUniqueID();
  uniqueID = ws.id;
  ws.send(JSON.stringify({ userIDForCache: ws.id }));
});

connection.connect((err) => {
  if (err) {
    console.error('Error connecting to database: ', err);
    res.status(505).send('Error connecting to database.: ', err);
    return;
  }
  console.log('Connected to database!');
});

function getAccessToken() {
  return new Promise(function (resolve, reject) {
    //const key = require('./service-account.json');
    const key = JSON.parse(process.env.SERVICE_ACCOUNT);
    const jwtClient = new google.auth.JWT(
      key.client_email,
      null,
      key.private_key,
      SCOPES,
      null
    );
    jwtClient.authorize(function (err, tokens) {
      if (err) {
        reject(err);
        return;
      }
      resolve(tokens.access_token);
    });
  });
}


// Use body-parser middleware to parse incoming requests
app.use(bodyParser.json());

// Define routes for GET and POST requests  TODO POST
app.get('/login-user', async  (req, res) => {
  try {
    const email = req.query.email;
    const password = req.query.password;
    connection.query('SELECT user_id, carType, password FROM users WHERE email=?', [email, password], async (err, results) => {
      var stored = results[0].password;
      const passwordMatch = await bcrypt.compare(password, stored);
      if (err || !results[0].user_id || !passwordMatch) {
        console.error('Error at login: ', err);
        res.status(401).send('Error authenticating user.');
        return;
      }
      res.send(JSON.stringify({ results, status: "Login successful", carType: results[0].carType }));
    });
  }
  catch { }
});

app.post('/register-user', async (req, res) => {
  try {
    // Extract the user data from the request body
    const { name, email, password } = req.body;
    const uuid = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    // Perform an INSERT query to add the user to the database
    connection.query('INSERT INTO users (username, email, password, user_id) VALUES (?,?,?,?)', [name, email, hashedPassword, uuid], (err, result) => {
      if (err) {
        console.error('Error adding user: ', err);
        res.status(500).send('Error adding user');
        return;
      }
      res.send('User added successfully');
    });
  }
  catch { }
});

app.post('/add-leaving', (req, res) => {
  try {
    //const user_id_body = JSON.parse(req.body["user_id"]);
    const user_id = req.body["user_id"];//user_id_body.results[0].user_id;
    const latitude = req.body["lat"];
    const longitude = req.body["long"];
    connection.query("INSERT INTO leaving (latitude, longitude, user_id) VALUES(?, ?, ?)", [latitude, longitude, user_id], (err, result) => {
      if (err) {
        console.error('Error inserting leaving: ', err);
        res.status(507).send('Error inserting leaving: ', err);
        return;
      }
      //res.send("Inserted search successfully");
      notifyUsers(parseFloat(latitude), parseFloat(longitude));
    });
  }
  catch { }
});

app.put('/update-userid', (req, res) => {
  try {
    const user_id = req.body["user_id"];
    const email = req.body["email"];
    connection.query("UPDATE users SET user_id=? WHERE email=?", [user_id, email], (err, result) => {

    });
  }
  catch { }
});

// Define a route for retrieving the latest record ID
app.get('/user-car-type', (req, res) => {
  try {
    // Perform a SELECT query to retrieve the latest record ID from the database
    connection.query('SELECT carType FROM users WHERE user_id=?', [req.params], (err, results) => {
      if (err) {
        console.error('Error retrieving carType: ', err);
        res.status(506).send('Error retrieving carType: ', err);
        return;
      }
      const latestRecordID = results[0].carType;
      res.send({ carType });
    });
  }
  catch { }
});


app.post('/register-fcmToken', (req, res) => {
  try {
    //CHANGE: only update if there the token isnt registered to anyone
    const user_id = req.body["user_id"];//user_id_body.results[0].user_id;
    const fcm_token = req.body["fcm_token"];
    connection.query("UPDATE users SET fcm_token=? where user_id=?", [fcm_token, user_id], (err, result) => {
      if (err) {
        console.error('Error inserting fcm: ', err);
        res.status(506).send('Error inserting fcm: ', err);
        return;
      }
      //res.send("Inserted search successfully");
    });
  }
  catch { }
});

app.post('/get-userid', (req, res) => {
  try {
    const email = req.body["email"];
    connection.query('SELECT user_id FROM users WHERE email=?', [email], (err, results) => {
      if (err) {
        console.error('Error retrieving carType: ', err);
        res.status(506).send('Error retrieving carType: ', err);
        return;
      }
      const user_id = results[0].user_id;
      res.send({ user_id });
    });
  }
  catch { }
});

app.post('/get-points', (req, res) => {
  try {
    const user_id = req.body["user_id"];
    connection.query('SELECT points FROM users WHERE user_id=?', [user_id], (err, results) => {
      if (err) {
        console.error(`Error retrieving points for user_id: ${user_id}`, err);
        res.status(506).send('Error retrieving points for user_id: ', err);
        return;
      }
      const points = results[0].points;
      res.send({ points });
    });
  }
  catch { }
});

app.post('/update-points', (req, res) => {
  try {
    const user_id = req.body["user_id"];
    const updatedPoints = req.body["points"];
    connection.query("UPDATE users SET points=? WHERE user_id = ?", [updatedPoints, user_id], (err, result) => {
      if (err) {
        console.error(`Error updating points for user_id: ${user_id}`, err);
        res.status(506).send('Error updating points: ', err);
        return;
      }
      res.send("Points updated successfully");
    });
  }
  catch { }
});

app.post('/register-car', (req, res) => {
  try {
    const { carType, email } = req.body;
    connection.query('UPDATE users SET carType=? WHERE email = ?', [carType, email], (err, result) => {
      if (err) {
        console.error('Error registering car: ', err);
        res.status(500).send('Error registering car');
        return;
      }
      res.send('Car registered successfully');
    });
  }
  catch { }
});

app.post('/userid-exists', (req, res) => {
  try {
    const { user_id } = req.body;
    connection.query("SELECT * FROM leaving WHERE user_id=?", [user_id], (err, result) => {
      if (err) {
        console.error('Error finding user ', err);
        res.status(500).send('EError finding user');
        return;
      }
      res.send('User found successfully');
    });
  }
  catch { }
});

// API to get markers within bounds
app.get('/markers', (req, res) => {
  try {
    const bounds = {
      swLat: parseFloat(req.query.swLat), // Southwest latitude
      swLng: parseFloat(req.query.swLng), // Southwest longitude
      neLat: parseFloat(req.query.neLat), // Northeast latitude
      neLng: parseFloat(req.query.neLng)  // Northeast longitude
    };
    let markersInBounds = [];
    const query = "SELECT user_id, longitude, latitude FROM leaving where claimedby_id IS NULL";
    connection.query(query, (err, results) => {
      if (err) {
        console.error('Error retrieving latest record ID : ', err);
        return;
      }
      // Filter markers within the bounds
      const markersInBounds = results.filter(marker => isMarkerWithinBounds(marker, bounds));
      // Return filtered markers
      res.json(markersInBounds);
    });
  }
  catch {

  }
});

app.post('/update-bounds', (req, res) => {
  try {
    const email = req.body["email"];
    const swLat = req.body["sw_lat"].replace(',', '.');
    const swLong = req.body["sw_long"].replace(',', '.');
    const neLat = req.body["ne_lat"].replace(',', '.');
    const neLong = req.body["ne_long"].replace(',', '.');
    connection.query("UPDATE users SET sw_latitude=?, sw_longitude=?, ne_latitude=?, ne_longitude=? where email=?", [swLat, swLong, neLat, neLong, email], (err, result) => {
      if (err) {
        console.error('Error updateing bounds: ', err);
        res.status(506).send('Error inserting fcm: ', err);
        return;
      }
      //res.send("Inserted search successfully");
    });
  }
  catch {

  }
});

// Function to check if a marker is within bounds
function isMarkerWithinBounds(marker, bounds) {
  return marker.latitude >= bounds.swLat && marker.latitude <= bounds.neLat &&
    marker.longitude >= bounds.swLng && marker.longitude <= bounds.neLng;
}

function notifyUsers(latitude, longitude) {
  try {
    connection.query("SELECT fcm_token FROM users WHERE sw_latitude <= ? AND ne_latitude >= ? AND sw_longitude <= ? AND ne_longitude >= ?", [latitude, latitude, longitude, longitude], (err, result) => {
      if (err) {
        console.error('Error getting users from bounds', err);
        return;
      }
      else {
        getAccessToken().then(function (accessToken) {
          console.log(accessToken);
          for (i = 0; i < result.length; i++) {
            fetch("https://fcm.googleapis.com/v1/projects/pasthelwparking/messages:send", {
              method: "POST",
              body: JSON.stringify({
                message:
                {
                  token: result[i].fcm_token,
                  // notification: {
                  //   title: "A parking spot is free!",
                  //   body: "Someone just left an empty parking for you!"
                  // },
                  data: {
                    lat: latitude.toString(),
                    long: longitude.toString(),
                    //user_id: searcher[i].user_id,
                    //cartype: results[i].carType,
                    //time: searcher[i].time.toString(),
                    //id: searcher[i].id.toString(),
                    //times_skipped: times_skipped.toString(),
                    //latestLeavingID: latestLeavingID.toString()
                  },
                }
              }
              ),
              headers: {
                "Content-type": "application/json;",
                "Authorization": 'Bearer ' + accessToken
              }
            })
          }
        });
        result.fcm_token
      }
    });
  }
  catch {

  }
}

// Start the server
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});