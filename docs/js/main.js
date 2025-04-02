// Function to load CSS files asynchronously
function loadCSS(url) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
}

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
        'css/hero.css',
        'css/community.css',
        'css/usage.css',
        'css/header.css',
        'css/base.css'
    ];
    
    // Load each CSS file
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

// Carousel functionality
document.addEventListener('DOMContentLoaded', function() {
    const slides = document.querySelectorAll('.carousel-slide');
    const indicators = document.querySelectorAll('.indicator');
    const prevBtn = document.getElementById('prevSlide');
    const nextBtn = document.getElementById('nextSlide');
    let currentSlide = 0;
    
    // Function to show a specific slide
    function showSlide(n) {
        // Hide all slides
        slides.forEach(slide => {
            slide.classList.remove('active');
        });
        
        // Remove active class from all indicators
        indicators.forEach(indicator => {
            indicator.classList.remove('active');
        });
        
        // Show the selected slide and indicator
        slides[n].classList.add('active');
        indicators[n].classList.add('active');
        currentSlide = n;
    }
    
    // Next slide
    function nextSlide() {
        const next = (currentSlide + 1) % slides.length;
        showSlide(next);
    }
    
    // Previous slide
    function prevSlide() {
        const prev = (currentSlide - 1 + slides.length) % slides.length;
        showSlide(prev);
    }
    
    // Event listeners
    prevBtn.addEventListener('click', prevSlide);
    nextBtn.addEventListener('click', nextSlide);
    
    // Click on indicators
    indicators.forEach((indicator, index) => {
        indicator.addEventListener('click', () => {
            showSlide(index);
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
    
    // Mobile menu toggle
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const nav = document.querySelector('nav');
    
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', function() {
            nav.classList.toggle('active');
            this.classList.toggle('active');
        });
    }
    
    // Auto-rotate carousel every 5 seconds
    setInterval(nextSlide, 5000);
});
