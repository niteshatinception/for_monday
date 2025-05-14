const mondaySdk = require('monday-sdk-js');
const jwt = require('jsonwebtoken');
const monday = mondaySdk();
const router = require('express').Router();
const { authenticationMiddleware } = require('../middlewares/authentication');
const mondayController = require('../controllers/monday-controller');
const { SecureStorage } = require('@mondaycom/apps-sdk');
 
const secureStorage = new SecureStorage(process.env.MONDAY_API_TOKEN);

router.post('/monday/copy_move_file_column', authenticationMiddleware, mondayController.copyFileFromColumnToColumn);
router.post('/monday/copy_move_file_item', authenticationMiddleware, mondayController.copyFileFromItemToItem);
router.post('/monday/copy_move_file_board', authenticationMiddleware, mondayController.copyFileFromBoardToBoard);
router.post('/monday/get_file_columns', authenticationMiddleware, mondayController.getFileColumnsFromBoard);
router.post('/monday/update_column_copy', authenticationMiddleware, mondayController.copyFileFromUpdateToItem);
router.post('/monday/get_options', authenticationMiddleware, mondayController.handleGetRemoteListOptions);

router.get('/auth', async (req, res) => {
  const { token } = req.query;
  const { userId, accountId, backToUrl } = jwt.verify(token, process.env.MONDAY_SIGNING_SECRET);
  const accessToken = await secureStorage.get(userId);
  if (accessToken) {
    return res.redirect(backToUrl); 
  } else {
    const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&state=${token}`;
console.log("TEEEEEEEEEEE",process.env.CLIENT_ID);

    res.redirect(authUrl);
  }
});

router.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  const { userId, accountId, backToUrl } = jwt.verify(state, process.env.MONDAY_SIGNING_SECRET);
  const token = await monday.oauthToken(code, process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  await secureStorage.set(userId, token.access_token);
  res.redirect(backToUrl);
});

module.exports = router;
