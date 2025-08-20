/**
 * Desktop Commander Analytics Tracking
 * Comprehensive event tracking for user interactions
 * Dual-tracking to Google Analytics and PostHog
 */

// Analytics tracking utilities
window.DesktopCommanderAnalytics = {
    // Track button clicks with category, action, and label
    trackEvent: function(category, action, label, value) {
        // Google Analytics tracking (existing)
        if (typeof gtag !== 'undefined') {
            gtag('event', action, {
                'event_category': category,
                'event_label': label,
                'value': value || 1
            });
            console.log('📊 GA Event:', category, action, label);
        }
        
        // PostHog tracking (new)
        if (typeof posthog !== 'undefined') {
            posthog.capture(action, {
                category: category,
                label: label,
                value: value || 1,
                // Additional context
                page_url: window.location.href,
                page_title: document.title
            });
            console.log('📈 PostHog Event:', action, { category, label });
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
    },

    // PostHog-specific tracking for advanced analytics
    trackPostHogEvent: function(eventName, properties) {
        if (typeof posthog !== 'undefined') {
            const enhancedProperties = {
                ...properties,
                page_url: window.location.href,
                page_title: document.title,
                timestamp: new Date().toISOString(),
                session_duration: window.DCPostHogSession ? 
                    Math.round((Date.now() - window.DCPostHogSession.session_start) / 1000) : 0,
                // Add device info
                ...window.DCAnalytics.getDeviceInfo(),
                // Add UTM parameters if available
                ...window.DCAnalytics.getUTMParams()
            };
            
            posthog.capture(eventName, enhancedProperties);
            console.log('📈 PostHog Custom Event:', eventName, enhancedProperties);
        }
    },

    // Track user engagement milestones
    trackEngagement: function(milestone, details) {
        this.trackPostHogEvent('user_engagement', {
            milestone: milestone,
            details: details,
            scroll_depth: Math.round((window.pageYOffset / (document.body.scrollHeight - window.innerHeight)) * 100),
            time_on_page: Math.round((Date.now() - window.pageLoadTime) / 1000)
        });
    },

    // Enhanced installation funnel tracking with user journey
    trackInstallationFunnel: function(step, method, success, additionalData) {
        const funnelData = {
            step: step,
            method: method,
            success: success,
            funnel_stage: `${step}_${method}`,
            step_number: this.getFunnelStepNumber(step),
            user_journey: this.getUserJourney(),
            ...additionalData
        };
        
        this.trackPostHogEvent('installation_funnel', funnelData);
        
        // Store funnel progress in session storage for journey tracking
        this.updateUserJourney(step, method, success);
    },

    // Track conversion goals
    trackConversion: function(goalType, value, context) {
        this.trackPostHogEvent('conversion', {
            goal_type: goalType,
            goal_value: value,
            context: context,
            conversion_path: this.getUserJourney(),
            time_to_conversion: window.DCPostHogSession ? 
                Math.round((Date.now() - window.DCPostHogSession.session_start) / 1000) : 0
        });
    },

    // Helper functions for funnel tracking
    getFunnelStepNumber: function(step) {
        const stepMap = {
            'page_view': 1,
            'section_scroll': 2,
            'installation_view': 3,
            'method_selected': 4,
            'command_copied': 5,
            'outbound_click': 6
        };
        return stepMap[step] || 0;
    },

    getUserJourney: function() {
        try {
            return JSON.parse(sessionStorage.getItem('dc_user_journey') || '[]');
        } catch (e) {
            return [];
        }
    },

    updateUserJourney: function(step, method, success) {
        try {
            let journey = this.getUserJourney();
            journey.push({
                step: step,
                method: method,
                success: success,
                timestamp: Date.now(),
                url: window.location.href
            });
            
            // Keep only last 20 steps to avoid storage bloat
            if (journey.length > 20) {
                journey = journey.slice(-20);
            }
            
            sessionStorage.setItem('dc_user_journey', JSON.stringify(journey));
        } catch (e) {
            console.warn('Could not update user journey:', e);
        }
    },

    // Track feature flag experiments
    trackFeatureFlag: function(flagName, variant, context) {
        this.trackPostHogEvent('feature_flag_exposure', {
            flag_name: flagName,
            variant: variant,
            context: context
        });
    },

    // Track performance metrics
    trackPerformance: function(metric, value, context) {
        this.trackPostHogEvent('performance_metric', {
            metric_name: metric,
            metric_value: value,
            context: context,
            page_load_time: window.performance ? 
                Math.round(window.performance.timing.loadEventEnd - window.performance.timing.navigationStart) : null
        });
    }
};

// Initialize tracking when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    // Record page load time for engagement tracking
    window.pageLoadTime = Date.now();
    
    console.log('🎯 Desktop Commander Analytics Tracking initialized');
    
    // Track initial page view with enhanced PostHog data
    if (typeof posthog !== 'undefined') {
        const utmParams = window.DCAnalytics.getUTMParams();
        const deviceInfo = window.DCAnalytics.getDeviceInfo();
        
        posthog.capture('page_view', {
            page_url: window.location.href,
            page_title: document.title,
            referrer: document.referrer,
            ...deviceInfo,
            ...utmParams,
            // Track if this is a campaign visit
            is_campaign_visit: !!(utmParams.utm_source || utmParams.utm_medium || utmParams.utm_campaign),
            // Track entry point
            entry_point: window.location.hash ? window.location.hash.substring(1) : 'top'
        });
        
        // Track Docker Gateway campaign specifically
        if (utmParams.utm_source === 'docker_gateway' && 
            utmParams.utm_medium === 'in_app_message' && 
            utmParams.utm_campaign === 'docker_to_native') {
            DesktopCommanderAnalytics.trackConversion('docker_gateway_visit', 1, 'campaign_landing');
        }
        
        // Initialize user journey tracking
        DesktopCommanderAnalytics.updateUserJourney('page_view', 'initial', true);
    }
    
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
    
    // Track scroll milestones
    initializeScrollTracking();
    
    // Track performance metrics
    initializePerformanceTracking();
    
    // Set up feature flag testing
    initializeFeatureFlags();
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
            
            // Track as conversion if it's a high-value action
            if (buttonType === 'consultation' || buttonType === 'install') {
                DesktopCommanderAnalytics.trackConversion(`${buttonType}_click`, 1, location);
                DesktopCommanderAnalytics.trackInstallationFunnel('cta_click', buttonType, true, { location: location });
            }
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
            // Track funnel step
            DesktopCommanderAnalytics.trackInstallationFunnel('method_selected', method, true);
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
                    // Track as funnel step - successful command copy
                    DesktopCommanderAnalytics.trackInstallationFunnel('command_copied', method, true);
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
                        // Track as funnel step - successful command copy
                        DesktopCommanderAnalytics.trackInstallationFunnel('command_copied', method, true);
                        
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
            
            // Track installation section views as funnel step
            if (section === 'installation') {
                DesktopCommanderAnalytics.trackInstallationFunnel('installation_view', 'navigation_click', true);
            }
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

// Track scroll depth milestones for engagement
function initializeScrollTracking() {
    let scrollMilestones = [25, 50, 75, 90, 100];
    let trackedMilestones = new Set();
    
    function trackScrollDepth() {
        const scrollPercent = Math.round((window.pageYOffset / (document.body.scrollHeight - window.innerHeight)) * 100);
        
        scrollMilestones.forEach(function(milestone) {
            if (scrollPercent >= milestone && !trackedMilestones.has(milestone)) {
                trackedMilestones.add(milestone);
                DesktopCommanderAnalytics.trackEngagement('scroll_depth', `${milestone}%`);
                
                // Track section-specific scrolling
                if (milestone === 50) {
                    DesktopCommanderAnalytics.trackInstallationFunnel('section_scroll', 'middle_page', true);
                } else if (milestone === 90) {
                    DesktopCommanderAnalytics.trackInstallationFunnel('section_scroll', 'bottom_page', true);
                }
            }
        });
    }
    
    // Throttled scroll listener
    let scrollTimeout;
    window.addEventListener('scroll', function() {
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(trackScrollDepth, 100);
    });
}

// Track performance metrics
function initializePerformanceTracking() {
    // Track page load performance
    window.addEventListener('load', function() {
        setTimeout(function() {
            if (window.performance && window.performance.timing) {
                const timing = window.performance.timing;
                const loadTime = timing.loadEventEnd - timing.navigationStart;
                const domReady = timing.domContentLoadedEventEnd - timing.navigationStart;
                const firstByte = timing.responseStart - timing.navigationStart;
                
                DesktopCommanderAnalytics.trackPerformance('page_load_time', loadTime, 'full_page');
                DesktopCommanderAnalytics.trackPerformance('dom_ready_time', domReady, 'dom_parsing');
                DesktopCommanderAnalytics.trackPerformance('first_byte_time', firstByte, 'server_response');
                
                // Track slow loading pages
                if (loadTime > 5000) {
                    DesktopCommanderAnalytics.trackPostHogEvent('slow_page_load', {
                        load_time: loadTime,
                        connection_type: navigator.connection ? navigator.connection.effectiveType : 'unknown'
                    });
                }
            }
        }, 1000); // Wait 1 second after load to ensure timing is complete
    });
    
    // Track Core Web Vitals if available
    if ('PerformanceObserver' in window) {
        try {
            // Largest Contentful Paint
            const lcpObserver = new PerformanceObserver(function(list) {
                const entries = list.getEntries();
                const lastEntry = entries[entries.length - 1];
                DesktopCommanderAnalytics.trackPerformance('lcp', Math.round(lastEntry.startTime), 'core_web_vital');
            });
            lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
            
            // First Input Delay
            const fidObserver = new PerformanceObserver(function(list) {
                const entries = list.getEntries();
                entries.forEach(function(entry) {
                    DesktopCommanderAnalytics.trackPerformance('fid', Math.round(entry.processingStart - entry.startTime), 'core_web_vital');
                });
            });
            fidObserver.observe({ entryTypes: ['first-input'] });
        } catch (e) {
            console.log('Performance Observer not fully supported');
        }
    }
}

// Set up feature flag testing
function initializeFeatureFlags() {
    if (typeof posthog !== 'undefined') {
        // Example feature flags - you can customize these
        const installButtonVariant = posthog.getFeatureFlag('install_button_style');
        const heroTextVariant = posthog.getFeatureFlag('hero_text_variant');
        
        // Apply feature flag variants
        if (installButtonVariant) {
            DesktopCommanderAnalytics.trackFeatureFlag('install_button_style', installButtonVariant, 'hero_section');
            // You can add code here to modify the button style based on the variant
        }
        
        if (heroTextVariant) {
            DesktopCommanderAnalytics.trackFeatureFlag('hero_text_variant', heroTextVariant, 'hero_section');
            // You can add code here to modify the hero text based on the variant
        }
        
        // Track time spent evaluating feature flags
        DesktopCommanderAnalytics.trackPerformance('feature_flags_loaded', Date.now() - window.pageLoadTime, 'initialization');
    }
}
