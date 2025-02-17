const newrelic = require('newrelic');
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
const firebase_instance = require('./firebase');
const verifyToken = require("./verification_middleware");
const { getMessaging } = require('firebase-admin/messaging');
require('dotenv').config();

const app = express();
const port = 3000;
const server = http.createServer(app);

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

function getSearchersSendNotification(latitude, longitude, latestLeavingID, times_skipped = 0, time = "") {
  let countNum = null;
  try {
    connection.query("SELECT COUNT(1) AS countNum WHERE EXISTS (SELECT * FROM searching)", (err, results) => {
      if (!err && results[0].countNum && results[0].countNum > 0) {
        console.log(results[0].countNum);
        var query = "SELECT id, user_id, `time` FROM searching WHERE(ST_Distance_Sphere(point(center_longitude, center_latitude), point(" + longitude + ", " + latitude + "))) <= 500 ORDER BY `time` ASC";
        connection.query(query, (err, searcher) => {
          if (typeof searcher[times_skipped] !== 'undefined') {
            //getCarType(searcher[0].user_id);
            connection.query("SELECT carType, fcm_token FROM users WHERE user_id=?", searcher[times_skipped].user_id, (err, results) => {
              if (!err && results[0] != null) {
                // wss.clients.forEach((client) => {
                //   if (searcher[times_skipped].user_id && client.id === searcher[times_skipped].user_id && client.readyState === WebSocket.OPEN) {
                //     client.send(JSON.stringify({latestLeavingID: latestLeavingID, _latitude: latitude, _longitude:longitude, carType:results[0].carType, times_skipped: times_skipped, time: searcher[times_skipped].time}));
                //   }
                // });
                getAccessToken().then(function (accessToken) {
                  console.log(accessToken);
                  fetch("https://fcm.googleapis.com/v1/projects/pasthelwparking/messages:send", {
                    method: "POST",
                    body: JSON.stringify({
                      message:
                      {
                        token: results[0].fcm_token,
                        // notification: {
                        //   title: "A parking spot is free!",
                        //   body: "Someone just left an empty parking for you!"
                        // },
                        data: {
                          lat: latitude.toString(),
                          long: longitude.toString(),
                          user_id: searcher[0].user_id,
                          cartype: results[0].carType,
                          time: searcher[0].time.toString(),
                          id: searcher[0].id.toString(),
                          times_skipped: times_skipped.toString(),
                          latestLeavingID: latestLeavingID.toString()
                        },
                        android: {
                          notification: {
                            click_action: "FLUTTER_NOTIFICATION_CLICK"
                          }
                        }
                      }
                    }
                    ),
                    headers: {
                      "Content-type": "application/json;",
                      "Authorization": 'Bearer ' + accessToken
                    }
                  })
                });

              }
            });
          }
        }
        );
      }
      else if (!err && results[0].countNum && results[0].countNum == 0) {

      }
    });
  }
  catch { }
}


// Use body-parser middleware to parse incoming requests
app.use(bodyParser.json());

app.post('/parking-skipped', verifyToken, (req, res) => {
  try {
    const times_skipped = req.body["times_skipped"];
    const time = req.body["time"];
    const latitude = req.body["latitude"];
    const longitude = req.body["longitude"];
    const latestLeavingID = req.body["latestLeavingID"];
    getSearchersSendNotification(latitude, longitude, latestLeavingID, times_skipped);
    res.send("Parking skipped");
  }
  catch { }
});

app.post('/set-claimedby', verifyToken, (req, res) => {
  try {
    const userid = req.body["user_id"];
    const latestLeavingID = req.body["latestLeavingID"];
    connection.query("UPDATE leaving SET claimedby_id=? WHERE id=?", [userid, latestLeavingID]);
    connection.query("DELETE FROM searching WHERE user_id=?", [userid]);
  }
  catch { }
});

