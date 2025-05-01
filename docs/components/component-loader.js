// component-loader.js - Dynamically loads all components

document.addEventListener('DOMContentLoaded', function() {
  // Load all component scripts
  const components = [
    'sponsors-section.js',
    'sponsor-footer.js',
  ];
  
  // Create script tags to load all components
  components.forEach(component => {
    const script = document.createElement('script');
    script.src = `components/${component}`;
    script.async = true;
    script.onerror = () => console.error(`Failed to load component: ${component}`);
    document.head.appendChild(script);
  });
  
  // Function to check if all components are loaded and then add them to the DOM
  const MAX_ATTEMPTS = 50; // 5 seconds maximum wait time
  let attempts = 0;
  const checkComponentsLoaded = () => {
    // Check if all custom elements are defined
    const allDefined = [
      'sponsors-section',
      'sponsor-footer',
    ].every(component => customElements.get(component));
    
    if (allDefined) {
      // All components are loaded, now we can insert them in the DOM
      
      // 1. Add sponsors section after Trusted by Developers section
      const trustedBySection = document.querySelector('.trusted-by-developers-section');
      if (trustedBySection) {
        const sponsorsSection = document.createElement('sponsors-section');
        trustedBySection.after(sponsorsSection);
      }
      
      // 2. Add sponsor footer to the footer content
      const footerContent = document.querySelector('.footer-content');
      if (footerContent) {
        const sponsorFooter = document.createElement('sponsor-footer');
        footerContent.appendChild(sponsorFooter);
      }
      
    } else if (attempts >= MAX_ATTEMPTS) {
      console.error('Desktop Commander: Failed to load all sponsorship components within timeout period');
    } else {
      // Not all components are loaded yet, check again in a moment
      attempts++;
      setTimeout(checkComponentsLoaded, 100);
    }
  };
  
  // Start checking if components are loaded
  setTimeout(checkComponentsLoaded, 300);
});
