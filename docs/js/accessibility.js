// Accessibility improvements for accordion components
document.addEventListener('DOMContentLoaded', function() {
  // Find all accordion items and set up proper ARIA attributes
  const accordionItems = document.querySelectorAll('.accordion-item');
  
  accordionItems.forEach((item, index) => {
    const headerId = `accordion-header-${index + 1}`;
    const contentId = `accordion-content-${index + 1}`;
    
    // Get elements
    const header = item.querySelector('.accordion-header');
    const body = item.querySelector('.accordion-body');
    
    // Update attributes for header
    if (header) {
      header.setAttribute('id', headerId);
      header.setAttribute('role', 'button');
      header.setAttribute('aria-expanded', 'false');
      header.setAttribute('aria-controls', contentId);
      header.setAttribute('tabindex', '0');
      
      // Add click listener to toggle expanded state
      header.addEventListener('click', function() {
        const expanded = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', !expanded);
        
        // Toggle active class for styling
        if (body) {
          if (!expanded) {
            body.classList.add('active');
          } else {
            body.classList.remove('active');
          }
        }
      });
      
      // Add keyboard support
      header.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.click();
        }
      });
    }
    
    // Update attributes for body
    if (body) {
      body.setAttribute('id', contentId);
      body.setAttribute('role', 'region');
      body.setAttribute('aria-labelledby', headerId);
    }
  });
  
  // Add rel="noopener noreferrer" to all external links
  const externalLinks = document.querySelectorAll('a[target="_blank"]');
  externalLinks.forEach(link => {
    if (!link.getAttribute('rel') || !link.getAttribute('rel').includes('noopener')) {
      const currentRel = link.getAttribute('rel') || '';
      const newRel = currentRel ? `${currentRel} noopener noreferrer` : 'noopener noreferrer';
      link.setAttribute('rel', newRel);
    }
  });
});