// Define routes for GET and POST requests  TODO POST
app.get('/login-user', verifyToken, async  (req, res) => {
  try {
    const email = req.query.email;
    const password = req.query.password;
    connection.query('SELECT user_id, carType, password FROM users WHERE email=?', [email, password], async (err, results) => {
      if(!results)
      {
        res.status(401).send('Error authenticating user.');
        return;
      }
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

app.post('/register-user', verifyToken, async (req, res) => {
  try {
    // Extract the user data from the request body
    const { uid, email, password, fcm_token } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    // const response = await firebase_instance.admin.auth().createUser({
    //   email: email,
    //   password: hashedPassword,
    //   emailVerified: false,
    //   disabled: false
    // });
    // Perform an INSERT query to add the user to the database
    connection.query('INSERT INTO users (user_id, email, password, fcm_token) VALUES (?,?,?,?)', [uid, email, hashedPassword, fcm_token], (err, result) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'register-user');
        return;
      }
      res.status(200).send();
    });
  }
  catch (err){ 
    logToNewRelic(err.message, 'register-user');
  }
});

app.delete('/delete-user', verifyToken, (req, res) => {
  try{
    const userID = req.body["userID"];
    connection.query("DELETE FROM users WHERE user_id = ?", [email], (err, result) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'delete-user');
        return;
      }
      res.status(200).send();
  });
  }
  catch (err){
    logToNewRelic(err.message, 'delete-user');
  }
});

app.post('/add-searching', verifyToken, (req, res) => {
  try {
    //const user_id_body = JSON.parse(req.body["user_id"]);
    const user_id = req.body["user_id"];//user_id_body.results[0].user_id;
    const latitude = req.body["lat"];
    const longitude = req.body["long"];
    connection.query("INSERT INTO searching (center_latitude, center_longitude, user_id) VALUES(?, ?, ?)", [latitude, longitude, user_id], (err, result) => {
      if (err) {
        console.error('Error inserting searcher: ', err);
        res.status(506).send('Error inserting searcher: ', err);
        return;
      }
      //res.send("Inserted search successfully");
    });
  }
  catch { }
});

app.post('/add-leaving', verifyToken, (req, res) => {
  try {
    const currentDateTime = new Date();
    const user_id = req.body["user_id"];//user_id_body.results[0].user_id;
    const latitude = req.body["lat"];
    const longitude = req.body["long"];
    connection.query("INSERT INTO leaving (latitude, longitude, user_id, time) VALUES(?, ?, ?, ?)", [latitude, longitude, user_id, currentDateTime], (err, result) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'add-leaving');
        return;
      }
      res.status(200).send();
      notifyUsers(parseFloat(latitude), parseFloat(longitude), "add");
    });
  }
  catch (err){
    logToNewRelic(err.message, 'add-leaving');
   }
});

app.put('/update-userid', verifyToken, (req, res) => {
  try {
    const user_id = req.body["user_id"];
    const email = req.body["email"];
    connection.query("UPDATE users SET user_id=? WHERE email=?", [user_id, email], (err, result) => {

    });
  }
  catch { }
});

app.post('/update-center', verifyToken, (req, res) => {
  try {
    const user_id = req.body["user_id"];
    const latitude = req.body["lat"];
    const longitude = req.body["long"];
    connection.query("UPDATE searching SET center_latitude=?, center_longitude=? WHERE user_id = ?", [latitude, longitude, user_id], (err, result) => {
      if (err) {
        console.error('Error updating center: ', err);
        res.status(506).send('Error updating center: ', err);
        return;
      }
      res.send("Center updated successfully");
    });
  }
  catch { }
});

app.delete('/cancel-search', verifyToken, (req, res) => {
  try {
    const user_id = req.body["user_id"];
    connection.query("DELETE FROM searching WHERE user_id=?", [user_id]);
  }
  catch { }
});

