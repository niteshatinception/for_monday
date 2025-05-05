
const router = require('express').Router();
const { authenticationMiddleware } = require('../middlewares/authentication');
const mondayController = require('../controllers/monday-controller');
const OAuthService = require('../services/oauth-service');
const TokenService = require('../services/token-service');
// const { default: axios } = require('axios');
// const qs = require('querystring');

router.post('/monday/copy_move_file_column', authenticationMiddleware, mondayController.copyFileFromColumnToColumn);

router.get('/oauth/start', async (req, res) => {
  const { itemId } = req.query;
  console.log(itemId);
  
  const authUrl = OAuthService.getAuthUrl(itemId);
  res.redirect(authUrl);
});

// router.get('/oauth/callback', async (req, res) => {
//   const { code , state } = req.query;
//   console.log(code , state);
  
//   if (!code) {
//     return res.status(400).json({ error: 'Authorization code is missing' });
//   }

//   try {
//     // Exchange code for access token
//     const tokenResponse = await axios.post(
//       'https://auth.monday.com/oauth2/token',
//       qs.stringify({
//         code,
//         client_id: process.env.CLIENT_ID,
//         client_secret: process.env.CLIENT_SECRET,
//         grant_type: 'authorization_code',
//         // redirect_uri: process.env.REDIRECT_URI, // Ensure this matches your Monday.com app settings
//       }),
//       {
//         headers: {
//           'Content-Type': 'application/x-www-form-urlencoded',
//         },
//       }
//     );

//     const { access_token } = tokenResponse.data;
//     console.log(access_token);
//     res.send(`
//       <!DOCTYPE html>
//       <html>
//         <head>
//           <script src="https://cdn.monday.com/monday-sdk-js/0.5.4/monday-sdk-js.js"></script>
//         </head>
//         <body>
//           <script>
//             const monday = window.mondaySdk();
//             monday.execute("openAppFeatureModal", {
//               url: "/",
//               width: 800,
//               height: 600
//             });
//           </script>
//           <p>Redirecting you back to the app...</p>
//         </body>
//       </html>
//     `);
    
//   } catch (error) {
//     console.error('Token exchange error:', error.response?.data || error.message);
//     res.status(500).json({ error: 'Failed to authenticate with Monday.com' });
//   }
// });

// router.get('/oauth/callback', async (req, res) => {
//   try {
//     console.log('OAuth callback query parameters:', req.query);
//     const { code, state, error } = req.query;
    
//     if (error) {
//       console.error('OAuth error:', error);
//       return res.status(400).send(`OAuth error: ${error}`);
//     }

//     if (!code) {
//       console.error('Missing code parameter');
//       return res.status(400).send('Missing authorization code');
//     }

//     if (!state) {
//       console.error('Missing state parameter');
//       return res.status(400).send('Missing state parameter');
//     }

//     const storedState = OAuthService.stateStore.get(state);
//     console.log(state);
    
//     if (!storedState) {
//       console.error('Invalid or expired state parameter');
//       return res.status(400).send('Invalid or expired state parameter');
//     }

//     const itemId = storedState.itemId;
//     OAuthService.stateStore.delete(state); // Clean up used state

//     const tokenData = await OAuthService.getAccessToken(code);
//     await TokenService.setTokens(state, tokenData.access_token, tokenData.refresh_token);

//     res.send(`
//       <!DOCTYPE html>
//       <html>
//         <head>
//           <script src="https://cdn.monday.com/monday-sdk-js/0.5.4/monday-sdk-js.js"></script>
//         </head>
//         <body>
//           <script>
//             const monday = window.mondaySdk();
//             monday.execute("openAppFeatureModal", {
//               url: "/",
//               width: 800,
//               height: 600
//             });
//           </script>
//           <p>Redirecting you back to the app...</p>
//         </body>
//       </html>
//     `);
//   } catch (err) {
//     console.error("OAuth callback error:", err);
//     res.status(500).send("OAuth authentication failed");
//   }
// });

module.exports = router;

module.exports = router;
