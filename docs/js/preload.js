// Preload critical resources
document.addEventListener('DOMContentLoaded', function() {
  // Load videos only when they're close to viewport
  function handleVideoPreloading() {
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      if (video.dataset.preloaded) return;
      
      const rect = video.getBoundingClientRect();
      // If video is within 300px of viewport
      if (rect.top - window.innerHeight < 300) {
        const sources = video.querySelectorAll('source');
        sources.forEach(source => {
          const dataSrc = source.getAttribute('data-src');
          if (dataSrc) {
            source.setAttribute('src', dataSrc);
          }
        });
        
        if (sources.length > 0) {
          video.load();
          video.dataset.preloaded = 'true';
        }
      }
    });
  }

  // Initial check for visible videos
  handleVideoPreloading();
  
  // Check again when scrolling
  window.addEventListener('scroll', handleVideoPreloading, { passive: true });

  // Preload images that are about to enter viewport
  function handleImagePreloading() {
    const images = document.querySelectorAll('img[loading="lazy"]');
    images.forEach(img => {
      if (img.dataset.preloaded) return;
      
      const rect = img.getBoundingClientRect();
      // If image is within 500px of viewport
      if (rect.top - window.innerHeight < 500) {
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) {
          img.src = dataSrc;
          img.dataset.preloaded = 'true';
        }
      }
    });
  }

  // Initial check for visible images
  handleImagePreloading();
  
  // Check again when scrolling
  window.addEventListener('scroll', handleImagePreloading, { passive: true });
  
  // Load non-critical JavaScript
  setTimeout(function() {
    // Load any additional scripts here
    const scriptUrls = [
      'js/main.js'
    ];
    
    scriptUrls.forEach(url => {
      const script = document.createElement('script');
      script.src = url;
      script.defer = true;
      document.body.appendChild(script);
    });
  }, 2000); // 2 second delay
});
