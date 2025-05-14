const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const mondaySdk = require('monday-sdk-js');

class OAuthService {
  static async getAuthUrl(context) {
    try {
      const state = jwt.sign(context, process.env.MONDAY_SIGNING_SECRET);
      const params = new URLSearchParams({
        client_id: process.env.MONDAY_CLIENT_ID,
        redirect_uri: process.env.MONDAY_OAUTH_REDIRECT_URI,
        state: state
      });
      return `https://auth.monday.com/oauth2/authorize?${params.toString()}`;
    } catch (error) {
      console.error('Error generating auth URL:', error);
      throw new Error('Failed to generate authorization URL');
    }
  }

  static async exchangeCodeForToken(code) {
    const monday = mondaySdk();
    try {
      const token = await monday.oauthToken(
        code,
        process.env.MONDAY_CLIENT_ID,
        process.env.MONDAY_CLIENT_SECRET
      );
      return token;
    } catch (error) {
      console.error('Error exchanging code for token:', error);
      throw new Error('Failed to exchange code for token');
    }
  }
}

module.exports = OAuthService;