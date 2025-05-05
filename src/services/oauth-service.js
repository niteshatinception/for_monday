
const fetch = require('node-fetch');

class OAuthService {
  static stateStore = new Map();
  static TOKEN_EXPIRY = 5 * 60 * 1000; // 5 minutes

  static getAuthUrl(contextData = {}) {
    try {
      const state = `${Date.now()}_${Math.random().toString(36).substring(2)}`;
      
      // Store context with timestamp
      this.stateStore.set(state, {
        ...contextData,
        timestamp: Date.now()
      });

      // Schedule cleanup
      setTimeout(() => this.cleanupState(state), this.TOKEN_EXPIRY);

      const params = new URLSearchParams({
        client_id: process.env.MONDAY_CLIENT_ID,
        redirect_uri: process.env.MONDAY_OAUTH_REDIRECT_URI,
        state: state,
        scope: 'me:read boards:read boards:write'
      });

      return `https://auth.monday.com/oauth2/authorize?${params.toString()}`;
    } catch (error) {
      console.error('Error generating auth URL:', error);
      throw new Error('Failed to generate authorization URL');
    }
  }

  static async getAccessToken(code) {
    if (!code) {
      throw new Error('Authorization code is required');
    }

    try {
      const response = await fetch('https://auth.monday.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: process.env.MONDAY_CLIENT_ID,
          client_secret: process.env.MONDAY_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: process.env.MONDAY_OAUTH_REDIRECT_URI
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OAuth token request failed: ${response.status} - ${errorData}`);
      }

      return response.json();
    } catch (error) {
      console.error('Error getting access token:', error);
      throw new Error('Failed to obtain access token');
    }
  }

  static async refreshToken(refreshToken) {
    if (!refreshToken) {
      throw new Error('Refresh token is required');
    }

    try {
      const response = await fetch('https://auth.monday.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: process.env.MONDAY_CLIENT_ID,
          client_secret: process.env.MONDAY_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OAuth refresh failed: ${response.status} - ${errorData}`);
      }
      console.log(response);
      
      return response.json();
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw new Error('Failed to refresh token');
    }
  }

  static getStateData(state) {
    const data = this.stateStore.get(state);
    if (!data) {
      return null;
    }

    // Check if state has expired
    if (Date.now() - data.timestamp > this.TOKEN_EXPIRY) {
      this.cleanupState(state);
      return null;
    }

    return data;
  }

  static cleanupState(state) {
    if (this.stateStore.has(state)) {
      this.stateStore.delete(state);
    }
  }

  static validateState(state) {
    if (!state) {
      throw new Error('State parameter is required');
    }

    const stateData = this.getStateData(state);
    if (!stateData) {
      throw new Error('Invalid or expired state');
    }

    return stateData;
  }
}

module.exports = OAuthService;