// Define a route for retrieving the latest record ID
app.get('/user-car-type', verifyToken, (req, res) => {
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

app.delete('/delete-leaving', verifyToken, (req, res) => {
  try {
    const leavingID = req.body["leavingID"];
    connection.query("DELETE FROM leaving WHERE ID=?", [leavingID]);
  }
  catch { }
});

app.post('/delete-marker', verifyToken, (req, res) => {
  try {
    const latitude = req.body["latitude"];
    const longitude = req.body["longitude"];
    const topic = req.body["topic"];
    connection.query("DELETE FROM leaving WHERE latitude=? AND longitude=?", [latitude, longitude], (err, result) => {
      if(err){
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'delete-marker');
        return;
      }
    });
    res.status(200).send();
    notifyUsers(notifyUsers(parseFloat(latitude), parseFloat(longitude)), "delete");
  }
  catch (err){
    logToNewRelic(err.message, 'delete-marker');
   }
});

// Define a route for retrieving the latest coordinates
app.get('/latest-coordinates', verifyToken, (req, res) => {
  try {
    // Extract the latest record ID from the request query parameters
    const latestRecordID = req.query.latestRecordID;

    // Perform a SELECT query to retrieve the latest coordinates from the database
    connection.query(`SELECT latitude, longitude FROM leaving WHERE id=$latestRecordID`, (err, results) => {
      if (err) {
        console.error('Error retrieving latest coordinates: ', err);
        res.status(500).send('Error retrieving latest coordinates');
        return;
      }
      const latestCoordinates = results[0];
      res.send({ latestCoordinates });
    });
  }
  catch { }
});

// Define a route for tracking changes in real-time
app.get('/track-changes', verifyToken, (req, res) => {
  try {
    const query = "SELECT MAX(id) AS latest_id, user_id, longitude, latitude FROM leaving where claimedby_id IS NULL";
    // Set up a timer to periodically retrieve the latest record ID and coordinates
    const interval = setInterval(() => {
      // Perform a SELECT query to retrieve the latest record ID and coordinates
      connection.query(query, (err, results) => {
        if (err) {
          console.error('Error retrieving latest record ID : ', err);
          return;
        }
        const latestLeavingID = results[0].latest_id;
        const longitude = results[0].longitude;
        const latitude = results[0].latitude;
        //previousLeavingID = 605;
        if (previousLeavingID != -1) {
          if (latestLeavingID != previousLeavingID) {
            //find who to send notification to
            var searching = getSearchersSendNotification(latitude, longitude, latestLeavingID);
            console.log(searching);

            previousLeavingID = latestLeavingID;
          }
        }
        else
          previousLeavingID = latestLeavingID;
      });
    }, 1000);
  }
  catch { }
});

app.post('/register-fcmToken', verifyToken, (req, res) => {
  try {
    //CHANGE: only update if there the token isnt registered to anyone
    const user_id = req.body["user_id"];//user_id_body.results[0].user_id;
    const fcm_token = req.body["fcmtoken"];
    connection.query("UPDATE users SET fcm_token=? where user_id=?", [fcm_token, user_id], (err, result) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'register-fcmToken');
        return;
      }
      res.status(200).send();
    });
  }
  catch (err){
    logToNewRelic(err.message, 'register-fcmToken');
   }
});

app.post('/get-userid', verifyToken, (req, res) => {
  try {
    const email = req.body["email"];
    connection.query('SELECT user_id FROM users WHERE email=?', [email], (err, results) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'get-userid');
        return;
      }
      const user_id = results[0].user_id;
      res.send({ user_id });
    });
  }
  catch (err){
    logToNewRelic(err.message, 'get-userid');
   }
});

app.post('/get-latlon', verifyToken, (req, res) => {
  try {
    const userid = req.body["userid"];
    connection.query('SELECT center_latitude, center_longitude FROM searching WHERE user_id = ?', [userid], (err, results) => {
      if (err) {
        console.error('Error getting latitude/longitude: ', err);
        res.status(506).send('Error getting latitude/longitude: ', err);
        return;
      }
      res.send(JSON.stringify({ results }));
    });
  }
  catch {

  }
});

