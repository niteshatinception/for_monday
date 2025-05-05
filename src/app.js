require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const routes = require('./routes');
const { default: axios } = require('axios');
const qs = require('querystring');

const { PORT: port } = process.env;
const app = express();

app.use(bodyParser.json());
app.use(routes);
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is missing' });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      'https://auth.monday.com/oauth2/token',
      qs.stringify({
        code,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token } = tokenResponse.data;
    console.log("ACCESS_TOKEN => ",  access_token);
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to authenticate with Monday.com' });
  }
});
app.listen(port, () => {
  console.log(`Transform text integration listening on port ${port}`)
});

module.exports = app;
