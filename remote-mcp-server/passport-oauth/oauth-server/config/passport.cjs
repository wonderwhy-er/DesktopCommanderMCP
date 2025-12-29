/**
 * Passport.js Configuration
 * Sets up authentication strategies for OAuth server
 */

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const userStore = require('../models/oauth-server/models/user.cjs');

/**
 * Configure Local Strategy for user authentication
 */
passport.use(new LocalStrategy(
  {
    usernameField: 'email',
    passwordField: 'password'
  },
  async (email, password, done) => {
    try {
      const user = userStore.validateCredentials(email, password);
      
      if (!user) {
        return done(null, false, { 
          message: 'Invalid email or password' 
        });
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

/**
 * Serialize user for session storage
 */
passport.serializeUser((user, done) => {
  done(null, user.id);
});

/**
 * Deserialize user from session
 */
passport.deserializeUser((id, done) => {
  try {
    const user = userStore.findById(id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

/**
 * Middleware to ensure user is authenticated
 */
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  
  // For demo mode, auto-login demo user
  if (process.env.DEMO_MODE === 'true') {
    const demoUser = userStore.findByEmail(process.env.DEMO_USER_EMAIL || 'test@example.com');
    if (demoUser) {
      req.login(demoUser, (err) => {
        if (err) {
          return next(err);
        }
        return next();
      });
      return;
    }
  }
  
  res.status(401).json({ 
    error: 'authentication_required',
    message: 'User authentication required' 
  });
}

/**
 * Middleware to optionally authenticate user (for consent screen)
 */
function optionalAuthentication(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  // For demo mode, auto-login demo user
  if (process.env.DEMO_MODE === 'true') {
    const demoUser = userStore.findByEmail(process.env.DEMO_USER_EMAIL || 'test@example.com');
    if (demoUser) {
      req.login(demoUser, (err) => {
        if (err) {
          console.error('Auto-login error:', err);
        }
        return next();
      });
      return;
    }
  }

  next();
}

/**
 * Get current user info
 */
function getCurrentUser(req) {
  if (req.isAuthenticated() && req.user) {
    return req.user;
  }
  
  // For demo mode, return demo user
  if (process.env.DEMO_MODE === 'true') {
    return userStore.findByEmail(process.env.DEMO_USER_EMAIL || 'test@example.com');
  }
  
  return null;
}

module.exports = {
  passport,
  ensureAuthenticated,
  optionalAuthentication,
  getCurrentUser
};