app.post('/get-points', verifyToken, (req, res) => {
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

app.post('/update-points', verifyToken, (req, res) => {
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

app.post('/register-car', verifyToken, (req, res) => {
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

app.post('/userid-exists', verifyToken, (req, res) => {
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
  catch (err){
    logToNewRelic(err.message, 'userid-exists');
   }
});

// API to get markers within bounds
app.get('/markers', verifyToken, (req, res) => {
  try {
    const bounds = {
      swLat: parseFloat(req.query.swLat) - 0.004, // Southwest latitude
      swLng: parseFloat(req.query.swLng) - 0.004, // Southwest longitude
      neLat: parseFloat(req.query.neLat) + 0.004, // Northeast latitude
      neLng: parseFloat(req.query.neLng) + 0.004   // Northeast longitude
    };
    let markersInBounds = [];
    const query = "SELECT user_id, longitude, latitude FROM leaving where claimedby_id IS NULL";
    connection.query(query, (err, results) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'markers');
        return;
      }
      // Filter markers within the bounds
      const markersInBounds = results.filter(marker => isMarkerWithinBounds(marker, bounds));
      // Return filtered markers
      res.status(200).json(markersInBounds);
    });
  }
  catch (err) {
    logToNewRelic(err.message, 'markers');
  }
});

app.post('/update-bounds', verifyToken, (req, res) => {
  try {
    const email = req.body["email"];
    const swLat = req.body["sw_lat"].replace(',', '.');
    const swLong = req.body["sw_long"].replace(',', '.');
    const neLat = req.body["ne_lat"].replace(',', '.');
    const neLong = req.body["ne_long"].replace(',', '.');
    connection.query("UPDATE users SET sw_latitude=?, sw_longitude=?, ne_latitude=?, ne_longitude=? where email=?", [swLat, swLong, neLat, neLong, email], (err, result) => {
      if (err) {
        res.status(500).send('Server error.');
        logToNewRelic(err.message, 'update-bounds');
        return;
      }
      res.status(200).send();
    });
  }
  catch (err) {
    logToNewRelic(err.message, 'update-bounds');
  }
});

// Function to check if a marker is within bounds
function isMarkerWithinBounds(marker, bounds) {
  return marker.latitude >= bounds.swLat && marker.latitude <= bounds.neLat &&
    marker.longitude >= bounds.swLng && marker.longitude <= bounds.neLng;
}

function notifyUsers(latitude, longitude, type) {
  try {
    connection.query("SELECT fcm_token FROM users WHERE (sw_latitude - 0.004) <= ? AND (ne_latitude + 0.004) >= ? AND (sw_longitude - 0.004) <= ? AND (ne_longitude + 0.004) >= ?", [latitude, latitude, longitude, longitude], (err, result) => {
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
                  data: {
                    lat: latitude.toString(),
                    long: longitude.toString(),
                    update: "false",
                    type: type
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

function notifyUsersToUpdate(topic) {
  try {
    const message = {
      data: {
        score: '850',
        time: '2:45'
      },
      to: '/topics/' + topic
    };
        getAccessToken().then(function (accessToken) {
            fetch("https://fcm.googleapis.com/v1/projects/pasthelwparking/messages:send", {
              method: "POST",
              body: JSON.stringify(
                {
                 message:
                 {
                  topic: topic,
                  data: {
                    update: "true"
                  },
                }
              }
              ),
              headers: {
                "Content-type": "application/json",
                "Authorization": 'Bearer ' + accessToken
              }
            })

        });
      }
  catch {

  }
}

function clearTwentyMinutesOld(){
  try{
    var topicsList = [];
    const twentyMinutesAgo = new Date(Date.now() -  5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const query = "SELECT id, user_id, longitude, latitude FROM leaving where time < ?";
    connection.query(query, [twentyMinutesAgo], (err, results) => {
      if (err) {
        newrelic.recordCustomEvent('CustomError', { message: err.message });
        console.error('Error retrieving latest record ID : ', err);
        return;
      }
      connection.query("DELETE FROM leaving WHERE time < ?", [twentyMinutesAgo]);
      for (j = 0; j < results.length; j++) {
        const marker = {
          latitude: results[j].latitude,
          longitude: results[j].longitude
        }
        var topic = getCellTopic(results[j].latitude, results[j].longitude);
        if(!topicsList.includes(topic)){
          notifyUsersToUpdate(topic);
          topicsList.push(topic);
        }
      }
    });
  }catch{

  }
}

function getCellTopic(latitude, longitude) {
  const gridCellSize = 0.05;
  const latCell = Math.floor(latitude / gridCellSize);
  const lngCell = Math.floor(longitude / gridCellSize);
  const cellTopic = `thessaloniki_${latCell}_${lngCell}`;
  
  return cellTopic;
}

function logToNewRelic(errorMsg, origin){
  var url = process.env.NEW_RELIC_URL;
  const response = fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': process.env.NEW_RELIC_LICENSE_KEY
    },
    body: JSON.stringify({
      timestamp: Date.now(),
      message: errorMsg,
      logtype: origin
    })
  })
}

setInterval(clearTwentyMinutesOld, 1 * 60 * 1000);

// Start the server
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});