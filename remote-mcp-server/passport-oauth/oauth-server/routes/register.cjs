/**
 * OAuth Dynamic Client Registration
 * RFC 7591 implementation
 */

const express = require('express');
const router = express.Router();
const clientStore = require('../models/oauth-server/models/client.cjs');
const { rateLimit } = require('../middleware/auth.cjs');

/**
 * Dynamic Client Registration Endpoint
 * POST /register
 */
router.post('/register', 
  rateLimit(300000, 10), // 10 registrations per 5 minutes
  async (req, res) => {
    try {
      console.log('[OAuth] Client registration request:', JSON.stringify(req.body, null, 2));
      
      const {
        client_name,
        redirect_uris,
        grant_types,
        response_types,
        scope,
        token_endpoint_auth_method
      } = req.body;

      // Validate request
      if (!client_name) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'client_name is required'
        });
      }

      if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'redirect_uris must be a non-empty array'
        });
      }

      // Validate redirect URIs format
      for (const uri of redirect_uris) {
        try {
          const url = new URL(uri);
          // In production, you might want to restrict schemes and hosts
          if (process.env.DEMO_MODE !== 'true') {
            if (!['http:', 'https:'].includes(url.protocol)) {
              return res.status(400).json({
                error: 'invalid_client_metadata',
                error_description: 'redirect_uri must use http or https scheme'
              });
            }
          }
        } catch (error) {
          return res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: `Invalid redirect_uri format: ${uri}`
          });
        }
      }

      // Validate grant types
      const supportedGrantTypes = ['authorization_code', 'refresh_token'];
      const requestedGrantTypes = grant_types || ['authorization_code'];
      
      for (const grantType of requestedGrantTypes) {
        if (!supportedGrantTypes.includes(grantType)) {
          return res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: `Unsupported grant_type: ${grantType}`
          });
        }
      }

      // Validate response types
      const supportedResponseTypes = ['code'];
      const requestedResponseTypes = response_types || ['code'];
      
      for (const responseType of requestedResponseTypes) {
        if (!supportedResponseTypes.includes(responseType)) {
          return res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: `Unsupported response_type: ${responseType}`
          });
        }
      }

      // Validate token endpoint auth method
      const supportedAuthMethods = ['client_secret_post', 'client_secret_basic'];
      const requestedAuthMethod = token_endpoint_auth_method || 'client_secret_post';
      
      if (!supportedAuthMethods.includes(requestedAuthMethod)) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}`
        });
      }

      // Register the client
      const client = clientStore.registerClient({
        client_name,
        redirect_uris,
        grant_types: requestedGrantTypes,
        response_types: requestedResponseTypes,
        scope: scope || 'openid',
        token_endpoint_auth_method: requestedAuthMethod
      });

      console.log(`[OAuth] Registered new client: ${client.client_id} (${client.client_name})`);

      // Return client information (RFC 7591 response)
      const response = {
        client_id: client.client_id,
        client_secret: client.client_secret,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        scope: client.scope,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
        // client_secret_expires_at: 0 // 0 means never expires
      };

      res.status(201).json(response);

    } catch (error) {
      console.error('[OAuth] Client registration error:', error);
      
      if (error.message.includes('redirect_uri')) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: error.message
        });
      }
      
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error during client registration'
      });
    }
  }
);

/**
 * Get Client Registration Information
 * GET /register/:client_id
 */
router.get('/register/:client_id', async (req, res) => {
  try {
    const { client_id } = req.params;
    
    const clientInfo = clientStore.getClientRegistrationInfo(client_id);
    
    if (!clientInfo) {
      return res.status(404).json({
        error: 'invalid_client',
        error_description: 'Client not found'
      });
    }

    res.json({
      ...clientInfo,
      client_id_issued_at: Math.floor(new Date(clientInfo.created_at).getTime() / 1000)
    });

  } catch (error) {
    console.error('[OAuth] Client info retrieval error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error'
    });
  }
});

/**
 * Update Client Registration (Optional - RFC 7592)
 * PUT /register/:client_id
 */
router.put('/register/:client_id', async (req, res) => {
  // For now, return method not allowed
  // This can be implemented if needed for client updates
  res.status(405).json({
    error: 'method_not_supported',
    error_description: 'Client registration updates not currently supported'
  });
});

/**
 * Delete Client Registration (Optional - RFC 7592)
 * DELETE /register/:client_id
 */
router.delete('/register/:client_id', async (req, res) => {
  try {
    const { client_id } = req.params;
    
    // In production, you'd want to authenticate this request
    const deleted = clientStore.deleteClient(client_id);
    
    if (!deleted) {
      return res.status(404).json({
        error: 'invalid_client',
        error_description: 'Client not found'
      });
    }

    console.log(`[OAuth] Deleted client: ${client_id}`);
    res.status(204).send();

  } catch (error) {
    console.error('[OAuth] Client deletion error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error'
    });
  }
});

/**
 * List All Clients (Admin endpoint)
 * GET /admin/clients
 */
router.get('/admin/clients', async (req, res) => {
  try {
    // In production, add admin authentication here
    if (process.env.DEMO_MODE !== 'true') {
      return res.status(403).json({
        error: 'access_denied',
        error_description: 'Admin access required'
      });
    }

    const clients = clientStore.getAllClients().map(client => ({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      scope: client.scope,
      created_at: client.created_at,
      preregistered: client.preregistered
    }));

    res.json({ clients });

  } catch (error) {
    console.error('[OAuth] Admin clients list error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error'
    });
  }
});

module.exports = router;