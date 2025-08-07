/**
 * Desktop Commander Analytics Tracking
 * Comprehensive event tracking for user interactions
 */

// Analytics tracking utilities
window.DesktopCommanderAnalytics = {
    // Track button clicks with category, action, and label
    trackEvent: function(category, action, label, value) {
        if (typeof gtag !== 'undefined') {
            gtag('event', action, {
                'event_category': category,
                'event_label': label,
                'value': value || 1
            });
            console.log('📊 Analytics Event:', category, action, label);
        }
    },

    // Track CTA button clicks
    trackCTAClick: function(buttonType, location) {
        this.trackEvent('CTA_Buttons', 'click', `${buttonType}_${location}`);
    },

    // Track installation method selection
    trackInstallMethod: function(method) {
        this.trackEvent('Installation', 'method_selected', method);
    },

    // Track copy-to-clipboard events
    trackCopyCommand: function(command, method) {
        this.trackEvent('Installation', 'command_copied', `${method}_${command.substring(0, 20)}`);
    },

    // Track navigation clicks
    trackNavigation: function(section) {
        this.trackEvent('Navigation', 'section_click', section);
    },

    // Track outbound link clicks
    trackOutboundClick: function(destination, context) {
        this.trackEvent('Outbound_Links', 'click', `${destination}_${context}`);
    }
};

// Initialize tracking when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('🎯 Desktop Commander Analytics Tracking initialized');
    
    // Track all CTA button clicks
    initializeCTATracking();
    
    // Track installation method selection
    initializeInstallationTracking();
    
    // Track copy-to-clipboard events (with delay to wait for main.js to create buttons)
    setTimeout(function() {
        initializeCopyTracking();
    }, 500); // Wait 500ms for main.js to create copy buttons
    
    // Track navigation clicks
    initializeNavigationTracking();
    
    // Track outbound links
    initializeOutboundTracking();
});

// Track CTA button clicks
function initializeCTATracking() {
    // Track buttons with data-track attributes (more precise tracking)
    document.querySelectorAll('[data-track]').forEach(function(button) {
        button.addEventListener('click', function() {
            const trackingData = this.getAttribute('data-track').split('-');
            const buttonType = trackingData[0];
            const location = trackingData[1] || 'unknown';
            DesktopCommanderAnalytics.trackCTAClick(buttonType, location);
        });
    });

    // Fallback: Track consultation buttons without data-track
    document.querySelectorAll('a[href*="go.desktopcommander.app/free-call"]:not([data-track]), .consultation-btn:not([data-track]), .header-consultation-btn:not([data-track])').forEach(function(button) {
        button.addEventListener('click', function() {
            const location = button.closest('header') ? 'header' : 
                           button.closest('.hero') ? 'hero' : 'other';
            DesktopCommanderAnalytics.trackCTAClick('consultation', location);
        });
    });

    // Fallback: Track install buttons without data-track
    document.querySelectorAll('a[href="#installation"]:not([data-track])').forEach(function(button) {
        if (button.textContent.toLowerCase().includes('install')) {
            button.addEventListener('click', function() {
                const location = button.closest('.hero') ? 'hero' : 
                               button.closest('.trusted-by-developers-section') ? 'trusted_section' : 'other';
                DesktopCommanderAnalytics.trackCTAClick('install', location);
            });
        }
    });

    // Fallback: Track Discord buttons without data-track
    document.querySelectorAll('a[href*="discord.gg"]:not([data-track]), .discord-btn:not([data-track])').forEach(function(button) {
        button.addEventListener('click', function() {
            const location = button.closest('.hero') ? 'hero' : 
                           button.closest('.community') ? 'community' : 'other';
            DesktopCommanderAnalytics.trackCTAClick('discord', location);
        });
    });

    // GitHub buttons
    document.querySelectorAll('a[href*="github.com/wonderwhy-er/DesktopCommanderMCP"]').forEach(function(button) {
        button.addEventListener('click', function() {
            const location = button.closest('.community') ? 'community' : 
                           button.closest('header') ? 'header' : 'other';
            DesktopCommanderAnalytics.trackCTAClick('github', location);
        });
    });
}

// Track installation method selection
function initializeInstallationTracking() {
    document.querySelectorAll('.tab-btn').forEach(function(tabButton) {
        tabButton.addEventListener('click', function() {
            const method = this.textContent.trim();
            DesktopCommanderAnalytics.trackInstallMethod(method);
        });
    });
}

// Track copy-to-clipboard events
function initializeCopyTracking() {
    // Use existing copy buttons (created by main.js) instead of creating new ones
    document.querySelectorAll('#installation .copy-button').forEach(function(copyButton) {
        copyButton.addEventListener('click', function() {
            // Find the associated pre element
            const container = copyButton.closest('.pre-container');
            if (container) {
                const preElement = container.querySelector('pre');
                if (preElement) {
                    const command = preElement.textContent.trim();
                    const method = preElement.closest('.tab-content').id || 'unknown';
                    
                    // Track the copy event
                    DesktopCommanderAnalytics.trackCopyCommand(command, method);
                }
            }
        });
    });
    
    // If no existing copy buttons found, create them (fallback)
    if (document.querySelectorAll('#installation .copy-button').length === 0) {
        document.querySelectorAll('#installation pre').forEach(function(preElement) {
            // Only proceed if there's no existing copy button
            if (!preElement.closest('.pre-container')) {
                const copyButton = document.createElement('button');
                copyButton.className = 'copy-button';
                copyButton.innerHTML = '📋 Copy';
                copyButton.setAttribute('aria-label', 'Copy command to clipboard');
                
                // Wrap pre in container for positioning
                const container = document.createElement('div');
                container.className = 'pre-container';
                preElement.parentNode.insertBefore(container, preElement);
                container.appendChild(preElement);
                container.appendChild(copyButton);
                
                copyButton.addEventListener('click', function() {
                    const command = preElement.textContent.trim();
                    const method = preElement.closest('.tab-content').id || 'unknown';
                    
                    navigator.clipboard.writeText(command).then(function() {
                        copyButton.innerHTML = '✅ Copied!';
                        copyButton.classList.add('copied');
                        
                        // Track the copy event
                        DesktopCommanderAnalytics.trackCopyCommand(command, method);
                        
                        setTimeout(function() {
                            copyButton.innerHTML = '📋 Copy';
                            copyButton.classList.remove('copied');
                        }, 2000);
                    }).catch(function(err) {
                        console.error('Failed to copy: ', err);
                        copyButton.innerHTML = '❌ Failed';
                        setTimeout(function() {
                            copyButton.innerHTML = '📋 Copy';
                        }, 2000);
                    });
                });
            }
        });
    }
}

// Track navigation section clicks
function initializeNavigationTracking() {
    document.querySelectorAll('a[href^="#"]').forEach(function(link) {
        link.addEventListener('click', function() {
            const section = this.getAttribute('href').replace('#', '');
            DesktopCommanderAnalytics.trackNavigation(section);
        });
    });
}

// Track outbound link clicks
function initializeOutboundTracking() {
    document.querySelectorAll('a[href^="http"]').forEach(function(link) {
        link.addEventListener('click', function() {
            const url = this.href;
            const destination = new URL(url).hostname;
            const context = this.closest('section') ? 
                          this.closest('section').className || this.closest('section').id : 'unknown';
            
            DesktopCommanderAnalytics.trackOutboundClick(destination, context);
        });
    });
}
