// Function to load CSS files asynchronously
function loadCSS(url) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
}

// Load critical CSS files immediately (synchronously)
(function() {
    // Critical CSS files - needed for above-the-fold content
    var criticalCSSFiles = [
        'css/base.css',
        'css/header.css',
        'css/hero.css'
    ];
    
    // Load critical CSS files immediately
    criticalCSSFiles.forEach(function(url) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        // Using insertBefore to add them before scripts to ensure they load faster
        document.head.insertBefore(link, document.head.firstChild);
    });
})();

// Load non-critical CSS files asynchronously after page load
window.addEventListener('load', function() {
    // List of non-critical CSS files
    var cssFiles = [
        'css/responsive.css',
        'css/installation.css',
        'css/media.css',
        'css/footer.css',
        'css/faq.css',
        'css/testimonials.css',
        'css/features.css',
        'css/community.css',
        'css/usage.css'
    ];
    
    // Load each CSS file asynchronously
    cssFiles.forEach(function(url) {
        loadCSS(url);
    });
});

// Tab switching functionality
function openTab(evt, tabName) {
    var i, tabContent, tabBtn;
    
    // Hide all tab content
    tabContent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabContent.length; i++) {
        tabContent[i].classList.remove("active");
    }
    
    // Remove active class from all tab buttons
    tabBtn = document.getElementsByClassName("tab-btn");
    for (i = 0; i < tabBtn.length; i++) {
        tabBtn[i].classList.remove("active");
    }
    
    // Show the selected tab and add an active class to the button
    document.getElementById(tabName).classList.add("active");
    evt.currentTarget.classList.add("active");
}

// Make the openTab function available globally
window.openTab = openTab;

// Initialize any elements that require it
document.addEventListener('DOMContentLoaded', function() {
    // Initialize first FAQ item as open if it exists
    const firstAccordionItem = document.querySelector('.accordion-item');
    if (firstAccordionItem) {
        firstAccordionItem.classList.add('active');
    }
    
    // Mobile menu toggle
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const mobileNav = document.querySelector('.mobile-nav');
    
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', function() {
            mobileNav.classList.toggle('active');
            this.classList.toggle('active');
        });
    }
    
    // Dropdown toggle for both mobile and desktop
    const dropdownToggles = document.querySelectorAll('.dropdown-toggle');
    
    dropdownToggles.forEach(toggle => {
        toggle.addEventListener('click', function(e) {
            // Only prevent default for mobile view
            if (window.innerWidth <= 768) {
                e.preventDefault();
                const parentDropdown = this.parentElement;
                
                // Close other open dropdowns
                document.querySelectorAll('.dropdown').forEach(dropdown => {
                    if (dropdown !== parentDropdown) {
                        dropdown.classList.remove('active');
                    }
                });
                
                // Toggle current dropdown
                parentDropdown.classList.toggle('active');
            } else {
                // For desktop, still prevent default but don't toggle active class
                // (hover will handle this instead)
                e.preventDefault();
            }
        });
    });
    
    // Accordion functionality
    const accordionHeaders = document.querySelectorAll('.accordion-header');
    
    accordionHeaders.forEach(header => {
        header.addEventListener('click', function() {
            const accordionItem = this.parentElement;
            const accordionBody = this.nextElementSibling;
            
            accordionItem.classList.toggle('active');
            
            // Toggle height 
            if (accordionItem.classList.contains('active')) {
                accordionBody.style.maxHeight = accordionBody.scrollHeight + 'px';
            } else {
                accordionBody.style.maxHeight = '0';
            }
        });
    });
    
    // Initialize testimonial carousel
    initTestimonialCarousel();
});

