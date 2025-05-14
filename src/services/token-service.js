
const OAuthService = require('./oauth-service');

const tokenCache = new Map();
const tokenLocks = new Map();

class TokenService {
  static async getToken(itemId) {
    const cached = tokenCache.get(itemId);
    if (cached) {
      if (Date.now() - cached.timestamp < 45 * 60 * 1000) {
        return cached.accessToken;
      }
      
      // Token expired, refresh it
      try {
        const refreshed = await OAuthService.refreshToken(cached.refreshToken);
        tokenCache.set(itemId, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          timestamp: Date.now()
        });
        return refreshed.access_token;
      } catch (error) {
        console.error('Token refresh failed:', error);
        tokenCache.delete(itemId);
        throw new Error('Failed to get valid token');
      }
    }

    throw new Error('No token available - OAuth flow required');
  }

  static setTokens(itemId, accessToken, refreshToken) {
    tokenCache.set(itemId, {
      accessToken,
      refreshToken,
      timestamp: Date.now()
    });
  }

  static clearToken(itemId) {
    tokenCache.delete(itemId);
    tokenLocks.delete(itemId);
  }
}

module.exports = TokenService;
