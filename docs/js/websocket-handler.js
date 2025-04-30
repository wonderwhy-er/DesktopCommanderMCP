// Handle WebSocket connections properly for back/forward cache compatibility
document.addEventListener('DOMContentLoaded', function() {
  // Store any WebSocket connections created
  window.activeWebSockets = [];
  
  // Override WebSocket constructor to track connections
  const originalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols ? new originalWebSocket(url, protocols) : new originalWebSocket(url);
    window.activeWebSockets.push(ws);
    
    // Remove from tracking when closed
    ws.addEventListener('close', function() {
      const index = window.activeWebSockets.indexOf(ws);
      if (index > -1) {
        window.activeWebSockets.splice(index, 1);
      }
    });
    
    return ws;
  };
  
  // Close all WebSockets when page is hidden (including when navigating away)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      window.activeWebSockets.forEach(function(ws) {
        try {
          ws.close();
        } catch (e) {
          console.error('Error closing WebSocket:', e);
        }
      });
      window.activeWebSockets = [];
    }
  });
  
  // Also handle page unload explicitly
  window.addEventListener('pagehide', function() {
    window.activeWebSockets.forEach(function(ws) {
      try {
        ws.close();
      } catch (e) {
        console.error('Error closing WebSocket:', e);
      }
    });
    window.activeWebSockets = [];
  });
});