// Testimonial Carousel Implementation
function initTestimonialCarousel() {
    const carousel = document.querySelector('.testimonial-carousel');
    if (!carousel) return;
    
    const slides = document.querySelectorAll('.carousel-slide');
    const prevBtn = document.getElementById('prevSlide');
    const nextBtn = document.getElementById('nextSlide');
    const indicators = document.querySelectorAll('.indicator');
    
    if (!slides.length || !prevBtn || !nextBtn) return;
    
    let currentSlide = 0;
    const totalSlides = slides.length;
    
    // Preload all images to get their dimensions and reduce jumping
    function preloadImages() {
        const allImages = [];
        let maxHeight = 0;
        let loadedCount = 0;
        
        slides.forEach(slide => {
            const img = slide.querySelector('img');
            if (!img) return;
            
            // Check if already loaded or load it
            if (img.complete) {
                const height = img.offsetHeight;
                maxHeight = Math.max(maxHeight, height);
                loadedCount++;
                
                // If all images loaded, set the container height
                if (loadedCount === slides.length) {
                    setInitialContainerHeight(maxHeight);
                }
            } else {
                img.addEventListener('load', () => {
                    const height = img.offsetHeight;
                    maxHeight = Math.max(maxHeight, height);
                    loadedCount++;
                    
                    // If all images loaded, set the container height
                    if (loadedCount === slides.length) {
                        setInitialContainerHeight(maxHeight);
                    }
                });
            }
            
            allImages.push(img);
        });
        
        // If no images or all already loaded, set container height
        if (allImages.length === 0 || loadedCount === slides.length) {
            setInitialContainerHeight(maxHeight);
        }
    }
    
    // Set initial container height to the tallest slide
    function setInitialContainerHeight(height) {
        // Set a reasonable fixed height instead of calculating it dynamically
        // This prevents layout jumps while images are still loading
        const fixedHeight = 750; // Fixed height to prevent jumps
        const slidesContainer = document.querySelector('.carousel-slides');
        slidesContainer.style.height = fixedHeight + 'px';
        
        // Now we can start properly transitioning between slides
        slidesContainer.classList.add('height-initialized');
    }
    
    // Update height when changing slides (smoother than initial setup)
    function updateCarouselHeight() {
        const activeSlide = document.querySelector('.carousel-slide.active');
        if (!activeSlide) return;
        
        const img = activeSlide.querySelector('img');
        if (!img || !img.complete) return;
        
        // Add a small padding to avoid cutting off bottom of image
        const height = img.offsetHeight + 20;
        const slidesContainer = document.querySelector('.carousel-slides');
        
        // Only update if necessary and if significant difference
        const currentHeight = parseInt(slidesContainer.style.height);
        if (Math.abs(currentHeight - height) > 10) {
            slidesContainer.style.height = height + 'px';
        }
    }
    
    // Show a specific slide
    function showSlide(index) {
        if (index < 0) index = totalSlides - 1;
        if (index >= totalSlides) index = 0;
        
        // Update slides
        slides.forEach((slide, i) => {
            slide.classList.toggle('active', i === index);
        });
        
        // Update indicators
        indicators.forEach((indicator, i) => {
            indicator.classList.toggle('active', i === index);
            // Update aria-current attribute for accessibility
            if (i === index) {
                indicator.setAttribute('aria-current', 'true');
            } else {
                indicator.removeAttribute('aria-current');
            }
        });
        
        currentSlide = index;
        updateCarouselHeight();
    }
    
    // Event listeners for navigation
    prevBtn.addEventListener('click', () => {
        showSlide(currentSlide - 1);
    });
    
    nextBtn.addEventListener('click', () => {
        showSlide(currentSlide + 1);
    });
    
    // Indicator clicks
    indicators.forEach((indicator, index) => {
        indicator.addEventListener('click', () => {
            showSlide(index);
        });
    });
    
    // Preload images to reduce jumping
    preloadImages();
    
    // Initialize with the first slide
    showSlide(0);
    
    // Handle window resize
    window.addEventListener('resize', updateCarouselHeight);
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            showSlide(currentSlide - 1);
        } else if (e.key === 'ArrowRight') {
            showSlide(currentSlide + 1);
        }
    });
    
    // Touch swipe support for mobile
    let touchStartX = 0;
    let touchEndX = 0;
    
    const handleSwipe = () => {
        const diff = touchStartX - touchEndX;
        if (Math.abs(diff) > 50) { // Threshold to detect a swipe
            if (diff > 0) {
                // Swipe left, show next slide
                showSlide(currentSlide + 1);
            } else {
                // Swipe right, show previous slide
                showSlide(currentSlide - 1);
            }
        }
    };
    
    carousel.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });
    
    carousel.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    });
}

// Smooth Scrolling
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            // Extra offset for section IDs that are inside the cases section
            const isSubsection = this.getAttribute('href').startsWith('#cases-');
            const offset = isSubsection ? 120 : 80;
            
            window.scrollTo({
                top: target.offsetTop - offset,
                behavior: 'smooth'
            });
        }
        
        // Close mobile menu if open
        const mobileNav = document.querySelector('.mobile-nav');
        if (mobileNav && mobileNav.classList.contains('active')) {
            mobileNav.classList.remove('active');
        }
        
        // Close any open dropdowns
        document.querySelectorAll('.dropdown').forEach(dropdown => {
            dropdown.classList.remove('active');
        });
    });
});

// Sticky Header
window.addEventListener('scroll', () => {
    const header = document.querySelector('header');
    if (header) {
        header.classList.toggle('sticky', window.scrollY > 0);
    }
});

// Add copy button only to pre elements under installation section
function addCopyButtons() {
    const preElements = document.querySelectorAll('#installation pre');
    
    preElements.forEach(pre => {
        // Create container to hold the pre and button
        const container = document.createElement('div');
        container.className = 'pre-container';
        pre.parentNode.insertBefore(container, pre);
        container.appendChild(pre);
        
        // Create the copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-copy"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyButton.title = 'Copy to clipboard';
        copyButton.setAttribute('aria-label', 'Copy to clipboard');
        container.appendChild(copyButton);
        
        // Add click event to the button
        copyButton.addEventListener('click', () => {
            const text = pre.textContent;
            
            // Create a temporary textarea element to use for copying
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            
            // Handle iOS devices
            if (navigator.userAgent.match(/ipad|ipod|iphone/i)) {
                const range = document.createRange();
                range.selectNodeContents(textarea);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                textarea.setSelectionRange(0, 999999);
            } else {
                textarea.select();
            }
            
            try {
                const successful = document.execCommand('copy');
                const msg = successful ? 'Copied!' : 'Failed to copy';
                
                // Visual feedback
                copyButton.classList.add('copied');
                copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-check"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                
                // Revert back after 2 seconds
                setTimeout(() => {
                    copyButton.classList.remove('copied');
                    copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-copy"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                }, 2000);
                
            } catch (err) {
                console.error('Could not copy text: ', err);
            }
            
            document.body.removeChild(textarea);
        });
    });
}

// Initialize copy buttons when the DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    addCopyButtons();
});
